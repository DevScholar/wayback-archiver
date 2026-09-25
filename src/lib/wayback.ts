/**
 * wayback.ts
 *
 * Wayback Machine replay-URL parsing and header restoration. The downloader
 * (`--wayback`) and the restorer both need to (a) unwrap a Wayback replay URL
 * to its `id_` identity form and inner URL, and (b) rebuild a captured
 * response's headers as if the era's server had answered directly, discarding
 * the modern replay frontend's framing. These live here so both CLI tools share
 * one implementation.
 */

/** A parsed Wayback replay URL: `https://web.archive.org/web/<ts>[mod_]/<url>`. */
export interface WaybackTarget {
    /** 14-digit capture timestamp from the URL path. */
    ts14: string;
    /** The replay modifier (`im_`, `cs_`, `js_`, `id_`) or '' for a page. */
    modifier: string;
    /** The inner, original URL the capture is of (percent-decoded). */
    innerUrl: string;
    /** The `id_` replay URL that serves the capture's original bytes verbatim. */
    idUrl: string;
}

export const WAYBACK_URL_RE = /^https:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i;

/**
 * Parse a Wayback replay URL into its capture timestamp, modifier, and inner
 * URL, and rewrite it to the `id_` form that serves the original bytes with no
 * link rewriting and no chrome. Returns null when `url` is not a Wayback replay
 * URL.
 *
 * The `id_` modifier is the identity route: unlike the `im_`/`cs_`/`js_` (and
 * bare) routes, which Wayback rewrites for replay, `id_` returns the archived
 * bytes exactly as captured -- the only route from which a byte-for-byte
 * faithful copy can be recovered.
 */
export function parseWaybackUrl(url: string): WaybackTarget | null {
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

/** Wayback replay headers that must never leak into a faithfully restored
 * record: the replay frontend's own framing and policy headers. */
export const WAYBACK_DROP_HEADERS = new Set([
    'x-dns-prefetch-control', 'content-security-policy', 'permissions-policy',
    'referrer-policy', 'server-timing', 'memento-datetime', 'link',
    'x-app-server', 'x-archive-guessed-charset', 'x-archive-guessed-content-type',
    'x-archive-redirect-reason', 'x-archive-src', 'x-as', 'x-location', 'x-na',
    'x-nid', 'x-page-cache', 'x-rl', 'x-sd', 'x-tr', 'x-ts',
    'connection', 'keep-alive', 'transfer-encoding',
    'content-length', 'content-encoding',
]);

export const ORIG_HEADER_PREFIX = 'x-archive-orig-';

/**
 * Rebuild an `id_` response's headers as if the era's server had answered
 * directly. Wayback folds the historical headers under `X-Archive-Orig-<Name>`
 * while serving its own modern headers on the same response; reconstruct from
 * those alone when present, otherwise keep the response's own headers minus the
 * replay framing. `content-length` is only kept when it still matches the body;
 * `content-encoding`/`transfer-encoding` are always dropped (the body is stored
 * decoded). `mime` is the fallback `content-type` when nothing declares one.
 */
export function restoreWaybackHeaders(headers: [string, string][], mime: string, body: Buffer): [string, string][] {
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

/** Screenshot record URNs (`urn:thumbnail:`, `urn:view:`) have no `id_` form
 * and are dropped when restoring a Wayback capture. */
export const URN_SCREENSHOT_RE = /^urn:(thumbnail|view):/i;

export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function isArchiveOrgHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return h === 'archive.org' || h.endsWith('.archive.org');
}
