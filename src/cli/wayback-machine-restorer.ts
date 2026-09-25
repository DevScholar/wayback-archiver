#!/usr/bin/env node
/**
 * wayback-machine-restorer.ts
 *
 * Re-fetches a WACZ that captured the *Wayback Machine replaying* old pages as
 * a set of pure, byte-for-byte originals.
 *
 * When a crawler walks `https://web.archive.org/web/<ts>/http://host/...` it
 * archives the replayed page wrapped in Wayback's own chrome (top toolbar,
 * donation banner, `wombat.js`, ...), with every URL rewritten to a
 * `/web/<ts>[mod_]/<url>` route. That replayed copy is *lossy*: wombat.js
 * reserializes the DOM (tag case and quoting normalize, CRLF becomes LF,
 * relative URLs become absolute), so the era's original bytes can never be
 * recovered from it afterward.
 *
 * This tool therefore does not try to un-rewrite the replayed bytes. Instead it
 * reads the *list* of Wayback replay URLs the input WACZ captured, and for each
 * one fetches a fresh copy of its `id_` identity route -- the route that serves
 * the archived bytes exactly as captured, with no rewriting and no chrome. The
 * result is a WACZ that looks as if the pages were captured directly, in the
 * past:
 *
 *   - each `/web/<ts>[mod_]/<url>` is fetched as `/web/<ts>id_/<url>` and stored
 *     under the inner `<url>`;
 *   - headers are rebuilt from the historical `X-Archive-Orig-*` values (so a
 *     modern replay artifact never leaks in);
 *   - each record is stamped with its *historical* capture time, not the wall
 *     clock.
 *
 * A resource that cannot be re-fetched is skipped: a network error writes
 * nothing, and a rate limit (429) is retried on a separate slow queue a bounded
 * number of times before also being skipped -- matching how the downloader
 * treats a failed capture.
 *
 * The output is incremental: if `--output-file` already exists, its URLs are
 * skipped and only newly-restored URLs are appended, so re-running the same
 * command resumes where a previous run left off.
 *
 * Fetches use a normal browser `User-Agent` (see downloader.ts) so Wayback does
 * not serve a bot response. The normal pool runs at `--concurrency` in
 * parallel; any URL that answers 429 is set aside on a rate-limit list and
 * drained one at a time at `--rate-limit-delay` with backoff.
 *
 * Usage:
 *   npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { ZipReader } from '../archive/zip.js';
import { writeZipFile } from '../archive/zip-writer.js';
import { buildWarcRecord, payloadDigest } from '../archive/warc-writer.js';
import { parseWarcRecord, WarcRecord } from '../archive/warc.js';
import { parseCdxj } from '../archive/cdxj.js';
import { surtKey } from '../lib/url.js';
import { cdxjTsToRfc3339 } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
    input: string;
    outputFile: string;
    title?: string;
    concurrency: number;
    userAgent?: string;
    accept?: string;
    acceptLanguage?: string;
    /** Delay (ms) between slow-queue requests, and the backoff unit for a 429. */
    rateLimitDelay: number;
    /** Extra attempts beyond the first for a URL that keeps answering 429. */
    max429Retries: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { input: '', outputFile: '', concurrency: 8, rateLimitDelay: 3000, max429Retries: 3 };
    const positional: string[] = [];
    for (const a of argv) {
        const eq = a.indexOf('=');
        const key = eq >= 0 ? a.slice(0, eq) : a;
        const val = eq >= 0 ? a.slice(eq + 1) : '';
        if (key === '--output-file') args.outputFile = val;
        else if (key === '--title') args.title = val;
        else if (key === '--concurrency') args.concurrency = parseInt(val, 10) || 8;
        else if (key === '--user-agent') args.userAgent = val;
        else if (key === '--accept') args.accept = val;
        else if (key === '--accept-language') args.acceptLanguage = val;
        else if (key === '--rate-limit-delay') args.rateLimitDelay = parseInt(val, 10) || 3000;
        else if (key === '--max-429-retries') args.max429Retries = parseInt(val, 10) || 3;
        else if (!a.startsWith('--')) positional.push(a);
    }
    if (positional.length > 0) args.input = path.resolve(positional[0]);
    if (!args.input) {
        console.error('Usage: npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3]');
        process.exit(1);
    }
    if (!args.outputFile) {
        const base = path.basename(args.input).replace(/\.wacz$/i, '');
        args.outputFile = path.join(path.dirname(args.input), base + '-restored.wacz');
    }
    return args;
}

// ---------------------------------------------------------------------------
// Wayback URL classification
// ---------------------------------------------------------------------------

/** A parsed Wayback replay URL: `https://web.archive.org/web/<ts>[mod_]/<url>`. */
interface WaybackTarget {
    /** 14-digit capture timestamp from the URL path. */
    ts14: string;
    /** The replay modifier (`im_`, `cs_`, `js_`, `id_`) or '' for a page. */
    modifier: string;
    /** The inner, original URL the capture is of (percent-decoded). */
    innerUrl: string;
    /** The `id_` replay URL that serves the capture's original bytes verbatim. */
    idUrl: string;
}

const WAYBACK_URL_RE = /^https:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i;

/**
 * Parse a Wayback replay URL into its capture timestamp, modifier, and inner
 * URL, and rewrite it to the `id_` form that serves the original bytes with no
 * link rewriting and no chrome. Returns null when `url` is not a Wayback replay
 * URL.
 */
function parseWaybackUrl(url: string): WaybackTarget | null {
    const m = WAYBACK_URL_RE.exec(url);
    if (!m) return null;
    const ts14 = m[1].slice(0, 14);
    let innerUrl: string;
    try {
        innerUrl = decodeURIComponent(m[3]);
    } catch {
        innerUrl = m[3];
    }
    // The scheme separator is sometimes percent-encoded (`http%3A//`).
    innerUrl = innerUrl.replace(/%3a/gi, ':');
    return {
        ts14,
        modifier: (m[2] || '').toLowerCase(),
        innerUrl,
        idUrl: `https://web.archive.org/web/${ts14}id_/${innerUrl}`,
    };
}

const URN_SCREENSHOT_RE = /^urn:(thumbnail|view):/i;

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function isArchiveOrgHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return h === 'archive.org' || h.endsWith('.archive.org');
}

// ---------------------------------------------------------------------------
// Header restoration
// ---------------------------------------------------------------------------

/** Wayback replay headers that must never leak into a faithfully restored
 * record: the replay frontend's own framing and policy headers. */
const WAYBACK_DROP_HEADERS = new Set([
    'x-dns-prefetch-control', 'content-security-policy', 'permissions-policy',
    'referrer-policy', 'server-timing', 'memento-datetime', 'link',
    'x-app-server', 'x-archive-guessed-charset', 'x-archive-guessed-content-type',
    'x-archive-redirect-reason', 'x-archive-src', 'x-as', 'x-location', 'x-na',
    'x-nid', 'x-page-cache', 'x-rl', 'x-sd', 'x-tr', 'x-ts',
    'connection', 'keep-alive', 'transfer-encoding',
    'content-length', 'content-encoding',
]);

const ORIG_HEADER_PREFIX = 'x-archive-orig-';

/**
 * Rebuild an `id_` response's headers as if the era's server had answered
 * directly. Wayback folds the historical headers under `X-Archive-Orig-<Name>`
 * while serving its own modern headers on the same response; reconstruct from
 * those alone when present, otherwise keep the response's own headers minus the
 * replay framing. `content-length` is only kept when it still matches the body;
 * `content-encoding`/`transfer-encoding` are always dropped (the body is stored
 * decoded). `mime` is the fallback `content-type` when nothing declares one.
 */
function restoreWaybackHeaders(headers: [string, string][], mime: string, body: Buffer): [string, string][] {
    const result: [string, string][] = [];
    const seen = new Set<string>();
    const push = (name: string, value: string) => {
        const lower = name.toLowerCase();
        if (seen.has(lower)) return;
        seen.add(lower);
        result.push([name, value]);
    };
    const isStaleFraming = (name: string) =>
        name === 'content-encoding' || name === 'transfer-encoding';

    const hasOrig = headers.some(([n]) => n.toLowerCase().startsWith(ORIG_HEADER_PREFIX));

    if (hasOrig) {
        for (const [name, value] of headers) {
            const lower = name.toLowerCase();
            if (!lower.startsWith(ORIG_HEADER_PREFIX)) continue;
            const real = lower.slice(ORIG_HEADER_PREFIX.length);
            if (isStaleFraming(real)) continue;
            if (real === 'content-length') {
                if (Number(value) === body.length) push(real, value);
                continue;
            }
            push(real, value);
        }
    } else {
        for (const [name, value] of headers) {
            const lower = name.toLowerCase();
            if (lower.startsWith(ORIG_HEADER_PREFIX)) continue;
            if (WAYBACK_DROP_HEADERS.has(lower)) continue;
            if (isStaleFraming(lower) || lower === 'content-length') continue;
            push(name, value);
        }
    }

    if (!seen.has('content-type')) push('content-type', mime || 'application/octet-stream');
    return result;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';
const DEFAULT_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

function clientHeaders(userAgent: string, accept: string, acceptLanguage: string): http.OutgoingHttpHeaders {
    return {
        'User-Agent': userAgent,
        'Accept': accept,
        'Accept-Language': acceptLanguage,
    };
}

function collectHeaders(h: http.IncomingHttpHeaders): [string, string][] {
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined) continue;
        out.push([k, Array.isArray(v) ? v.join(', ') : v]);
    }
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface FetchedHop {
    url: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Buffer;
}

/** The outcome of one fetch attempt, before any 429 retry is applied. */
type FetchOutcome =
    | { kind: 'ok'; hops: FetchedHop[] }
    | { kind: 'rate-limited' }
    | { kind: 'error'; message: string };

/**
 * Fetch a URL, following redirects (up to 8 hops) and recording every hop, not
 * just the final response. A 3xx is kept as its own (empty-body) hop under its
 * own URL; the final 200/error is the last hop. A 429 is *not* retried here --
 * it is reported as `rate-limited` so the caller can move it onto the slow
 * queue. Bodies are decompressed transparently so the stored record carries the
 * decoded payload.
 */
function fetchOnce(url: string, userAgent: string, accept: string, acceptLanguage: string): Promise<FetchOutcome> {
    return new Promise((resolve) => {
        const hops: FetchedHop[] = [];
        const attempt = (current: string, redirects: number): void => {
            if (redirects > 8) {
                resolve({ kind: 'error', message: 'too many redirects' });
                return;
            }
            const lib = current.startsWith('https:') ? https : http;
            const req = lib.get(current, { headers: clientHeaders(userAgent, accept, acceptLanguage) }, (res) => {
                const status = res.statusCode || 0;
                const statusText = res.statusMessage || '';
                const loc = res.headers.location;

                if (status === 429) {
                    res.resume();
                    resolve({ kind: 'rate-limited' });
                    return;
                }

                if (status >= 300 && status < 400 && loc) {
                    res.resume();
                    hops.push({ url: current, status, statusText, headers: collectHeaders(res.headers), body: Buffer.alloc(0) });
                    let next: string;
                    try {
                        next = new URL(loc, current).href;
                    } catch {
                        next = loc;
                    }
                    if (!/^https?:\/\//i.test(next)) {
                        resolve({ kind: 'error', message: `bad redirect location: ${loc}` });
                        return;
                    }
                    attempt(next, redirects + 1);
                    return;
                }

                const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
                const decompress = encoding.includes('gzip') || encoding.includes('deflate');
                const headers = collectHeaders(res.headers).filter(([k]) => {
                    const lower = k.toLowerCase();
                    return !(decompress && (lower === 'content-encoding' || lower === 'content-length'));
                });

                let stream: NodeJS.ReadableStream = res;
                if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip());
                else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());

                const chunks: Buffer[] = [];
                stream.on('data', (c: Buffer) => chunks.push(c));
                stream.on('error', (e) => resolve({ kind: 'error', message: e.message }));
                stream.on('end', () => {
                    hops.push({ url: current, status, statusText, headers, body: Buffer.concat(chunks) });
                    resolve({ kind: 'ok', hops });
                });
            });
            req.on('error', (e) => resolve({ kind: 'error', message: e.message }));
            req.setTimeout(120000, () => {
                req.destroy(new Error('timeout'));
            });
        };
        attempt(url, 0);
    });
}

// ---------------------------------------------------------------------------
// Local `im_` reuse
// ---------------------------------------------------------------------------

/**
 * Wayback does not rewrite images: an `im_` replay route serves the image's
 * archived bytes unchanged, so the `im_` body already captured in the input
 * WACZ *is* the `id_` identity bytes. Reusing it locally saves one network
 * request per image with zero fidelity loss -- unlike `cs_`/`js_`/bare routes,
 * whose replayed bodies are rewritten and must be re-fetched.
 */

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Follow a Wayback replay URL's redirect chain and WARC `revisit` references
 * within the locally-captured records, returning the final content-bearing
 * record. Mirrors the downloader's hop-following, but reads from the input
 * WACZ instead of the network.
 */
function resolveLocalChain(
    startUrl: string,
    byReplayUrl: Map<string, WarcRecord>,
): { record: WarcRecord | null; finalUrl: string } {
    let cur = startUrl;
    for (let hop = 0; hop < 12; hop++) {
        const rec = byReplayUrl.get(cur);
        if (!rec) return { record: null, finalUrl: cur };

        const status = rec.httpStatus;

        if (status !== null && REDIRECT_STATUS.has(status)) {
            const loc = rec.httpHeaders.get('location');
            if (loc) {
                let next: string;
                try {
                    next = new URL(loc, cur).href;
                } catch {
                    next = loc;
                }
                if (next !== cur) {
                    cur = next;
                    continue;
                }
            }
        }

        if (rec.warcType === 'revisit' || rec.body.length === 0) {
            const refersTo = rec.headers.get('warc-refers-to-target-uri');
            if (refersTo && refersTo !== cur) {
                cur = refersTo;
                continue;
            }
        }

        return { record: rec, finalUrl: cur };
    }
    return { record: null, finalUrl: cur };
}

/** Modifiers whose replayed bytes are already the identity bytes. Wayback only
 * rewrites HTML/CSS/JS bodies; every other content type is served verbatim, so
 * `im_` (images), `oe_` (embedded objects: `.dcr`, `.exe`, `.wav`, plugin data),
 * and `id_` (identity) all carry the original bytes unchanged. */
const REUSABLE_MODIFIERS = new Set(['im_', 'oe_', 'id_']);

/** Turn a locally-resolved WARC record into a restored record, mirroring the
 * network path's header restoration and timestamping. */
function recordFromLocal(target: WaybackTarget, record: WarcRecord): KeptRecord {
    const headersArr: [string, string][] = [...record.httpHeaders.entries()];
    const rawCtype = (record.httpHeaders.get('content-type') || '').split(';')[0].trim();
    const headers = restoreWaybackHeaders(headersArr, rawCtype || 'application/octet-stream', record.body);
    const mime = (headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || rawCtype || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    return {
        innerUrl: target.innerUrl,
        ts17: (target.ts14 + '000').slice(0, 17),
        mime,
        status: record.httpStatus ?? 200,
        statusText: record.httpStatusText || '',
        headers,
        body: record.body,
    };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface KeptRecord {
    innerUrl: string;
    ts17: string;
    mime: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Buffer;
}

function resource(name: string, p: string, data: Buffer): Record<string, unknown> {
    return {
        name,
        path: p,
        hash: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
    };
}

function isHtmlMime(mime: string): boolean {
    const m = mime.toLowerCase();
    return m.includes('text/html') || m.includes('application/xhtml+xml');
}

/** True when Wayback would have rewritten a body of this content type. These
 * are the text formats that go through the rewriter (HTML, CSS, JavaScript, and
 * the XML/SVG text types); every other type is served verbatim. Used to guard
 * local reuse: an `im_`/`oe_` route that actually returned one of these (e.g. a
 * 404 HTML error page served for a missing image) was rewritten, so its local
 * body is NOT the identity bytes and must be re-fetched. */
function isRewritableMime(mime: string): boolean {
    const m = mime.toLowerCase();
    return (
        m.includes('html') ||
        m.includes('xml') ||
        m.includes('javascript') ||
        m.includes('ecmascript') ||
        m.includes('css')
    );
}

/** Everything we need from an existing (partially restored) WACZ to append. */
interface ExistingArchive {
    title: string;
    warcGz: Buffer;
    indexLines: string[];
    pagesText: string;
    datapackage: Record<string, unknown>;
}

function loadExisting(filePath: string): ExistingArchive | null {
    if (!fs.existsSync(filePath)) return null;
    const z = ZipReader.open(filePath);
    const names = z.names();

    const warcNames = names.filter((n) => n.endsWith('.warc') || n.endsWith('.warc.gz'));
    if (warcNames.length !== 1) {
        throw new Error(
            `${filePath} is not a single-WARC archive (found ${warcNames.length} archive entries); append is unsupported.`,
        );
    }
    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    if (!indexName) {
        throw new Error(`${filePath} exists but has no CDX index — not a WACZ.`);
    }

    let datapackage: Record<string, unknown> = {};
    try {
        datapackage = JSON.parse(z.readEntry('datapackage.json').toString('utf8'));
    } catch {
        /* optional */
    }

    const warcGz = z.readEntry(warcNames[0]);
    const indexLines = z.readEntry(indexName).toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    let pagesText = '';
    try {
        pagesText = z.readEntry('pages/pages.jsonl').toString('utf8');
    } catch {
        /* optional */
    }

    return {
        title: typeof datapackage.title === 'string' ? datapackage.title : '',
        warcGz,
        indexLines,
        pagesText,
        datapackage,
    };
}

function indexLine(url: string, ts: string, status: number, mime: string, digest: string, offset: number, length: number): string {
    return `${surtKey(url)} ${ts} ${JSON.stringify({
        url,
        digest,
        mime,
        offset,
        length,
        status,
        filename: 'data.warc.gz',
    })}`;
}

/** Write (or append to) the output WACZ. */
function writeOutput(opts: {
    outputFile: string;
    title: string;
    existing: ExistingArchive | null;
    kept: KeptRecord[];
    pages: Record<string, unknown>[];
}): void {
    const { outputFile, title, existing, kept, pages } = opts;

    const warcParts: Buffer[] = existing ? [existing.warcGz] : [];
    let offset = existing ? existing.warcGz.length : 0;
    const newIndexLines: string[] = [];

    for (const r of kept) {
        const record = buildWarcRecord({
            recordId: `<urn:uuid:${crypto.randomUUID()}>`,
            targetUri: r.innerUrl,
            dateRfc3339: cdxjTsToRfc3339(r.ts17),
            response: {
                status: r.status,
                statusText: r.statusText,
                headers: r.headers,
                body: r.body,
            },
        });
        const member = zlib.gzipSync(record);
        warcParts.push(member);
        newIndexLines.push(indexLine(r.innerUrl, r.ts17, r.status, r.mime, payloadDigest(r.body), offset, member.length));
        offset += member.length;
    }
    const warcGz = Buffer.concat(warcParts);

    const allIndexLines = [...(existing ? existing.indexLines : []), ...newIndexLines].sort();
    const cdx = Buffer.from(allIndexLines.join('\n') + '\n', 'utf-8');

    let pagesText: string;
    if (existing && existing.pagesText) {
        pagesText =
            existing.pagesText.replace(/\s+$/, '') +
            '\n' +
            pages.map((o) => JSON.stringify(o)).join('\n') +
            '\n';
    } else {
        pagesText =
            [{ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }, ...pages]
                .map((o) => JSON.stringify(o))
                .join('\n') + '\n';
    }
    const pagesBuf = Buffer.from(pagesText, 'utf-8');

    const nowIso = new Date().toISOString();
    const dp: Record<string, unknown> = existing
        ? { ...existing.datapackage }
        : {
              profile: 'data-package',
              wacz_version: '1.1.1',
              software: 'WaybackArchiver/1.0.0',
              created: nowIso,
          };
    dp.title = title;
    dp.modified = nowIso;
    dp.resources = [
        resource('pages.jsonl', 'pages/pages.jsonl', pagesBuf),
        resource('data.warc.gz', 'archive/data.warc.gz', warcGz),
        resource('index.cdx', 'indexes/index.cdx', cdx),
    ];
    const datapackageBuf = Buffer.from(JSON.stringify(dp, null, 2) + '\n', 'utf-8');
    const digestJson = {
        path: 'datapackage.json',
        hash: 'sha256:' + crypto.createHash('sha256').update(datapackageBuf).digest('hex'),
    };

    writeZipFile(outputFile, [
        { name: 'datapackage.json', data: datapackageBuf, method: 'deflate' },
        { name: 'datapackage-digest.json', data: Buffer.from(JSON.stringify(digestJson, null, 2) + '\n', 'utf-8'), method: 'deflate' },
        { name: 'pages/pages.jsonl', data: pagesBuf, method: 'deflate' },
        { name: 'archive/data.warc.gz', data: warcGz, method: 'store' },
        { name: 'indexes/index.cdx', data: cdx, method: 'store' },
    ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const zip = ZipReader.open(args.input);
    const names = zip.names();

    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    if (!indexName) {
        console.error('Not a WACZ (missing CDX index).');
        process.exit(1);
    }

    const entries = parseCdxj(zip.readEntry(indexName).toString('utf8'));

    // Original page titles, keyed by inner URL, for carrying over to the
    // restored index. The input pages.jsonl lists each *Wayback* URL as its
    // entry point; unwrap it back to the inner URL it will be restored under.
    const titleByInnerUrl = new Map<string, string>();
    try {
        const origPages = zip.readEntry('pages/pages.jsonl').toString('utf8');
        for (const line of origPages.split(/\r?\n/)) {
            if (!line.trim()) continue;
            let obj: Record<string, unknown>;
            try {
                obj = JSON.parse(line);
            } catch {
                continue;
            }
            if (typeof obj.url !== 'string' || typeof obj.title !== 'string') continue;
            const wb = parseWaybackUrl(obj.url);
            if (wb) titleByInnerUrl.set(wb.innerUrl, obj.title);
        }
    } catch {
        /* optional */
    }

    // Read the input WARC's records so `im_` images can be reused locally. The
    // CDXJ `filename` is a basename ("data.warc.gz"); resolve it to the full
    // ZIP path.
    const warcEntries = new Map<string, string>();
    for (const n of names) {
        const base = n.split('/').pop();
        if (base && (base.endsWith('.warc') || base.endsWith('.warc.gz'))) {
            warcEntries.set(base, n);
        }
    }
    const byReplayUrl = new Map<string, WarcRecord>();
    for (const e of entries) {
        try {
            const zipName = warcEntries.get(e.filename) || e.filename;
            const raw = zip.storedRange(zipName, e.offset, e.length);
            const inflated = zlib.gunzipSync(raw);
            byReplayUrl.set(e.url, parseWarcRecord(inflated));
        } catch {
            /* leave unread; a missed `im_` falls back to the network path */
        }
    }

    // Build the unique set of inner URLs to restore, keyed by inner URL and
    // keeping the earliest capture time, while also recording which modifier
    // routes each inner URL appeared under. A URL reached only via `im_` (or
    // `id_`) can be reused from the local capture; one also reached as a page
    // or `cs_`/`js_` must be re-fetched, since that route's bytes are rewritten.
    // Screenshot URNs have no `id_` form and are dropped.
    const targetByInner = new Map<string, WaybackTarget>();
    const modifiersByInner = new Map<string, Set<string>>();
    const replayUrlByInner = new Map<string, string>();
    for (const e of entries) {
        const wb = parseWaybackUrl(e.url);
        if (!wb) {
            if (URN_SCREENSHOT_RE.test(e.url)) continue;
            if (isArchiveOrgHost(hostOf(e.url))) continue;
            continue;
        }
        if (isArchiveOrgHost(hostOf(wb.innerUrl))) continue;

        const mods = modifiersByInner.get(wb.innerUrl) ?? new Set<string>();
        mods.add(wb.modifier);
        modifiersByInner.set(wb.innerUrl, mods);

        const prev = targetByInner.get(wb.innerUrl);
        if (!prev || wb.ts14 < prev.ts14) {
            targetByInner.set(wb.innerUrl, wb);
            replayUrlByInner.set(wb.innerUrl, e.url);
        }
    }

    // Incremental: skip inner URLs the output already holds.
    const existing = loadExisting(args.outputFile);
    const existingUrls = new Set(
        existing ? parseCdxj(existing.indexLines.join('\n')).map((e) => e.url) : [],
    );
    const pending = [...targetByInner.values()]
        .filter((t) => !existingUrls.has(t.innerUrl))
        .sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));

    // Split: a URL reached only via `im_`/`id_` has its identity bytes already
    // captured locally; every other URL must be re-fetched over the network.
    const reuseLocally: WaybackTarget[] = [];
    const targets: WaybackTarget[] = [];
    for (const t of pending) {
        const mods = modifiersByInner.get(t.innerUrl) ?? new Set<string>();
        const onlyReusable = mods.size > 0 && [...mods].every((m) => REUSABLE_MODIFIERS.has(m));
        if (onlyReusable) reuseLocally.push(t);
        else targets.push(t);
    }

    const basename = path.basename(args.outputFile).replace(/\.wacz$/i, '');
    const title = args.title ?? (existing && existing.title ? existing.title : basename);
    const userAgent = args.userAgent || DEFAULT_USER_AGENT;
    const accept = args.accept || DEFAULT_ACCEPT;
    const acceptLanguage = args.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;

    console.log('=== Wayback Restorer ===');
    console.log('Input:     ' + args.input);
    console.log('Output:    ' + args.outputFile + (existing ? ' (appending)' : ' (new)'));
    console.log('Title:     ' + title);
    console.log('User-Agent: ' + userAgent);
    console.log(`${existingUrls.size} already restored, reusing ${reuseLocally.length} locally (im_), fetching ${targets.length} URL(s) (concurrency ${args.concurrency})...\n`);

    const kept: KeptRecord[] = [];
    const keptPages: Record<string, unknown>[] = [];
    const storedUrls = new Set<string>();
    let ok = 0;
    let failed = 0;

    // Local reuse: `im_`/`oe_`/`id_` bodies are already the identity bytes.
    // Resolve each through its redirect/revisit chain in the captured records
    // and write the final record out with no network request. A record whose
    // resolved MIME is a text type Wayback would have rewritten (an HTML error
    // page served for a missing image, say) is NOT safe to reuse -- fall back to
    // re-fetching its `id_` form.
    const promoted: WaybackTarget[] = [];
    for (const t of reuseLocally) {
        const replayUrl = replayUrlByInner.get(t.innerUrl);
        const start = replayUrl ?? t.idUrl;
        const resolved = resolveLocalChain(start, byReplayUrl);
        const rec = resolved.record ?? byReplayUrl.get(start);
        if (!rec || rec.body.length === 0) {
            failed++;
            console.log(`REUSE SKIP (no local body) ${t.innerUrl}`);
            continue;
        }
        const rawCtype = (rec.httpHeaders.get('content-type') || '').split(';')[0].trim();
        if (isRewritableMime(rawCtype)) {
            promoted.push(t);
            continue;
        }
        const keptRec = recordFromLocal(t, rec);
        kept.push(keptRec);
        if (isHtmlMime(keptRec.mime)) {
            const title = titleByInnerUrl.get(t.innerUrl) || t.innerUrl;
            keptPages.push({ url: t.innerUrl, ts: cdxjTsToRfc3339((t.ts14 + '000').slice(0, 17)), title });
        }
        ok++;
        console.log(`REUSE OK ${rec.httpStatus ?? 200} ${t.innerUrl}`);
    }
    if (promoted.length > 0) {
        targets.push(...promoted);
        targets.sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));
        console.log(`promoted ${promoted.length} rewritten local body(ies) to network fetch`);
    }

    // Record one hop (or a whole redirect chain) as restored records. Each hop
    // is unwrapped back to its inner URL and stored there; hops already stored
    // (e.g. a redirect target that is also its own entry) are skipped.
    const recordOk = (target: WaybackTarget, hops: FetchedHop[]): void => {
        for (const hop of hops) {
            const hopInner = parseWaybackUrl(hop.url)?.innerUrl ?? target.innerUrl;
            if (storedUrls.has(hopInner)) continue;
            storedUrls.add(hopInner);

            const rawCtype = (hop.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '').split(';')[0].trim();
            const headers = restoreWaybackHeaders(hop.headers, rawCtype || 'application/octet-stream', hop.body);
            const mime = (headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || rawCtype || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';

            kept.push({
                innerUrl: hopInner,
                ts17: (target.ts14 + '000').slice(0, 17),
                mime,
                status: hop.status,
                statusText: hop.statusText,
                headers,
                body: hop.body,
            });

            if (isHtmlMime(mime)) {
                const title = titleByInnerUrl.get(hopInner) || hopInner;
                keptPages.push({ url: hopInner, ts: cdxjTsToRfc3339((target.ts14 + '000').slice(0, 17)), title });
            }
        }
    };

    // Normal pool: one attempt per URL, at full concurrency. A 429 is set
    // aside on the rate-limit list rather than retried in-place.
    const slowQueue: { target: WaybackTarget; retries: number }[] = [];
    let cursor = 0;

    const worker = async (id: number): Promise<void> => {
        while (true) {
            const i = cursor++;
            if (i >= targets.length) break;
            const t = targets[i];
            const outcome = await fetchOnce(t.idUrl, userAgent, accept, acceptLanguage);
            if (outcome.kind === 'rate-limited') {
                slowQueue.push({ target: t, retries: 0 });
                console.log(`[${id}] RATE-LIMITED ${t.innerUrl}`);
                continue;
            }
            if (outcome.kind === 'error') {
                failed++;
                console.log(`[${id}] FAIL ${outcome.message} | ${t.innerUrl}`);
                continue;
            }
            recordOk(t, outcome.hops);
            ok++;
            const finalHop = outcome.hops[outcome.hops.length - 1];
            console.log(`[${id}] OK ${finalHop.status} ${t.innerUrl}`);
        }
    };

    const threads: Promise<void>[] = [];
    for (let i = 0; i < args.concurrency; i++) threads.push(worker(i + 1));
    await Promise.all(threads);

    // Slow queue: drain one at a time, with backoff on repeated 429s, so the
    // rate-limited URLs retry at a gentler pace than the normal pool.
    if (slowQueue.length > 0) {
        console.log(`\nDraining ${slowQueue.length} rate-limited URL(s) at ${args.rateLimitDelay}ms...\n`);
    }
    while (slowQueue.length > 0) {
        const item = slowQueue.shift()!;
        const outcome = await fetchOnce(item.target.idUrl, userAgent, accept, acceptLanguage);
        if (outcome.kind === 'rate-limited') {
            if (item.retries < args.max429Retries) {
                item.retries++;
                slowQueue.push(item);
                console.log(`SLOW retry ${item.retries}/${args.max429Retries} (backing off ${args.rateLimitDelay * item.retries}ms) ${item.target.innerUrl}`);
                await sleep(args.rateLimitDelay * item.retries);
            } else {
                failed++;
                console.log(`FAIL gave up after ${args.max429Retries} rate-limit retries | ${item.target.innerUrl}`);
            }
            continue;
        }
        if (outcome.kind === 'error') {
            failed++;
            console.log(`SLOW FAIL ${outcome.message} | ${item.target.innerUrl}`);
            continue;
        }
        recordOk(item.target, outcome.hops);
        ok++;
        const finalHop = outcome.hops[outcome.hops.length - 1];
        console.log(`SLOW OK ${finalHop.status} ${item.target.innerUrl}`);
        await sleep(args.rateLimitDelay);
    }

    kept.sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));

    console.log(`\n${ok} restored, ${failed} skipped`);

    if (kept.length === 0 && (!existing || args.title === undefined)) {
        if (existing) {
            console.log('All URLs already restored and no title change — nothing to do.');
            return;
        }
        console.error('Nothing to restore.');
        process.exit(1);
    }

    writeOutput({ outputFile: args.outputFile, title, existing, kept, pages: keptPages });

    console.log('\n=== Done ===');
    console.log('Wrote ' + args.outputFile);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
