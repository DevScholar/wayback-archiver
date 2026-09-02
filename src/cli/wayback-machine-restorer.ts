/**
 * wayback-machine-restorer.ts
 *
 * Converts a WACZ that captured the *Wayback Machine replaying* old pages back
 * into a WACZ that looks like the pages were captured directly, in the past.
 *
 * When ArchiveWeb.page crawls `https://web.archive.org/web/<ts>/http://host/...`
 * it archives two very different things side by side:
 *
 *   1. the replayed page, wrapped in Wayback's own chrome (top toolbar, donation
 *      banner, analytics, `wombat.js`, `bundle-playback.js`, ...), with every URL
 *      rewritten to a `/web/<ts>[mod_]/<original-url>` route; and
 *   2. the same page's resources, each served through an `im_`/`cs_`/`js_`
 *      modifier route and, when the Wayback Machine has no capture at the
 *      requested time, 302-redirected to the nearest *later* capture.
 *
 * This tool inverts both of those transforms:
 *
 *   - it drops every record hosted on `*.archive.org` (the Wayback chrome),
 *     keeping only the real, third-party content;
 *   - it unwraps `/web/<ts>[mod_]/<url>` (and the absolute
 *     `https://web.archive.org/web/<ts>[mod_]/<url>` form) back to `<url>`;
 *   - it strips the injected `<head>` scripts, the toolbar, and the trailing
 *     "FILE ARCHIVED ON ..." footer from HTML;
 *   - it follows 302 redirect chains and WARC `revisit` references to the final
 *     record, then stamps that record with the *actual* capture time (the final
 *     URL's timestamp / `x-archive-orig-date`), not the requested replay time;
 *   - it restores the historical HTTP headers from `X-Archive-Orig-*`.
 *
 * Every record that Wayback actually served is kept verbatim -- including empty
 * bodies, error pages, and tiny stubs. If the era's server really sent it, it is
 * historical material and belongs in the archive.
 *
 * Usage:
 *   npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { ZipReader } from '../archive/zip';
import { writeZipFile } from '../archive/zip-writer';
import { buildWarcRecord, payloadDigest } from '../archive/warc-writer';
import { parseWarcRecord, WarcRecord } from '../archive/warc';
import { parseCdxj, CdxjEntry } from '../archive/cdxj';
import { surtKey } from '../lib/url';
import { cdxjTsToRfc3339 } from '../lib/time';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
    input: string;
    outputFile: string;
    title?: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { input: '', outputFile: '' };
    const positional: string[] = [];
    for (const a of argv) {
        const eq = a.indexOf('=');
        const key = eq >= 0 ? a.slice(0, eq) : a;
        const val = eq >= 0 ? a.slice(eq + 1) : '';
        if (key === '--output-file') args.outputFile = val;
        else if (key === '--title') args.title = val;
        else if (!a.startsWith('--')) positional.push(a);
    }
    if (positional.length > 0) args.input = path.resolve(positional[0]);
    if (!args.input) {
        console.error('Usage: npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>]');
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

/** A parsed Wayback replay URL: `https://web.archive.org/web/<ts><mod>/<inner>`. */
interface WaybackUrl {
    /** 14-digit capture timestamp from the URL path. */
    ts14: string;
    /** The modifier (`im_`, `cs_`, `js_`, `id_`) or '' for a page. */
    modifier: string;
    /** The inner, original URL (percent-decoded). */
    innerUrl: string;
}

const WAYBACK_URL_RE = /^https:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i;

/** Decode a percent-encoded inner URL; fall back to the raw string. */
function decodeInnerUrl(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** Parse a Wayback replay URL, or null if `url` is not one. */
function parseWaybackUrl(url: string): WaybackUrl | null {
    const m = WAYBACK_URL_RE.exec(url);
    if (!m) return null;
    return {
        ts14: m[1].slice(0, 14),
        modifier: (m[2] || '').toLowerCase(),
        innerUrl: decodeInnerUrl(m[3]),
    };
}

/** True when a host belongs to the Wayback chrome we want to discard. */
function isArchiveOrgHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return h === 'archive.org' || h.endsWith('.archive.org');
}

/** The lowercased host of a URL ('' when unparseable). */
function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Body transformation
// ---------------------------------------------------------------------------

/** Unwrap `%3A` back to `:` in an inner URL (the scheme separator Wayback
 * percent-encodes); leave all other percent-encoding untouched. */
function unescapeScheme(s: string): string {
    return s.replace(/%3a/gi, ':');
}

/** Unwrap a Wayback replay URL written as either a bare `/web/<ts>[mod]/<url>`
 * route or the absolute `https://web.archive.org/web/<ts>[mod]/<url>` form back
 * to its inner `<url>`, or null when `raw` is not one. */
function unwrapWaybackUrl(raw: string): string | null {
    const rel = /^\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(raw);
    if (rel) return decodeInnerUrl(unescapeScheme(rel[2]));
    const abs = parseWaybackUrl(raw);
    return abs ? abs.innerUrl : null;
}

/** Regex for a Wayback-rewritten URL in text: either the bare `/web/<ts>[mod]/...`
 * route or the absolute `[scheme://]web.archive.org/web/<ts>[mod]/...` form. */
const WB_TEXT_URL_RE =
    /(?:(?:https?:)?\/\/web\.archive\.org)?\/web\/(\d{4,14})(?:[a-z]{2}_)?\/([^"'<>\s)]+)/gi;

/** Reverse a Wayback rewrite inside text (HTML/CSS/JS bodies): `/web/<ts>[mod]/<url>`
 * (or its absolute form) collapses back to `<url>`. */
function reverseRewriteText(text: string): string {
    return text.replace(WB_TEXT_URL_RE, (_m, _ts: string, inner: string) => unescapeScheme(inner));
}

/** Strip the three Wayback-injected regions from an HTML document. */
function stripWaybackChrome(html: string): string {
    let out = html;

    // 1. The <head> injections (athena/bundle-playback/wombat/ruffle scripts,
    //    the __wm.init/__wm.wombat block, banner styles) run from after <head>
    //    up to the end-rewrite marker. Cut them, keeping <head> and <title>.
    const endMarker = '<!-- End Wayback Rewrite JS Include -->';
    const mi = out.indexOf(endMarker);
    if (mi >= 0) {
        const headOpen = out.search(/<head[^>]*>/i);
        if (headOpen >= 0) {
            const headEnd = out.indexOf('>', headOpen) + 1;
            if (headEnd > 0 && headEnd < mi) {
                out = out.slice(0, headEnd) + out.slice(mi + endMarker.length);
            }
        }
    }

    // 2. The top toolbar, bounded by its own begin/end markers.
    const begin = '<!-- BEGIN WAYBACK TOOLBAR INSERT -->';
    const end = '<!-- END WAYBACK TOOLBAR INSERT -->';
    const bi = out.indexOf(begin);
    const ei = out.indexOf(end);
    if (bi >= 0 && ei >= bi) {
        out = out.slice(0, bi) + out.slice(ei + end.length);
    }

    // 3. The trailing "FILE ARCHIVED ON ..." + "playback timings" comments sit
    //    after </html>; truncate there.
    const he = out.search(/<\/html>/i);
    if (he >= 0) out = out.slice(0, he + 7);

    // 4. Some resources (ASP endpoints that emit CSS/JS) get the footer appended
    //    as a CSS/JS block comment instead of after </html>. Truncate at the
    //    comment opener in either form.
    out = stripWaybackFooter(out);

    return out;
}

/**
 * Strip the Wayback "FILE ARCHIVED ON ..." + "playback timings" footer that is
 * appended to every replayed response. It appears as an HTML comment after
 * `</html>`, or as a CSS/JS block comment when the resource is a stylesheet or
 * script (including ASP endpoints mislabeled text/html). Truncate at the comment
 * opener in either form; nothing of historical value follows it.
 */
function stripWaybackFooter(text: string): string {
    const foot = text.search(/(?:<!--|\/\*)\s*FILE ARCHIVED ON/i);
    return foot >= 0 ? text.slice(0, foot) : text;
}

// ---------------------------------------------------------------------------
// Header restoration
// ---------------------------------------------------------------------------

/** Wayback chrome headers that must never leak into a restored record. */
const WAYBACK_DROP_HEADERS = new Set([
    'x-dns-prefetch-control',
    'content-security-policy',
    'permissions-policy',
    'referrer-policy',
    'server-timing',
    'memento-datetime',
    'link',
    'x-app-server',
    'x-archive-guessed-charset',
    'x-archive-guessed-content-type',
    'x-archive-redirect-reason',
    'x-archive-src',
    'x-as',
    'x-location',
    'x-na',
    'x-nid',
    'x-page-cache',
    'x-rl',
    'x-sd',
    'x-tr',
    'x-ts',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length', // recomputed from the (possibly transformed) body
    'content-encoding', // the archived body is decoded; the original claim is stale
]);

const ORIG_HEADER_PREFIX = 'x-archive-orig-';

/**
 * Rebuild the HTTP headers of a restored record so they read as if the era's
 * server had answered directly, not Wayback's 2026 replay frontend.
 *
 * Wayback folds the *historical* response headers under `X-Archive-Orig-<Name>`
 * (`x-archive-orig-server: Microsoft-IIS/4.0`, `x-archive-orig-date: Thu, 18
 * Feb 1999 12:51:17 GMT`, ...) while serving its own modern headers on the same
 * response (`server: nginx`, `cache-control: max-age=1800`, `date: Mon, 31 Aug
 * 2026 ...`, CSP, permissions-policy, ...). When those historical headers are
 * present they ARE the real response headers -- reconstruct from them alone and
 * discard every replay header, so a modern replay artifact can never leak into
 * the restored record.
 *
 * When a record carries no `X-Archive-Orig-*` (a directly-captured resource),
 * its own headers are already historical -- keep them, dropping only the
 * framing that the writer recomputes.
 */
function restoreHeaders(record: WarcRecord, fallbackMime: string, body: Buffer): [string, string][] {
    const result: [string, string][] = [];
    const seen = new Set<string>();
    const push = (name: string, value: string) => {
        const lower = name.toLowerCase();
        if (seen.has(lower)) return;
        seen.add(lower);
        result.push([name, value]);
    };

    // Framing headers describe the wire bytes: `content-encoding`/`transfer-
    // encoding` are stale (the body is stored decoded), and `content-length`
    // is only trustworthy when the body still matches it (untransformed).
    const isStaleFraming = (name: string) =>
        name === 'content-encoding' || name === 'transfer-encoding';

    const hasOrig = [...record.httpHeaders.keys()].some((n) =>
        n.startsWith(ORIG_HEADER_PREFIX),
    );

    if (hasOrig) {
        // Reconstruct from the historical headers alone.
        for (const [name, value] of record.httpHeaders) {
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
        // Direct capture: keep the record's own headers, minus any Wayback
        // chrome that still tags along and minus recomputed framing.
        for (const [name, value] of record.httpHeaders) {
            const lower = name.toLowerCase();
            if (lower.startsWith(ORIG_HEADER_PREFIX)) continue;
            if (WAYBACK_DROP_HEADERS.has(lower)) continue;
            if (isStaleFraming(lower) || lower === 'content-length') continue;
            push(name, value);
        }
    }

    // content-type: an explicit historical value already won above; otherwise
    // the resolved mime (charset already stripped) is the faithful fallback.
    if (!seen.has('content-type')) push('content-type', fallbackMime || 'application/octet-stream');

    return result;
}

// ---------------------------------------------------------------------------
// Kind detection (what body rewrite a resource needs)
// ---------------------------------------------------------------------------

type ContentKind = 'html' | 'css' | 'js' | 'binary';

const EXT_TO_MIME: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.asp': 'text/html', '.aspx': 'text/html',
    '.php': 'text/html', '.cfm': 'text/html', '.cgi': 'text/html', '.jsp': 'text/html',
    '.shtml': 'text/html', '.css': 'text/css', '.js': 'application/x-javascript',
    '.mjs': 'application/x-javascript', '.gif': 'image/gif', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.webp': 'image/webp',
};

function extensionOf(url: string): string {
    try {
        const p = new URL(url).pathname;
        const i = p.lastIndexOf('.');
        return i < 0 ? '' : p.slice(i).toLowerCase();
    } catch {
        return '';
    }
}

/** URL extensions that name a navigable document (a "page"), as opposed to a
 * subresource. Used to decide what belongs on the index; a resource whose
 * extension is a page type is a page, everything else (images, css, js, ...) is
 * not -- even when the server answered it with an HTML error page. */
const PAGE_EXTENSIONS = new Set([
    '.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml',
]);

/**
 * True when a URL names a page rather than a subresource. Deliberately based on
 * the *extension*, not the response mime: a `.gif` that Microsoft answered with
 * a "Sorry, there is no ..." HTML error page is still an image *location*, not a
 * page to list on the index. Extensionless URLs (`/`, `/mscorp/`) count as pages.
 */
function isPageUrl(url: string): boolean {
    const ext = extensionOf(url);
    return ext === '' || PAGE_EXTENSIONS.has(ext);
}

function classifyKind(modifier: string, mime: string, innerUrl: string): ContentKind {
    // The response's own content-type is authoritative -- the modifier only
    // records *how the page referenced* the resource (via an <img>, <link>,
    // <script>). An error page (404, 500, ...) is served as HTML even when it
    // was referenced as an image, so `im_` must not force `binary` there:
    // that would leave Wayback's chrome on the error page and write it out as
    // a binary blob. Check mime first, fall back to modifier + extension.
    const m = (mime || '').toLowerCase();
    if (/html/.test(m)) return 'html';
    if (/css/.test(m)) return 'css';
    if (/javascript|ecmascript/.test(m)) return 'js';
    if (/image|audio|video|font/.test(m)) return 'binary';

    if (modifier === 'im_' || modifier === 'id_') return 'binary';
    if (modifier === 'cs_') return 'css';
    if (modifier === 'js_') return 'js';
    if (modifier === '') return 'html';

    const ext = extensionOf(innerUrl);
    if (['.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml', '.svg'].includes(ext)) return 'html';
    if (ext === '.css') return 'css';
    if (ext === '.js' || ext === '.mjs') return 'js';
    return 'binary';
}

/** The mime to record, preferring the archive's own, else the extension table. */
function resolveMime(record: WarcRecord, cdxMime: string, innerUrl: string, kind: ContentKind): string {
    const ct = record.httpHeaders.get('content-type');
    if (ct && ct.trim() && !/^\s*text\/html\s*;?\s*$/.test(ct) && !/undefined/.test(ct)) {
        return ct.split(';')[0].trim();
    }
    if (cdxMime && cdxMime !== 'warc/revisit' && cdxMime.trim()) return cdxMime.split(';')[0].trim();
    if (kind === 'html') return 'text/html';
    if (kind === 'css') return 'text/css';
    if (kind === 'js') return 'application/x-javascript';
    return EXT_TO_MIME[extensionOf(innerUrl)] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

/** The final, content-bearing record for a target, after following 302 redirects
 * and WARC `revisit` references. */
interface Resolved {
    record: WarcRecord | null;
    finalUrl: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function resolveChain(
    targetUrl: string,
    byTarget: Map<string, WarcRecord>,
): Resolved {
    let cur = targetUrl;
    for (let hop = 0; hop < 12; hop++) {
        const rec = byTarget.get(cur);
        if (!rec) return { record: null, finalUrl: cur };

        const status = rec.httpStatus;

        // Redirect first: the `location` header is the authoritative "where the
        // capture actually lives". A redirect response whose body was deduped
        // (a `revisit` with an empty body) still carries its status + location
        // and must follow the location, NOT the revisit's refers-to (which, for
        // empty-body dedup, points at an unrelated empty record).
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

        // Deduplication: a revisit (non-redirect) record has no body; follow
        // the original record that holds it.
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

// ---------------------------------------------------------------------------
// Redirect notices
// ---------------------------------------------------------------------------

/**
 * Wayback records a *real* historical redirect (the era's server returned a
 * 3xx) not as a 3xx record but as a "redirect notice" interstitial -- a 200
 * HTML page that immediately navigates the browser to the target. Two forms
 * show up in practice:
 *
 *   1. `<script>document.location.href = "/web/<ts>/<target>";</script>`
 *   2. `<meta http-equiv="refresh" content="0; URL=/web/<ts>/<target>">`
 *
 * Both wrap the target in a `/web/<ts>/<target>` replay route. Detect either
 * and return the unwrapped inner target URL, or null when the record is not a
 * redirect notice. Converting these back to real 3xx records (rather than
 * keeping the interstitial chrome) is what turns `referral/default.asp` into a
 * 302 instead of a page with no title.
 */
function extractRedirectNotice(record: WarcRecord): string | null {
    if (record.httpStatus !== 200) return null;
    const body = record.body.toString('latin1');

    // 1. JavaScript redirect: document.location.href = "<wayback target>".
    const js = /document\.location\.href\s*=\s*["']([^"']+)["']/i.exec(body);
    if (js) {
        const t = unwrapWaybackUrl(js[1]);
        if (t) return t;
    }

    // 2. meta-refresh redirect: content="...; URL=<wayback target>".
    const metaRe = /<meta\b[^>]*>/gi;
    let tag: RegExpExecArray | null;
    while ((tag = metaRe.exec(body)) !== null) {
        if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag[0])) continue;
        const cm = /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag[0]);
        if (!cm) continue;
        // `URL=` is the last field of the content value; take everything after
        // it to the end. Do NOT split on `;`: `&amp;` ends in a semicolon and
        // would truncate the query string there.
        const urlm = /URL\s*=\s*([\s\S]*)$/i.exec(cm[1]);
        if (!urlm) continue;
        const t = unwrapWaybackUrl(urlm[1].replace(/&amp;/gi, '&').trim());
        if (t) return t;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface KeptRecord {
    innerUrl: string;
    ts17: string;
    kind: ContentKind;
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

function httpDateToTs14(value: string): string | null {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number, w: number) => String(n).padStart(w, '0');
    return (
        p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) +
        p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2)
    );
}

/** Best-guess the actual capture time of a resolved record: the final URL's
 * timestamp when it is still a Wayback URL, else `x-archive-orig-date`. */
function resolveCaptureTs14(wayback: WaybackUrl, finalUrl: string, record: WarcRecord | null): string {
    const fm = WAYBACK_URL_RE.exec(finalUrl);
    if (fm) return fm[1].slice(0, 14);
    if (record) {
        const origDate = record.httpHeaders.get('x-archive-orig-date');
        if (origDate) {
            const ts = httpDateToTs14(origDate);
            if (ts) return ts;
        }
    }
    return wayback.ts14;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const zip = ZipReader.open(args.input);
    const names = zip.names();

    // Locate the index and WARC entries.
    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    const warcName = names.find((n) => n.endsWith('.warc') || n.endsWith('.warc.gz'));
    if (!indexName || !warcName) {
        console.error('Not a WACZ (missing CDX index or WARC).');
        process.exit(1);
    }

    // Warn about entries we will not carry across.
    const KNOWN = new Set([
        'datapackage.json', 'datapackage-digest.json', 'pages/pages.jsonl',
        'archive/data.warc.gz', 'indexes/index.cdx', 'pages/pages.jsonl',
    ]);
    for (const n of names) {
        if (!KNOWN.has(n)) console.log(`note: dropping extra archive entry: ${n}`);
    }

    let title = args.title ?? 'Web Archive';
    let origPages = '';
    try {
        const dp = JSON.parse(zip.readEntry('datapackage.json').toString('utf8'));
        if (typeof dp.title === 'string' && !args.title) title = dp.title + ' (restored)';
    } catch {
        /* optional */
    }
    try {
        origPages = zip.readEntry('pages/pages.jsonl').toString('utf8');
    } catch {
        /* optional */
    }

    // Original page title, keyed by the Wayback URL (for carrying titles over).
    const titleByWaybackUrl = new Map<string, string>();
    for (const line of origPages.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        if (typeof obj.url === 'string' && typeof obj.title === 'string') {
            titleByWaybackUrl.set(obj.url, obj.title);
        }
    }

    // Read every CDXJ entry, dedup by URL, and build target -> record. The CDXJ
    // `filename` is a basename ("data.warc.gz"); resolve it to the full ZIP path.
    const warcEntries = new Map<string, string>();
    for (const n of names) {
        const base = n.split('/').pop();
        if (base && (base.endsWith('.warc') || base.endsWith('.warc.gz'))) {
            warcEntries.set(base, n);
        }
    }

    const entries = parseCdxj(zip.readEntry(indexName).toString('utf8'));
    const byTarget = new Map<string, WarcRecord>();
    const seenUrl = new Set<string>();
    const uniqueEntries: CdxjEntry[] = [];
    for (const e of entries) {
        if (seenUrl.has(e.url)) continue;
        seenUrl.add(e.url);
        uniqueEntries.push(e);
        try {
            const zipName = warcEntries.get(e.filename) || e.filename;
            const raw = zip.storedRange(zipName, e.offset, e.length);
            const inflated = zlib.gunzipSync(raw);
            const rec = parseWarcRecord(inflated);
            if (!byTarget.has(e.url)) byTarget.set(e.url, rec);
        } catch (err) {
            console.log(`warn: could not read record for ${e.url}: ${(err as Error).message}`);
        }
    }

    // Classify and keep.
    const kept: KeptRecord[] = [];
    const keptPages: Record<string, unknown>[] = [];
    const dedup = new Set<string>();

    for (const e of uniqueEntries) {
        let innerUrl: string;
        let wayback: WaybackUrl | null = null;

        const wb = parseWaybackUrl(e.url);
        if (wb) {
            wayback = wb;
            innerUrl = wb.innerUrl;
        } else {
            innerUrl = e.url;
        }

        // Drop Wayback chrome and any other archive.org-hosted resource.
        if (isArchiveOrgHost(hostOf(innerUrl))) continue;

        // A 3xx response is Wayback's own replay redirect -- either a time-shift
        // ("found a capture at a later/earlier time") or a case/canonical
        // redirect to another capture URL. It is NOT the era's server
        // responding; the era's real redirects were captured as 200 "redirect
        // notice" interstitials (handled below). But the redirect's `location`
        // still records where the real capture lives -- often under a
        // differently-cased path or a www/bare host name. When that target is a
        // *different* URL, carry the redirect over as a 302 so the source URL
        // resolves (archiveweb.page follows it) instead of 404ing. A
        // self-redirect (a pure time-shift to the same URL) is dropped: the
        // era's capture at the shifted time already covers the source URL.
        const own = byTarget.get(e.url);
        if (own && own.httpStatus !== null && REDIRECT_STATUS.has(own.httpStatus)) {
            const loc = own.httpHeaders.get('location');
            const target = loc ? unwrapWaybackUrl(loc) : null;
            if (target && target !== innerUrl && !isArchiveOrgHost(hostOf(target))) {
                const ts14 = wayback
                    ? wayback.ts14
                    : (httpDateToTs14(own.date || '') ?? e.timestamp.slice(0, 14));
                const ts17 = (ts14 + '000').slice(0, 17);
                // One redirect per source URL: the crawl replays the same URL at
                // several request times, each producing the same time-shift 302 to
                // the same canonical capture. Keep the first (earliest, since the
                // CDXJ is timestamp-ordered) and drop the rest.
                const dedupKey = innerUrl;
                if (!dedup.has(dedupKey)) {
                    dedup.add(dedupKey);
                    kept.push({
                        innerUrl,
                        ts17,
                        kind: 'html',
                        mime: 'text/html',
                        status: own.httpStatus,
                        statusText: own.httpStatusText || '',
                        headers: [['location', target], ['content-type', 'text/html']],
                        body: Buffer.alloc(0),
                    });
                    console.log(`redirect (wayback): ${innerUrl} -> ${target}`);
                }
            } else {
                console.log(`skip: wayback redirect (${own.httpStatus}) for ${innerUrl}`);
            }
            continue;
        }

        const resolved = resolveChain(e.url, byTarget);
        if (!resolved.record) {
            console.log(`skip: no record for ${innerUrl}`);
            continue;
        }
        const status = resolved.record.httpStatus ?? 200;

        // A Wayback "redirect notice" interstitial (a 200 HTML page that
        // immediately navigates to the real target) is the era's server's
        // redirect in disguise. Restore it as a 302 record stamped at the
        // *request* time, so it stays a redirect instead of surfacing on the
        // index as a page with no title.
        const notice = extractRedirectNotice(resolved.record);
        if (notice) {
            const noticeTs14 = wayback
                ? wayback.ts14
                : (httpDateToTs14(resolved.record.date || '') ?? e.timestamp.slice(0, 14));
            const noticeTs17 = (noticeTs14 + '000').slice(0, 17);
            const dedupKey = innerUrl + ' ' + noticeTs14;
            if (dedup.has(dedupKey)) continue;
            dedup.add(dedupKey);
            kept.push({
                innerUrl,
                ts17: noticeTs17,
                kind: 'html',
                mime: 'text/html',
                status: 302,
                statusText: 'Found',
                headers: [['location', notice], ['content-type', 'text/html']],
                body: Buffer.alloc(0),
            });
            console.log(`redirect: ${innerUrl} -> ${notice}`);
            continue;
        }

        const ts14 = wayback
            ? resolveCaptureTs14(wayback, resolved.finalUrl, resolved.record)
            : (httpDateToTs14(resolved.record.date || '') ?? e.timestamp.slice(0, 14));
        const ts17 = (ts14 + '000').slice(0, 17);
        const dedupKey = innerUrl + ' ' + ts14;
        if (dedup.has(dedupKey)) continue;
        dedup.add(dedupKey);

        const kind = classifyKind(wayback ? wayback.modifier : '', e.mime, innerUrl);
        const mime = resolveMime(resolved.record, e.mime, innerUrl, kind);

        let body = resolved.record.body;
        if (kind === 'html') {
            const text = stripWaybackChrome(reverseRewriteText(body.toString('latin1')));
            body = Buffer.from(text, 'latin1');
        } else if (kind === 'css' || kind === 'js') {
            body = Buffer.from(stripWaybackFooter(reverseRewriteText(body.toString('latin1'))), 'latin1');
        }

        const headers = restoreHeaders(resolved.record, mime, body);

        kept.push({
            innerUrl,
            ts17,
            kind,
            mime,
            status,
            statusText: resolved.record.httpStatusText || '',
            headers,
            body,
        });

        if (isPageUrl(innerUrl)) {
            keptPages.push({
                url: innerUrl,
                ts: cdxjTsToRfc3339(ts17),
                title: titleByWaybackUrl.get(e.url) || innerUrl,
            });
        }
    }

    kept.sort((a, b) => (a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0));

    console.log(`\nKept ${kept.length} records (${keptPages.length} pages).`);

    if (kept.length === 0) {
        console.error('Nothing to restore.');
        process.exit(1);
    }

    // Serialize records: one gzip member each, accumulating compressed offsets.
    const warcParts: Buffer[] = [];
    const indexLines: string[] = [];
    let offset = 0;
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
        indexLines.push(
            `${surtKey(r.innerUrl)} ${r.ts17} ${JSON.stringify({
                url: r.innerUrl,
                digest: payloadDigest(r.body),
                mime: r.mime,
                offset,
                length: member.length,
                status: r.status,
                filename: 'data.warc.gz',
            })}`,
        );
        offset += member.length;
    }
    const warcGz = Buffer.concat(warcParts);

    const cdx = Buffer.from(indexLines.sort().join('\n') + '\n', 'utf-8');
    const pages = Buffer.from(
        [{ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }, ...keptPages]
            .map((o) => JSON.stringify(o))
            .join('\n') + '\n',
        'utf-8',
    );

    const nowIso = new Date().toISOString();
    const dp = {
        profile: 'data-package',
        wacz_version: '1.1.1',
        software: 'wayback-archiver / wayback-machine-restorer',
        created: nowIso,
        title,
        modified: nowIso,
        resources: [
            resource('pages.jsonl', 'pages/pages.jsonl', pages),
            resource('data.warc.gz', 'archive/data.warc.gz', warcGz),
            resource('index.cdx', 'indexes/index.cdx', cdx),
        ],
    };
    const datapackageBuf = Buffer.from(JSON.stringify(dp, null, 2) + '\n', 'utf-8');
    const digestJson = {
        path: 'datapackage.json',
        hash: 'sha256:' + crypto.createHash('sha256').update(datapackageBuf).digest('hex'),
    };

    writeZipFile(args.outputFile, [
        { name: 'datapackage.json', data: datapackageBuf, method: 'deflate' },
        { name: 'datapackage-digest.json', data: Buffer.from(JSON.stringify(digestJson, null, 2) + '\n', 'utf-8'), method: 'deflate' },
        { name: 'pages/pages.jsonl', data: pages, method: 'deflate' },
        { name: 'archive/data.warc.gz', data: warcGz, method: 'store' },
        { name: 'indexes/index.cdx', data: cdx, method: 'store' },
    ]);

    console.log('\n=== Done ===');
    console.log(`Wrote ${args.outputFile}`);
}

main();
