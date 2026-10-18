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

/**
 * True when a redirect's `location` names a Wayback playback URL rather than a
 * URL the era's server sent.
 *
 * Wayback answers a timestamp it has no capture for with a redirect to the
 * nearest capture, and it writes that redirect itself, in its own
 * `/web/<ts>[mod_]/<url>` form. That redirect is retrieval scaffolding from the
 * replay frontend, not historical material: the old server never sent it, and
 * its target is another Wayback URL. A restorer follows it to reach the bytes,
 * but must not archive it as if it were a redirect from the past.
 *
 * A relative location is resolved against the URL that answered it, since
 * `/web/...` is relative to `https://web.archive.org/`.
 */
export function isPlaybackRedirect(location: string, baseUrl: string): boolean {
    let resolved: string;
    try {
        resolved = new URL(location, baseUrl).href;
    } catch {
        resolved = location;
    }
    if (parseWaybackUrl(resolved)) return true;
    try {
        const parsed = new URL(resolved);
        return isArchiveOrgHost(parsed.hostname) && parsed.pathname.startsWith('/web/');
    } catch {
        return false;
    }
}

/** Largest body scanned for Wayback's error-page title. The real page is a few
 * kilobytes; the cap keeps a huge archived document from being scanned. */
const WAYBACK_ERROR_PAGE_SCAN_LIMIT = 256 * 1024;

/**
 * True when a response is Wayback's own error page instead of an archived
 * capture. Wayback serves that page (title "Wayback Machine") when it has no
 * capture for a URL, and it comes with Wayback's 2026 headers, not the
 * historical `X-Archive-Orig-*` ones. Archiving it would put the 2026 replay
 * frontend into the restored archive under an old URL, so the restorer treats
 * such a response as a failed fetch and leaves the input record untouched.
 */
export function isWaybackErrorPage(status: number, headers: [string, string][], body: Buffer): boolean {
    if (status < 400) return false;
    if (body.length === 0 || body.length > WAYBACK_ERROR_PAGE_SCAN_LIMIT) return false;
    if (headers.some(([name]) => name.toLowerCase().startsWith(ORIG_HEADER_PREFIX))) return false;
    return /<title>\s*Wayback Machine\s*<\/title>/i.test(body.toString('latin1'));
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
 * The historical target of an archived redirect. Wayback rewrites a captured
 * `Location` into a replay route (`/web/<ts>[mod_]/<url>`) but, unlike the
 * other headers, does not publish the original under `X-Archive-Orig-Location`,
 * so the target is read back out of the route. A location Wayback left
 * untouched is returned as-is.
 */
export function historicalLocation(location: string): string {
    const parsed = parseWaybackUrl(location);
    return parsed ? parsed.innerUrl : location;
}

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

        // Wayback rewrites a captured redirect's `Location` into its own replay
        // route and (unlike the other headers) does not publish the original
        // under `X-Archive-Orig-Location`. Read the historical target back out
        // of that route instead of dropping the redirect's destination.
        if (!seen.has('location')) {
            const rawLocation = headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
            if (rawLocation) push('location', historicalLocation(rawLocation));
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
