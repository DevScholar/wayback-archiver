/**
 * url.ts
 *
 * URL normalization and lookup-variant helpers. The CDXJ index is keyed by
 * exact URL, but an archived page may reference the same resource with a
 * slightly different hostname (`www.` vs bare) or scheme (`http` vs `https`).
 * We generate the small set of variants that WARC replay tools conventionally
 * try when an exact lookup misses.
 */

export interface ParsedUrl {
    protocol: string; // "http" | "https" | "ftp" | ...
    hostname: string; // lowercased
    port: string; // "" when absent
    pathname: string; // includes leading "/"
    search: string; // includes leading "?" when present
}

export function parseUrl(raw: string): ParsedUrl | null {
    try {
        const u = new URL(raw);
        return {
            protocol: u.protocol.replace(':', ''),
            hostname: u.hostname,
            port: u.port,
            pathname: u.pathname,
            search: u.search,
        };
    } catch {
        return null;
    }
}

/** Reassemble a canonical URL string from components. */
export function assembleUrl(p: ParsedUrl): string {
    let s = p.protocol + '://' + p.hostname;
    if (p.port) s += ':' + p.port;
    s += p.pathname || '/';
    if (p.search) s += p.search;
    return s;
}

/** Lowercase + drop fragment; a light normalization for building lookup keys. */
export function lookupKey(raw: string): string {
    let s = raw;
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    // Scheme and host are case-insensitive; path/query stay as-is.
    const p = parseUrl(s);
    if (!p) return s;
    return assembleUrl(p);
}

/**
 * Build a SURT (Sort-friendly URI Reordering Transform) search key from a URL,
 * matching the CDXJ spec: lowercase, strip scheme, reverse the hostname into
 * comma-separated labels, then a `)` separator and the path+query verbatim.
 *
 *   https://www.example.org/index.html  ->  org,example,www)/index.html
 *   https://noscript.net/theme.css?v=1  ->  net,noscript)/theme.css?v=1
 *
 * The port, when present and not the scheme default, is appended to the
 * hostname as `:port` before reversal (e.g. `net,noscript:8080)`).
 */
export function surtKey(raw: string): string {
    const p = parseUrl(raw);
    if (!p) return raw;
    let host = p.hostname;
    if (p.port) host += ':' + p.port;
    const reversed = host.split('.').reverse().join(',');
    let path = p.pathname;
    if (path === '') path = '/';
    return reversed + ')' + path + p.search;
}

/** Lookup key ignoring the query string and fragment: `scheme://host:port/path`.
 * Used as a fallback when the exact URL misses but the crawler captured the
 * same resource under a different query variant (e.g. an image requested at
 * `?w=400` archived only at `?w=1200&dpr=on,2`). */
export function lookupPathKey(raw: string): string {
    const p = parseUrl(raw);
    if (!p) return raw;
    return p.protocol + '://' + p.hostname + (p.port ? ':' + p.port : '') + (p.pathname || '/');
}

/**
 * Yield candidate URLs for a requested URL, ordered by how likely each is to
 * hit the index. `www.`/scheme alternates come last because they are less
 * precise than an exact match.
 */
export function lookupVariants(url: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (u: string) => {
        if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    };

    add(url);

    const p = parseUrl(url);
    if (!p) return out;

    const altHost = p.hostname.startsWith('www.')
        ? p.hostname.slice(4)
        : 'www.' + p.hostname;

    const altProto = p.protocol === 'http' ? 'https' : p.protocol === 'https' ? 'http' : p.protocol;

    add(assembleUrl({ ...p, hostname: altHost }));
    if (altProto !== p.protocol) {
        add(assembleUrl({ ...p, protocol: altProto }));
        add(assembleUrl({ ...p, protocol: altProto, hostname: altHost }));
    }

    // A leading `&` in the query (`?&x=y`) is an empty parameter and is
    // semantically identical to `?x=y`. Crawlers sometimes record the former
    // while pages reference the latter, so add the toggled form as a variant.
    for (const u of out.slice()) {
        add(toggleLeadingQueryAmp(u));
    }
    return out;
}

/** Toggle a leading `&` in the query string: `?&x=y` <-> `?x=y`. */
function toggleLeadingQueryAmp(url: string): string {
    const p = parseUrl(url);
    if (!p) return url;
    if (p.search.startsWith('?&')) {
        return assembleUrl({ ...p, search: '?' + p.search.slice(2) });
    }
    if (p.search.startsWith('?')) {
        return assembleUrl({ ...p, search: '?&' + p.search.slice(1) });
    }
    return url;
}

/** Directory default documents to try when a path ends in "/". */
export const DEFAULT_DOCS = [
    'index.html', 'index.htm', 'default.asp', 'default.aspx',
    'default.htm', 'default.html', 'default.shtml', 'index.shtml',
    'home.asp', 'home.html', 'main.html',
];

/**
 * Expand a requested URL into ordered candidate URLs, including the
 * directory-index and no-extension conventions replay uses.
 */
export function candidateUrls(url: string): string[] {
    const variants = lookupVariants(url);
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (u: string) => {
        if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    };

    for (const v of variants) {
        push(v);
        const p = parseUrl(v);
        if (!p) continue;

        const path = p.pathname;
        const clean = path.replace(/\/$/, '');

        if (path.endsWith('/') || path === '' || path === '/') {
            for (const doc of DEFAULT_DOCS) {
                push(assembleUrl({ ...p, pathname: clean + '/' + doc }));
            }
        }

        // A path with no extension is often stored as ".html"/".htm".
        if (!/\.[a-zA-Z0-9]{1,10}$/.test(path) && path !== '' && path !== '/') {
            push(assembleUrl({ ...p, pathname: path + '.html' }));
            push(assembleUrl({ ...p, pathname: path + '.htm' }));
        }
    }
    return out;
}
