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
 * A URL captured at several dates is several snapshots, and each is restored
 * independently: records are de-duplicated by inner URL AND capture timestamp,
 * so the routes of one capture collapse to one record while distinct historical
 * captures never overwrite each other.
 *
 * A Wayback playback redirect, the timestamp shift Wayback writes when it has
 * no capture at the requested time, is retrieval scaffolding: the old server
 * never sent it, and its target is another Wayback URL. It is followed, never
 * archived, and the capture it reaches keeps that capture's own time. The
 * requested timestamp is then left as-is for a later run, exactly like a failed
 * fetch. Wayback's own "not in archive" error page is treated the same way,
 * since it is the 2026 frontend rather than the resource.
 *
 * A resource that cannot be re-fetched is skipped: a network error writes
 * nothing, and a rate limit (429) is retried on a separate slow queue a bounded
 * number of times before also being skipped -- matching how the downloader
 * treats a failed capture.
 *
 * By default an unrestored snapshot is left as-is in the output, so a later run
 * can retry it. `--drop-unrestored` instead omits those Wayback replay records:
 * the result then contains only historical records plus non-replay content
 * (screenshots, archive.org pages), carried unchanged. The input WACZ remains
 * the lossless source either way.
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
 *   npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3] [--offline] [--drop-unrestored]
 */

import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { ZipReader } from '../archive/zip.js';
import { writeZipFile } from '../archive/zip-writer.js';
import { buildWarcRecord, buildWarcinfoRecord, payloadDigest } from '../archive/warc-writer.js';
import { parseWarcRecord, WarcRecord } from '../archive/warc.js';
import { parseCdxj, type CdxjEntry } from '../archive/cdxj.js';
import { cdxjTsToRfc3339, rfc3339ToTs14 } from '../lib/time.js';
import { parseWaybackUrl, restoreWaybackHeaders, isPlaybackRedirect, isWaybackErrorPage, type WaybackTarget, hostOf, isArchiveOrgHost } from '../lib/wayback.js';
import { DEFAULT_USER_AGENT, DEFAULT_ACCEPT, DEFAULT_ACCEPT_LANGUAGE, clientHeaders, collectHeaders, sleep, buildRequestRecord } from '../lib/http.js';
import { SOFTWARE, isHtmlMime, loadExisting, resource, indexLine, type ExistingArchive } from '../archive/wacz-append.js';

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
    /** Fail every fetch immediately without opening a socket (for offline runs). */
    offline: boolean;
    /** Omit unrestored Wayback replay records from the output, leaving only
     * historical records and non-replay content. */
    dropUnrestored: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { input: '', outputFile: '', concurrency: 8, rateLimitDelay: 3000, max429Retries: 3, offline: false, dropUnrestored: false };
    const positional: string[] = [];

    // `--flag value` (space-separated) and `--flag=value` are both accepted.
    // For a space-separated flag that expects a value, the next argv token is
    // its value unless it looks like another flag.
    const VALUE_FLAGS = new Set([
        '--output-file', '--title', '--concurrency', '--user-agent',
        '--accept', '--accept-language', '--rate-limit-delay', '--max-429-retries',
    ]);
    const takeValue = (i: number): { val: string; next: number } => {
        const eq = argv[i].indexOf('=');
        if (eq >= 0) return { val: argv[i].slice(eq + 1), next: i };
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith('--')) return { val: nxt, next: i + 1 };
        return { val: '', next: i };
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = a.indexOf('=');
        const key = eq >= 0 ? a.slice(0, eq) : a;
        let val = eq >= 0 ? a.slice(eq + 1) : '';
        if (eq < 0 && VALUE_FLAGS.has(key)) {
            const r = takeValue(i);
            val = r.val;
            i = r.next;
        }

        if (key === '--output-file') args.outputFile = val;
        else if (key === '--title') args.title = val;
        else if (key === '--concurrency') args.concurrency = parseInt(val, 10) || 8;
        else if (key === '--user-agent') args.userAgent = val;
        else if (key === '--accept') args.accept = val;
        else if (key === '--accept-language') args.acceptLanguage = val;
        else if (key === '--rate-limit-delay') args.rateLimitDelay = parseInt(val, 10) || 3000;
        else if (key === '--max-429-retries') args.max429Retries = parseInt(val, 10) || 3;
        else if (key === '--offline') args.offline = true;
        else if (key === '--drop-unrestored') args.dropUnrestored = true;
        else if (!a.startsWith('--')) positional.push(a);
    }
    if (positional.length > 0) args.input = path.resolve(positional[0]);
    if (!args.input) {
        console.error('Usage: npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3] [--offline] [--drop-unrestored]');
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

export interface FetchedHop {
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
 * Decide which URL to fetch next after a redirect.
 *
 * The restorer must never leave the archive: following a historical `Location`
 * to the live web would archive 2026 content under an old URL. So when the
 * redirect was served by a Wayback route, a non-Wayback target is fetched
 * through Wayback at the same capture time (`/web/<ts>id_/<target>`), which
 * yields that capture's archived copy.
 *
 * A playback redirect (the timestamp shift Wayback writes itself, detected by
 * its `X-Archive-Redirect-Reason` header) names another replay route, either
 * absolute or relative to the Wayback host, and is followed unchanged. Without
 * that header an absolute replay URL is recognised from its form; a relative
 * `/web/...` path is also treated as playback, since it cannot be a location on
 * the captured site.
 */
export function resolveRedirectUrl(location: string, currentUrl: string, playbackRedirect = false): string | null {
    let resolved: string;
    const current = parseWaybackUrl(currentUrl);

    if (!current) {
        try {
            resolved = new URL(location, currentUrl).href;
        } catch {
            return null;
        }
        return /^https?:\/\//i.test(resolved) ? resolved : null;
    }

    if (playbackRedirect || isPlaybackRedirect(location, currentUrl)) {
        try {
            resolved = new URL(location, currentUrl).href;
        } catch {
            return null;
        }
        return /^https?:\/\//i.test(resolved) ? resolved : null;
    }

    // Resolve a historical Location against the URL the capture is of, not
    // against the Wayback route that served it.
    try {
        resolved = new URL(location, current.innerUrl).href;
    } catch {
        return null;
    }
    if (!/^https?:\/\//i.test(resolved)) return null;
    return `https://web.archive.org/web/${current.ts14}id_/${resolved}`;
}

/**
 * Fetch a URL, following redirects (up to 8 hops) and recording every hop, not
 * just the final response. A 3xx is kept as its own (empty-body) hop under its
 * own URL; the final 200/error is the last hop. A 429 is *not* retried here --
 * it is reported as `rate-limited` so the caller can move it onto the slow
 * queue. Bodies are decompressed transparently so the stored record carries the
 * decoded payload.
 */
function fetchOnce(url: string, userAgent: string, accept: string, acceptLanguage: string, offline = false): Promise<FetchOutcome> {
    // `--offline` short-circuits the fetch: no socket is opened, so archive.org
    // can be "unreachable" without waiting out a real connection timeout. Every
    // target then fails instantly and is carried over as-is, leaving the archive
    // unchanged.
    if (offline) return Promise.resolve({ kind: 'error', message: 'offline (no network access)' });
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
                    const playbackRedirect = res.headers['x-archive-redirect-reason'] !== undefined;
                    const next = resolveRedirectUrl(loc, current, playbackRedirect);
                    if (!next) {
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
        recordId: `<urn:uuid:${crypto.randomUUID()}>`,
        identifiedPayloadType: record.headers.get('warc-identified-payload-type') || undefined,
    };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface KeptRecord {
    innerUrl: string;
    ts17: string;
    mime: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Buffer;
    /** The WARC-Record-ID assigned to this response record. */
    recordId: string;
    /** The crawler's `WARC-Identified-Payload-Type` (e.g.
     * `text/html; charset=windows-1250`), carried from the input capture. It is
     * how a page whose 1990s server declared no charset still replays with the
     * encoding its stored bytes actually use. */
    identifiedPayloadType?: string;
    /**
     * The `request` record documenting how this capture was fetched (the `id_`
     * identity route, under which client identity), written immediately before
     * the response member. Present only on the first stored hop of a fetch,
     * mirroring the downloader's one-request-per-URL convention.
     */
    requestRecord?: Buffer;
}

/** The records one successful `id_` chain contributes to the output. */
export interface RestoredRecords {
    records: KeptRecord[];
    pages: Record<string, unknown>[];
    /** True when the chain produced a record for the requested snapshot itself. */
    wroteTarget: boolean;
    /** Status of the last record written, for progress logging. */
    lastStatus: number;
    /** Capture timestamp (14 digits) of the last record written, for logging. */
    lastTs14: string;
    /** Playback redirects passed over: retrieval scaffolding, never archived. */
    skippedPlaybackRedirects: number;
    /** Wayback error pages passed over: the 2026 frontend, never archived. */
    skippedErrorPages: number;
    /** Hops whose snapshot was already in the output (a redirect to a capture
     * another chain restored), so this chain wrote nothing new for them. */
    skippedAlreadyStored: number;
    /** Capture timestamp of the first already-stored hop, for logging. */
    alreadyStoredTs14?: string;
}

/** Key identifying one archived snapshot: inner URL plus capture timestamp. A
 * URL captured at several times is several resources; two routes of one capture
 * (bare, `im_`, ...) are one. */
export function snapshotKey(innerUrl: string, ts14: string): string {
    return innerUrl + '\t' + ts14;
}

/** True for a redirect Wayback wrote itself (a timestamp shift to the nearest
 * capture), which must be followed but never archived: the old server never
 * sent it, and its `location` is another playback URL.
 *
 * A real archived redirect, by contrast, is served with historical
 * `X-Archive-Orig-*` headers (and its rewritten `location` unwrapped back to
 * the historical target), so it is always kept. Wayback marks its own redirects
 * with `X-Archive-Redirect-Reason`; the `location` test is the fallback for a
 * response whose historical headers and reason header are both absent. */
function isPlaybackHop(hop: FetchedHop): boolean {
    if (hop.status < 300 || hop.status >= 400) return false;
    const names = hop.headers.map(([name]) => name.toLowerCase());
    if (names.some((name) => name.startsWith('x-archive-orig-'))) return false;
    if (names.includes('x-archive-redirect-reason')) return true;
    const location = hop.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
    return location !== undefined && isPlaybackRedirect(location, hop.url);
}

/** MIME types that carry a character encoding and can use a charset guess. */
function isTextualType(type: string): boolean {
    return /^(text\/|application\/(?:xhtml\+xml|xml|javascript|ecmascript|json))/i.test(type);
}

/**
 * Wayback's own guess for a response, as a `WARC-Identified-Payload-Type`
 * value: `X-Archive-Guessed-Content-Type` plus `X-Archive-Guessed-Charset`.
 * Only textual types get a charset; a charset on an image is meaningless.
 */
function guessedTypeFromHeaders(headers: [string, string][]): string | undefined {
    const get = (name: string): string | undefined =>
        headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];
    const charset = get('x-archive-guessed-charset');
    if (!charset) return undefined;
    const type = get('x-archive-guessed-content-type') ?? get('content-type');
    if (!type || !isTextualType(type)) return undefined;
    return `${type}; charset=${charset}`;
}

/**
 * The charset metadata to carry as `WARC-Identified-Payload-Type`.
 *
 * Wayback's official `X-Archive-Guessed-Charset` wins over ArchiveWeb.page's
 * own `WARC-Identified-Payload-Type`; the latter is only the fallback. This
 * keeps the replay encoding from depending on the client that made the input
 * capture.
 */
function identifiedTypeFromHeaders(
    headers: [string, string][],
    identified?: string,
): string | undefined {
    return guessedTypeFromHeaders(headers) ?? identified;
}

/**
 * The chosen `WARC-Identified-Payload-Type` per snapshot, from the input
 * capture. A snapshot can appear under several routes (bare, `im_`, `id_`); a
 * route with Wayback's guess wins even when another route recorded the
 * ArchiveWeb.page type first.
 */
export function buildIdentifiedTypeMap(
    entries: CdxjEntry[],
    recordByUrl: Map<string, WarcRecord>,
): Map<string, string> {
    const bySnapshot = new Map<string, string>();
    for (const e of entries) {
        const wb = parseWaybackUrl(e.url);
        if (!wb) continue;
        const rec = recordByUrl.get(e.url);
        if (!rec) continue;
        const key = snapshotKey(wb.innerUrl, wb.ts14);
        const guess = guessedTypeFromHeaders([...rec.httpHeaders.entries()]);
        if (guess) {
            bySnapshot.set(key, guess);
            continue;
        }
        const identified = rec.headers.get('warc-identified-payload-type');
        if (identified && !bySnapshot.has(key)) bySnapshot.set(key, identified);
    }
    return bySnapshot;
}

/**
 * Turn one successful `id_` fetch (its redirect chain) into output records.
 *
 * Every kept hop is stored under its own inner URL. Its timestamp is the
 * capture time the hop's URL names: a followed redirect to a Wayback playback
 * URL carries the capture timestamp Wayback chose for it, so the bytes keep
 * their real capture time instead of being relabelled with the timestamp that
 * redirected to them.
 *
 * Two kinds of hop are retrieval scaffolding of the 2026 replay frontend, not
 * historical material, and are never written:
 *
 *   - a playback redirect (a timestamp shift to the nearest capture);
 *   - Wayback's own error page.
 *
 * `storedKeys` de-duplicates by inner URL AND capture timestamp. Sharing it
 * across a run keeps a redirect target that is also its own target from being
 * written twice, without merging distinct historical captures of one URL.
 */
export function buildRestoredRecords(opts: {
    target: WaybackTarget;
    hops: FetchedHop[];
    storedKeys: Set<string>;
    titleByInnerUrl: Map<string, string>;
    userAgent: string;
    accept: string;
    acceptLanguage: string;
    /** The crawler's charset guess per snapshot, from the input capture. */
    identifiedTypeBySnapshot?: Map<string, string>;
}): RestoredRecords {
    const { target, hops, storedKeys, titleByInnerUrl, userAgent, accept, acceptLanguage } = opts;
    const identifiedTypeBySnapshot = opts.identifiedTypeBySnapshot ?? new Map<string, string>();
    const records: KeptRecord[] = [];
    const pages: Record<string, unknown>[] = [];
    let lastStatus = 0;
    let lastTs14 = target.ts14;
    let skippedPlaybackRedirects = 0;
    let skippedErrorPages = 0;
    let skippedAlreadyStored = 0;
    let alreadyStoredTs14: string | undefined;

    for (const hop of hops) {
        if (isPlaybackHop(hop)) {
            skippedPlaybackRedirects++;
            continue;
        }
        if (isWaybackErrorPage(hop.status, hop.headers, hop.body)) {
            skippedErrorPages++;
            continue;
        }

        const hopWayback = parseWaybackUrl(hop.url);
        const hopInner = hopWayback?.innerUrl ?? hop.url;
        const ts14 = hopWayback?.ts14 ?? target.ts14;
        const storeKey = snapshotKey(hopInner, ts14);
        if (storedKeys.has(storeKey)) {
            if (skippedAlreadyStored === 0) alreadyStoredTs14 = ts14;
            skippedAlreadyStored++;
            continue;
        }
        storedKeys.add(storeKey);

        const ts17 = (ts14 + '000').slice(0, 17);
        const dateRfc3339 = cdxjTsToRfc3339(ts17);
        const rawCtype = (hop.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '').split(';')[0].trim();
        const headers = restoreWaybackHeaders(hop.headers, rawCtype || 'application/octet-stream', hop.body);
        const mime = (headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] || rawCtype || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
        const recordId = `<urn:uuid:${crypto.randomUUID()}>`;
        const identifiedPayloadType =
            identifiedTypeFromHeaders(hop.headers) ?? identifiedTypeBySnapshot.get(storeKey);

        records.push({
            innerUrl: hopInner,
            ts17,
            mime,
            status: hop.status,
            statusText: hop.statusText,
            headers,
            body: hop.body,
            recordId,
            identifiedPayloadType,
            requestRecord: records.length === 0
                ? buildRequestRecord(target.idUrl, recordId, dateRfc3339, userAgent, accept, acceptLanguage)
                : undefined,
        });
        lastStatus = hop.status;
        lastTs14 = ts14;

        if (isHtmlMime(mime)) {
            pages.push({ url: hopInner, ts: cdxjTsToRfc3339(ts17), title: titleByInnerUrl.get(hopInner) || hopInner });
        }
    }

    return {
        records,
        pages,
        wroteTarget: storedKeys.has(snapshotKey(target.innerUrl, target.ts14)),
        lastStatus,
        lastTs14,
        skippedPlaybackRedirects,
        skippedErrorPages,
        skippedAlreadyStored,
        alreadyStoredTs14,
    };
}

/**
 * A non-replay record carried over verbatim. Rather than being re-fetched or
 * re-serialized, the original gzip member bytes are copied unchanged into the
 * output stream and re-indexed at their new offset, preserving every original
 * CDXJ field except offset/length.
 */
export interface CarriedRecord {
    /** The record's URL, unchanged. */
    url: string;
    /** The original SURT sort key from the CDXJ line. */
    key: string;
    /** The original 17-digit CDXJ timestamp. */
    ts: string;
    /** The original CDXJ JSON object (offset/length updated at write time). */
    json: Record<string, unknown>;
    /** The original gzip member bytes, verbatim. */
    rawMember: Buffer;
    /** Whether the CDXJ mime is HTML, deciding whether it is listed as a page. */
    isHtml: boolean;
    /** Page title from the input pages.jsonl, when present. */
    title?: string;
    /** The input's own pages.jsonl entry for this URL, copied unchanged. */
    page?: Record<string, unknown>;
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

/** An existing archive with some indexed records spliced out. */
export interface DroppedArchive {
    warcGz: Buffer;
    indexLines: string[];
    pagesText: string;
}

/**
 * Splice the given CDXJ entries out of an existing archive: their gzip members
 * are removed from the WARC stream, every kept entry's offset is remapped, and
 * their pages.jsonl entries are removed. The un-indexed warcinfo/request
 * members are untouched, exactly as they were.
 */
function dropEntries(existing: ExistingArchive, droppedEntries: CdxjEntry[]): DroppedArchive {
    const dropped = [...droppedEntries].sort((a, b) => a.offset - b.offset);
    if (dropped.length === 0) {
        return { warcGz: existing.warcGz, indexLines: existing.indexLines, pagesText: existing.pagesText };
    }

    const entries = parseCdxj(existing.indexLines.join('\n'));
    const droppedOffsets = new Set(dropped.map((e) => e.offset));
    const kept = entries.filter((e) => !droppedOffsets.has(e.offset));

    // Splice dropped byte ranges out of the stored WARC, and remap every kept
    // entry's offset by the total length removed before it.
    const parts: Buffer[] = [];
    let cursor = 0;
    for (const d of dropped) {
        if (d.offset > cursor) parts.push(existing.warcGz.subarray(cursor, d.offset));
        cursor = d.offset + d.length;
    }
    if (cursor < existing.warcGz.length) parts.push(existing.warcGz.subarray(cursor));
    const warcGz = Buffer.concat(parts);

    const droppedRanges = dropped.map((d) => ({ start: d.offset, len: d.length }));
    const newIndexLines: string[] = [];
    for (const e of kept) {
        let rem = 0;
        for (const r of droppedRanges) {
            if (r.start + r.len <= e.offset) rem += r.len;
        }
        const newOffset = e.offset - rem;
        newIndexLines.push(`${e.key} ${e.timestamp} ${JSON.stringify({ ...e.json, offset: newOffset, length: e.length })}`);
    }
    newIndexLines.sort();

    // Remove the page entries of every dropped record. Their CDX mime can be
    // `warc/revisit`, so match by URL rather than by mime.
    let pagesText = existing.pagesText;
    const droppedUrls = new Set(dropped.map((e) => e.url));
    if (droppedUrls.size > 0 && pagesText) {
        const lines = pagesText.split(/\r?\n/).filter((line) => {
            const t = line.trim();
            if (!t) return false;
            try {
                const o = JSON.parse(t);
                return typeof o.url !== 'string' || !droppedUrls.has(o.url);
            } catch {
                return true;
            }
        });
        pagesText = lines.join('\n') + '\n';
    }

    return { warcGz, indexLines: newIndexLines, pagesText };
}

/**
 * Rebuild an existing archive's WARC/index/pages with a set of carried Wayback
 * records removed: those whose snapshot was just successfully restored, so the
 * stale replayed copy no longer coexists with its restored inner-URL form (B2).
 * Members are spliced out of `existing.warcGz` by their byte ranges; the
 * un-indexed warcinfo/request members are untouched. Returns the cleaned
 * `warcGz`, index lines (with remapped offsets), and pages text.
 */
export function dropStaleCarried(
    existing: ExistingArchive,
    restoredSnapKeys: Set<string>,
): DroppedArchive {
    const entries = parseCdxj(existing.indexLines.join('\n'));

    // A carried Wayback replay URL whose snapshot was restored this run is stale.
    const isStale = (e: CdxjEntry): boolean => {
        const wb = parseWaybackUrl(e.url);
        if (!wb) return false;
        return restoredSnapKeys.has(wb.innerUrl + '\t' + wb.ts14);
    };

    return dropEntries(existing, entries.filter(isStale));
}

/**
 * Remove every carried Wayback replay record, i.e. the unrestored snapshots,
 * while keeping restored records and all non-replay content. This is the
 * `--drop-unrestored` output: a historical-only archive with no 2026 replay
 * URLs left in it.
 */
export function dropUnrestoredReplay(existing: ExistingArchive): DroppedArchive {
    const entries = parseCdxj(existing.indexLines.join('\n'));
    return dropEntries(existing, entries.filter((e) => parseWaybackUrl(e.url) !== null));
}

/** Write (or append to) the output WACZ. Exported for the offline write-path
 * tests, which build records directly instead of fetching them. */
export function writeOutput(opts: {
    outputFile: string;
    title: string;
    existing: ExistingArchive | null;
    kept: KeptRecord[];
    pages: Record<string, unknown>[];
    carried: CarriedRecord[];
    restoredSnapKeys: Set<string>;
    /** Drop every carried Wayback replay record, including one an existing
     * output already holds, so only historical records remain. */
    dropUnrestored?: boolean;
}): void {
    const { outputFile, title, existing, kept, pages, carried, restoredSnapKeys, dropUnrestored = false } = opts;

    const nowIso = new Date().toISOString();
    let cleaned: DroppedArchive | null = null;
    if (existing) {
        cleaned = dropStaleCarried(existing, restoredSnapKeys);
        if (dropUnrestored) {
            cleaned = dropUnrestoredReplay({ ...existing, ...cleaned });
        }
    }
    const baseWarcGz = cleaned ? cleaned.warcGz : null;
    const baseIndexLines = cleaned ? cleaned.indexLines : [];

    const warcParts: Buffer[] = baseWarcGz ? [baseWarcGz] : [];
    let offset = baseWarcGz ? baseWarcGz.length : 0;
    const newIndexLines: string[] = [];
    const carriedPages: Record<string, unknown>[] = [];

    // A fresh archive begins with a `warcinfo` record describing the restore,
    // mirroring the downloader. On append the existing stream (and its own
    // warcinfo) is carried over unchanged, so it is written exactly once.
    if (!existing) {
        const warcinfo = buildWarcinfoRecord({
            recordId: `<urn:uuid:${crypto.randomUUID()}>`,
            dateRfc3339: nowIso,
            warcFilename: `${path.basename(outputFile)}#/archive/data.warc.gz`,
            software: SOFTWARE,
            isPartOf: title,
        });
        const member = zlib.gzipSync(warcinfo);
        warcParts.push(member);
        offset += member.length;
    }

    for (const r of kept) {
        // The `request` record (when present) is written first as its own
        // member, un-indexed: it documents the `id_` fetch that produced the
        // response member that follows.
        if (r.requestRecord) {
            const reqMember = zlib.gzipSync(r.requestRecord);
            warcParts.push(reqMember);
            offset += reqMember.length;
        }

        const record = buildWarcRecord({
            recordId: r.recordId,
            targetUri: r.innerUrl,
            dateRfc3339: cdxjTsToRfc3339(r.ts17),
            response: {
                status: r.status,
                statusText: r.statusText,
                headers: r.headers,
                body: r.body,
            },
            identifiedPayloadType: r.identifiedPayloadType,
        });
        const member = zlib.gzipSync(record);
        warcParts.push(member);
        newIndexLines.push(indexLine(r.innerUrl, r.ts17, r.status, r.mime, payloadDigest(r.body), offset, member.length));
        offset += member.length;
    }

    // Non-replay records carried over verbatim: the original gzip member bytes
    // are copied unchanged and re-indexed at their new offset, preserving every
    // other CDXJ field (including any non-standard ones the source tool wrote).
    for (const c of carried) {
        const member = c.rawMember;
        warcParts.push(member);
        const json = { ...c.json, offset, length: member.length };
        newIndexLines.push(`${c.key} ${c.ts} ${JSON.stringify(json)}`);
        offset += member.length;

        if (c.page) {
            // A carried page keeps the input's own page entry, including its
            // full text and size, instead of a stripped-down replacement. This
            // also covers a revisit record whose CDX mime says `warc/revisit`
            // but which the input still listed as a page.
            carriedPages.push(c.page);
        } else if (c.isHtml) {
            carriedPages.push({
                url: c.url,
                ts: cdxjTsToRfc3339(c.ts),
                title: c.title || c.url,
            });
        }
    }
    const warcGz = Buffer.concat(warcParts);

    const allIndexLines = [...baseIndexLines, ...newIndexLines].sort();
    const cdx = Buffer.from(allIndexLines.join('\n') + '\n', 'utf-8');

    const allPages = [...pages, ...carriedPages];
    let pagesText: string;
    if (cleaned && cleaned.pagesText) {
        pagesText =
            cleaned.pagesText.replace(/\s+$/, '') +
            '\n' +
            allPages.map((o) => JSON.stringify(o)).join('\n') +
            '\n';
    } else {
        pagesText =
            [{ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }, ...allPages]
                .map((o) => JSON.stringify(o))
                .join('\n') + '\n';
    }
    const pagesBuf = Buffer.from(pagesText, 'utf-8');

    const dp: Record<string, unknown> = existing
        ? { ...existing.datapackage }
        : {
              profile: 'data-package',
              wacz_version: '1.1.1',
              software: SOFTWARE,
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

    // Original page entries from pages.jsonl, keyed by URL plus capture time
    // (a URL captured twice has one entry per capture) and by URL alone as a
    // fallback. Carried records copy their entry unchanged; restored pages need
    // a new entry under the inner URL.
    const pageByUrlTs = new Map<string, Record<string, unknown>>();
    const pageByUrl = new Map<string, Record<string, unknown>>();
    const titleByInnerUrl = new Map<string, string>();
    const titleByUrl = new Map<string, string>();
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
            if (typeof obj.url !== 'string') continue;
            if (typeof obj.ts === 'string') {
                pageByUrlTs.set(obj.url + '\t' + rfc3339ToTs14(obj.ts), obj);
            }
            pageByUrl.set(obj.url, obj);
            if (typeof obj.title !== 'string') continue;
            titleByUrl.set(obj.url, obj.title);
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

    // Wayback's charset guess for each snapshot, or ArchiveWeb.page's identified
    // type as the fallback. Keeping it as the record's
    // WARC-Identified-Payload-Type is what lets a page whose 1990s server
    // declared no charset (the common case) replay with the encoding its stored
    // bytes actually use.
    const identifiedTypeBySnapshot = buildIdentifiedTypeMap(entries, byReplayUrl);

    // Restore targets are keyed by *snapshot* -- the inner URL together with its
    // historical capture time. A single URL captured at several points in the
    // past (e.g. `web/1998/...` and `web/1999/...`) is several distinct
    // resources and each is restored (or carried on failure) independently,
    // rather than collapsing them to the earliest capture.
    //
    // Within one snapshot, the same URL may appear under several modifier
    // routes (bare, `im_`, `cs_`, ...); those are aggregated and restored once.
    //
    // Anything that is NOT a Wayback replay URL is carried over verbatim:
    // screenshots (`urn:thumbnail`/`urn:view`), Wayback queries (site/CDX
    // searches), other archive.org content, and resources from other sites.
    const targetBySnap = new Map<string, WaybackTarget>();
    const modifiersBySnap = new Map<string, Set<string>>();
    const replayUrlBySnap = new Map<string, string>();
    // Every CDXJ entry per snapshot, not just one: a replay URL may have been
    // captured several times, and a failed restore must carry ALL of its
    // original entries over verbatim (not collapse them to one), to keep the
    // archive lossless.
    const entriesBySnap = new Map<string, CdxjEntry[]>();
    const carried: CarriedRecord[] = [];

    // Build a carried-over record from a CDXJ entry by copying its original
    // gzip member bytes verbatim. Used for non-replay records directly, and as
    // the fallback when a replay target cannot be re-fetched: rather than
    // dropping the resource, its original replayed bytes are left untouched in
    // the output so a later run can retry the restore against a complete archive.
    const carryFromEntry = (e: CdxjEntry): CarriedRecord | null => {
        const zipName = warcEntries.get(e.filename) || e.filename;
        let raw: Buffer;
        try {
            raw = zip.storedRange(zipName, e.offset, e.length);
        } catch {
            return null;
        }
        return {
            url: e.url,
            key: e.key,
            ts: e.timestamp,
            json: e.json,
            rawMember: raw,
            isHtml: isHtmlMime(e.mime),
            title: titleByUrl.get(e.url),
            page:
                pageByUrlTs.get(e.url + '\t' + e.timestamp.slice(0, 14)) ??
                pageByUrl.get(e.url),
        };
    };

    for (const e of entries) {
        const wb = parseWaybackUrl(e.url);
        if (!wb) {
            // Leave as-is: copy the original member bytes and index entry.
            const c = carryFromEntry(e);
            if (c) carried.push(c);
            continue;
        }
        if (isArchiveOrgHost(hostOf(wb.innerUrl))) {
            // A replay of archive.org's own pages (its CDX queries, calendar
            // pages, search screens, item pages) is not a capture of the open
            // web. Leave it exactly as the input captured it: restoring it would
            // invent history, and dropping it would lose a record.
            const c = carryFromEntry(e);
            if (c) carried.push(c);
            continue;
        }

        const sk = snapshotKey(wb.innerUrl, wb.ts14);

        const mods = modifiersBySnap.get(sk) ?? new Set<string>();
        mods.add(wb.modifier);
        modifiersBySnap.set(sk, mods);

        if (!targetBySnap.has(sk)) {
            targetBySnap.set(sk, wb);
            replayUrlBySnap.set(sk, e.url);
        }
        const list = entriesBySnap.get(sk) ?? [];
        list.push(e);
        entriesBySnap.set(sk, list);
    }

    // Incremental: skip snapshots the output already holds. A restored record's
    // URL is its inner URL and its CDXJ timestamp is the historical capture time
    // (17 digits), so "already restored" means that inner-URL+time pair exists in
    // the output. This preserves B1 (no re-restoring an already-restored
    // snapshot) while letting B3's multiple historical snapshots of one URL each
    // be restored.
    const existing = loadExisting(args.outputFile);
    const existingEntries = existing ? parseCdxj(existing.indexLines.join('\n')) : [];
    const existingSnapshotKeys = new Set(
        existingEntries
            .filter((e) => !parseWaybackUrl(e.url)) // ignore carried wayback URLs
            .map((e) => snapshotKey(e.url, e.timestamp.slice(0, 14))),
    );
    // Carried records are identified by URL *and* timestamp (a URL may have
    // been captured several times), so dedupe against the output by that pair.
    const existingCarriedKeys = new Set(existingEntries.map((e) => `${e.url}\t${e.timestamp}`));
    const pending = [...targetBySnap.values()]
        .filter((t) => !existingSnapshotKeys.has(snapshotKey(t.innerUrl, t.ts14)))
        .sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));

    // Split: a snapshot reached only via `im_`/`id_` has its identity bytes
    // already captured locally; every other snapshot must be re-fetched over the
    // network. Local reuse needs no network, so it still succeeds under
    // `--offline`; only the network fetch path is short-circuited to an instant
    // failure.
    const reuseLocally: WaybackTarget[] = [];
    const targets: WaybackTarget[] = [];
    for (const t of pending) {
        const mods = modifiersBySnap.get(snapshotKey(t.innerUrl, t.ts14)) ?? new Set<string>();
        const onlyReusable = mods.size > 0 && [...mods].every((m) => REUSABLE_MODIFIERS.has(m));
        if (onlyReusable) reuseLocally.push(t);
        else targets.push(t);
    }

    // When a snapshot cannot be restored -- a failed `id_` fetch, an exhausted
    // rate limit, or a local body that could not be resolved -- leave its
    // original record(s) untouched in the output instead of dropping them, so a
    // later run can retry the restore against a still-complete archive.
    const carryOnFailure = (t: WaybackTarget): void => {
        // Carry ALL original entries for the failed snapshot, not just one, so a
        // duplicate capture is preserved losslessly.
        for (const entry of entriesBySnap.get(snapshotKey(t.innerUrl, t.ts14)) ?? []) {
            const c = carryFromEntry(entry);
            if (c) carried.push(c);
        }
    };

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
    console.log(`${existingSnapshotKeys.size} already restored, reusing ${reuseLocally.length} locally (im_), fetching ${targets.length} URL(s), carrying over ${carried.length} (concurrency ${args.concurrency})...\n`);

    const kept: KeptRecord[] = [];
    const keptPages: Record<string, unknown>[] = [];
    // De-duplication is by inner URL AND capture timestamp. Seeding it with the
    // output's own snapshots also stops a redirect target that the output
    // already holds from being written a second time.
    const storedKeys = new Set(existingSnapshotKeys);
    let ok = 0;
    let shifted = 0;
    let failed = 0;

    // Local reuse: `im_`/`oe_`/`id_` bodies are already the identity bytes.
    // Resolve each through its redirect/revisit chain in the captured records
    // and write the final record out with no network request. A record whose
    // resolved MIME is a text type Wayback would have rewritten (an HTML error
    // page served for a missing image, say) is NOT safe to reuse. Neither is a
    // snapshot with no local body. Both fall back to re-fetching the `id_`
    // route, which can still serve the capture or shift to the nearest one.
    const promoted: WaybackTarget[] = [];
    for (const t of reuseLocally) {
        const replayUrl = replayUrlBySnap.get(snapshotKey(t.innerUrl, t.ts14));
        const start = replayUrl ?? t.idUrl;
        const resolved = resolveLocalChain(start, byReplayUrl);
        const rec = resolved.record ?? byReplayUrl.get(start);
        if (!rec || rec.body.length === 0) {
            // Nothing local to reuse. Try the identity route over the network
            // instead of giving up: Wayback can still serve the capture (or
            // shift to the nearest one), while `--offline` fails and leaves the
            // snapshot as-is exactly as before.
            promoted.push(t);
            console.log(`NO LOCAL BODY ${t.innerUrl} (fetching id_)`);
            continue;
        }
        const rawCtype = (rec.httpHeaders.get('content-type') || '').split(';')[0].trim();
        if (isRewritableMime(rawCtype)) {
            promoted.push(t);
            continue;
        }
        const reuseKey = snapshotKey(t.innerUrl, t.ts14);
        if (storedKeys.has(reuseKey)) {
            // A redirect chain this run already stored this snapshot; the bytes
            // are the same resource, so reuse it without a second record.
            ok++;
            console.log(`REUSE OK ${rec.httpStatus ?? 200} ${t.innerUrl} (already stored)`);
            continue;
        }
        storedKeys.add(reuseKey);
        const keptRec = recordFromLocal(t, rec);
        // Wayback's guess (from any route of this snapshot) wins over the
        // ArchiveWeb.page type the local record itself carries.
        keptRec.identifiedPayloadType =
            identifiedTypeBySnapshot.get(reuseKey) ?? keptRec.identifiedPayloadType;
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
        console.log(`promoted ${promoted.length} local snapshot(s) to network fetch`);
    }

    // Turn one successful fetch into output records. A chain that only shifts
    // to a real capture elsewhere (Wayback had nothing at the requested
    // timestamp) does not restore the requested snapshot itself: its input
    // records are left as-is for a later run instead of being relabelled with
    // bytes captured at a different time.
    const storeOutcome = (target: WaybackTarget, hops: FetchedHop[]): RestoredRecords => {
        const batch = buildRestoredRecords({ target, hops, storedKeys, titleByInnerUrl, userAgent, accept, acceptLanguage, identifiedTypeBySnapshot });
        kept.push(...batch.records);
        keptPages.push(...batch.pages);
        return batch;
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
            const outcome = await fetchOnce(t.idUrl, userAgent, accept, acceptLanguage, args.offline);
            if (outcome.kind === 'rate-limited') {
                slowQueue.push({ target: t, retries: 0 });
                console.log(`[${id}] RATE-LIMITED ${t.innerUrl}`);
                continue;
            }
            if (outcome.kind === 'error') {
                failed++;
                carryOnFailure(t);
                console.log(`[${id}] FAIL ${outcome.message} | ${t.innerUrl} (left as-is)`);
                continue;
            }
            const batch = storeOutcome(t, outcome.hops);
            if (batch.wroteTarget) {
                ok++;
                console.log(`[${id}] OK ${batch.lastStatus} ${t.innerUrl}`);
            } else if (batch.records.length > 0) {
                // Wayback answered with a timestamp shift: the bytes are real,
                // but they belong to another capture, so they are stored under
                // that capture's own time and this snapshot is left as-is.
                shifted++;
                carryOnFailure(t);
                console.log(`[${id}] SHIFT ${batch.lastStatus} ${t.innerUrl} (no capture at ${t.ts14}; nearest capture stored at ${batch.lastTs14}) (left as-is)`);
            } else if (batch.skippedAlreadyStored > 0) {
                // The redirect led to a capture another chain had already
                // stored, so no new record was written, but the bytes are in
                // the archive at their own time.
                shifted++;
                carryOnFailure(t);
                console.log(`[${id}] SHIFT ${t.innerUrl} (no capture at ${t.ts14}; nearest capture already in the archive at ${batch.alreadyStoredTs14}) (left as-is)`);
            } else {
                failed++;
                carryOnFailure(t);
                console.log(`[${id}] SKIP ${t.innerUrl} (no historical capture) (left as-is)`);
            }
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
        const outcome = await fetchOnce(item.target.idUrl, userAgent, accept, acceptLanguage, args.offline);
        if (outcome.kind === 'rate-limited') {
            if (item.retries < args.max429Retries) {
                item.retries++;
                slowQueue.push(item);
                console.log(`SLOW retry ${item.retries}/${args.max429Retries} (backing off ${args.rateLimitDelay * item.retries}ms) ${item.target.innerUrl}`);
                await sleep(args.rateLimitDelay * item.retries);
            } else {
                failed++;
                carryOnFailure(item.target);
                console.log(`FAIL gave up after ${args.max429Retries} rate-limit retries | ${item.target.innerUrl} (left as-is)`);
            }
            continue;
        }
        if (outcome.kind === 'error') {
            failed++;
            carryOnFailure(item.target);
            console.log(`SLOW FAIL ${outcome.message} | ${item.target.innerUrl} (left as-is)`);
            continue;
        }
        const batch = storeOutcome(item.target, outcome.hops);
        if (batch.wroteTarget) {
            ok++;
            console.log(`SLOW OK ${batch.lastStatus} ${item.target.innerUrl}`);
        } else if (batch.records.length > 0) {
            shifted++;
            carryOnFailure(item.target);
            console.log(`SLOW SHIFT ${batch.lastStatus} ${item.target.innerUrl} (no capture at ${item.target.ts14}; nearest capture stored at ${batch.lastTs14}) (left as-is)`);
        } else if (batch.skippedAlreadyStored > 0) {
            shifted++;
            carryOnFailure(item.target);
            console.log(`SLOW SHIFT ${item.target.innerUrl} (no capture at ${item.target.ts14}; nearest capture already in the archive at ${batch.alreadyStoredTs14}) (left as-is)`);
        } else {
            failed++;
            carryOnFailure(item.target);
            console.log(`SLOW SKIP ${item.target.innerUrl} (no historical capture) (left as-is)`);
        }
        await sleep(args.rateLimitDelay);
    }

    kept.sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));

    // Carried records are deduped by URL + timestamp: a URL captured several
    // times keeps every capture. The set guards both against the output (so a
    // re-run appends only new captures) and against a URL that appears twice in
    // `carried` (a replay record carried on failure can coincide with the
    // successful-restore flow).
    const seenCarried = new Set<string>();
    const carriedToWrite = carried.filter((c) => {
        const key = `${c.url}\t${c.ts}`;
        if (existingCarriedKeys.has(key)) return false;
        if (seenCarried.has(key)) return false;
        seenCarried.add(key);
        return true;
    });
    carriedToWrite.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // `--drop-unrestored` produces a historical-only archive: unrestored
    // Wayback replay records are omitted, while non-replay content is still
    // carried as-is. The input remains the lossless source.
    const finalCarried = args.dropUnrestored
        ? carriedToWrite.filter((c) => parseWaybackUrl(c.url) === null)
        : carriedToWrite;
    const droppedReplay = carriedToWrite.length - finalCarried.length;
    const droppedNote = droppedReplay > 0 ? `, ${droppedReplay} unrestored replay record(s) dropped` : '';

    console.log(`\n${ok} restored, ${shifted} shifted to their real capture time, ${failed} skipped, ${finalCarried.length} carried over${droppedNote}`);

    if (kept.length === 0 && finalCarried.length === 0 && (!existing || (args.title === undefined && !args.dropUnrestored))) {
        if (existing) {
            console.log('Nothing new to add: the output already holds every record these snapshots produced.');
            return;
        }
        console.error('Nothing to restore.');
        process.exit(1);
    }

    // Snapshots restored this run, so dropStaleCarried can prune their stale
    // carried wayback records from the existing output (B2).
    const restoredSnapKeys = new Set(kept.map((r) => snapshotKey(r.innerUrl, r.ts17.slice(0, 14))));

    writeOutput({
        outputFile: args.outputFile,
        title,
        existing,
        kept,
        pages: keptPages,
        carried: finalCarried,
        restoredSnapKeys,
        dropUnrestored: args.dropUnrestored,
    });

    console.log('\n=== Done ===');
    console.log('Wrote ' + args.outputFile);
}

// Run only when executed directly (not when imported by a test).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
    main().catch((e) => {
        console.error('Fatal:', e);
        process.exit(1);
    });
}
