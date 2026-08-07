/**
 * flatten.js
 *
 * Converts the web archive into a standalone format that can be browsed
 * directly from the filesystem (file:// protocol) without a server.
 *
 * Usage:
 *   node flatten.js --output-dir=<PATH> [--archive-dir=<PATH>] [--date=<YYYY[-MM][-DD]>]
 *
 * Options:
 *   --archive-dir=<PATH>  Archive directory. Defaults to config.json's currentSaveLocation.
 *   --output-dir=<PATH>   Output directory for the flattened archive. Required.
 *   --date=<YYYY[-MM][-DD]>  Preferred date for selecting snapshots.
 *                          When the same URL has multiple Wayback timestamps, the one
 *                          closest to this date is used. Defaults to today.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./common');

// ==========================================================================
// Argument Parsing
// ==========================================================================

function parseArgs() {
    const args = {};
    for (const arg of process.argv.slice(2)) {
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (match) {
            args[match[1]] = match[2];
        } else if (arg.startsWith('--')) {
            args[arg.slice(2)] = true;
        }
    }
    return args;
}

// ==========================================================================
// Helpers
// ==========================================================================

/** Extensions we treat as text (will have links rewritten). */
const TEXT_EXTENSIONS = new Set([
    '.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml',
    '.css', '.js', '.txt', '.xml', '.svg'
]);

/** HTML-like extensions (for Wayback injection cleanup). */
const HTML_EXTENSIONS = new Set([
    '.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml'
]);

// Extensions that browsers may not render as HTML under file://.
// We sniff the first bytes of the file to decide — a .asp can be CSS, JS, or image.
const NON_NATIVE_EXT = new Set([
    '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml'
]);

/**
 * Read up to `maxBytes` from the start of a file, as latin1.
 * Returns empty string if the file can't be read.
 */
function readHead(filePath, maxBytes) {
    try {
        var fd = fs.openSync(filePath, 'r');
        var buf = Buffer.alloc(maxBytes);
        var n = fs.readSync(fd, buf, 0, maxBytes, 0);
        fs.closeSync(fd);
        return buf.toString('latin1', 0, n);
    } catch (e) {
        return '';
    }
}

/** True if the file content looks like HTML (contains <html). */
function contentIsHtml(filePath) {
    var head = readHead(filePath, 4096);
    return /<html/i.test(head);
}

/** Build a Set of archive-rel paths that need .html appended. */
function buildHtmlSuffixSet(archiveDir, allFiles) {
    var set = new Set();
    for (var i = 0; i < allFiles.length; i++) {
        var relPath = allFiles[i].archiveRelPath;
        if (!NON_NATIVE_EXT.has(extOf(relPath))) continue;
        var absPath = path.join(archiveDir, relPath);
        if (contentIsHtml(absPath)) {
            set.add(relPath);
        }
    }
    return set;
}

// Populated before processing — used by needsHtmlSuffix.
var htmlSuffixSet = new Set();

/**
 * Should this archive-rel path get .html appended?
 * For files that exist in the archive: checks the pre-built set (sniffed from content).
 * For computed/fallback paths: uses filename heuristics.
 */
function needsHtmlSuffix(relPath) {
    if (htmlSuffixSet.has(relPath)) return true;

    // For paths not in the index (fallback/computed), use filename heuristics.
    var ext = extOf(relPath);
    if (!NON_NATIVE_EXT.has(ext)) return false;

    var base = path.basename(relPath, ext).toLowerCase();
    // If the base name hints at CSS, JS, or image, skip .html
    if (/\.(css|js|jpg|jpeg|png|gif|bmp|svg|ico|woff|woff2|ttf|eot|json|xml|txt|map)$/i.test(base)) return false;
    if (/^(css|js|style|styles|stylesheet|script|image|img|icon|logo|banner|photo|pic|thumb|sprite)$/i.test(base)) return false;

    // Default: server-side extension → probably HTML
    return true;
}

function extOf(filePath) {
    return path.extname(filePath).toLowerCase();
}

function baseOf(filePath) {
    return path.basename(filePath).toLowerCase();
}

function isTextFile(relPath) {
    const ext = extOf(relPath);
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (ext === '') {
        const base = baseOf(relPath);
        return ['index', 'default', 'home', 'welcome', 'main'].includes(base);
    }
    return false;
}

function isHtmlFile(relPath) {
    const ext = extOf(relPath);
    if (HTML_EXTENSIONS.has(ext)) return true;
    if (ext === '') {
        const base = baseOf(relPath);
        return ['index', 'default', 'home', 'welcome', 'main'].includes(base);
    }
    return false;
}

// ==========================================================================
// Wayback Injection Cleanup (mirrors server.js logic)
// ==========================================================================

function cleanWaybackInjections(content) {
    // 1. Toolbar UI (the visible banner inside <body>)
    content = content.replace(
        /<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi,
        ''
    );

    // 2. athena.js + inline archive_analytics snippet
    content = content.replace(
        /<script[^>]*src=["'][^"']*athena\.js["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );
    content = content.replace(
        /<script[^>]*>\s*window\.addEventListener\('DOMContentLoaded'[\s\S]*?archive_analytics\.send_pageview\(\{[\s\S]*?\}\);\s*<\/script>/gi,
        ''
    );

    // 3. Ruffle (Flash emulator)
    content = content.replace(
        /<script>\s*window\.RufflePlayer[\s\S]*?<\/script>/gi,
        ''
    );
    content = content.replace(
        /<script[^>]*src=["'][^"']*ruffle[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );

    // 4. wombat.js / bundle-playback.js — runtime URL rewriters that need
    //    a server-side proxy.  We do link rewriting statically, so these
    //    are unnecessary and would cause errors on file://.
    content = content.replace(
        /<script[^>]*src=["'][^"']*wombat\.js[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );
    content = content.replace(
        /<script[^>]*src=["'][^"']*bundle-playback\.js[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );

    // 5. __wm.init / __wm.wombat inline config scripts
    content = content.replace(
        /<script[^>]*>\s*(?:<!--\s*)?\s*__wm\.(?:init|wombat)\s*\([\s\S]*?;\s*\n?\s*<\/script>/gi,
        ''
    );
    // Also catch multi-line versions
    content = content.replace(
        /<script[^>]*>\s*__wm\.(?:init|wombat)\s*\([\s\S]*?<\/script>/gi,
        ''
    );

    // 6. Remove <base> tag — it would break relative paths on file://
    content = content.replace(/<base\s+[^>]*>/gi, '');
    content = content.replace(/<base\s*>/gi, '');

    // 7. Remove Wayback end marker comment
    content = content.replace(/<!-- End Wayback Rewrite JS Include -->/gi, '');

    // 8. Remove apollo.js / archive.org top-nav scripts (not useful offline)
    content = content.replace(
        /<script[^>]*src=["'][^"']*(?:https?:)?\/\/(?:www\.)?archive\.org\/[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );
    content = content.replace(
        /<link[^>]*href=["'][^"']*(?:https?:)?\/\/(?:www\.)?archive\.org\/[^"']*["'][^>]*>/gi,
        ''
    );

    return content;
}

// ==========================================================================
// URL Parsing & Normalization
// ==========================================================================

/**
 * Parse a URL string into components.
 * Returns null for URLs we can't or shouldn't rewrite
 * (root-relative without base, javascript:, data:, etc.).
 */
function parseUrl(urlStr) {
    if (/^(javascript|data|mailto|blob|about):/i.test(urlStr)) return null;
    if (urlStr.startsWith('#')) return null;

    // Protocol-relative → promote to http for parsing
    let normalized = urlStr;
    if (normalized.startsWith('//')) {
        normalized = 'http:' + normalized;
    }
    // Root-relative — can't resolve without a base domain
    if (normalized.startsWith('/') && !normalized.startsWith('//')) {
        return null;
    }
    // Fragment-only
    if (normalized.startsWith('#')) return null;

    try {
        const u = new URL(normalized);
        return {
            protocol: u.protocol.replace(':', ''),
            hostname:  u.hostname,
            port:      u.port,
            pathname:  u.pathname,
            search:    u.search,
            hash:      u.hash,
        };
    } catch (e) {
        return null;
    }
}

/** Build a consistent lookup key from URL components. */
function makeKey(protocol, hostname, port, pathname) {
    let k = protocol + '://' + hostname;
    if (port) k += ':' + port;
    // Normalise: strip leading slash, so "http://x.com/" and "http://x.com" collide.
    let p = pathname;
    if (p.startsWith('/')) p = p.slice(1);
    k += '/' + p;
    return k;
}

// ==========================================================================
// Index Building
// ==========================================================================

/**
 * Walk the archive directory and build:
 *   index:    { urlKey → [{timestamp, archiveRelPath}] }
 *   allFiles: [{archiveRelPath, isWayback, timestamp, urlKeys}]
 */
function buildIndex(archiveDir) {
    const index = {};
    const allFiles = [];

    function walk(dir, relParts) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            const cur = [...relParts, entry.name];

            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(fullPath, cur);
            } else if (entry.isFile()) {
                const info = classify(cur);
                if (!info) continue;

                allFiles.push({
                    archiveRelPath: cur.join('/'),
                    isWayback:      info.isWayback,
                    timestamp:      info.timestamp,
                });

                for (const key of info.urlKeys) {
                    if (!index[key]) index[key] = [];
                    index[key].push({
                        timestamp:      info.timestamp,
                        archiveRelPath: cur.join('/'),
                    });
                }
            }
        }
    }

    walk(archiveDir, []);

    // Deduplicate entries under each key
    for (const key of Object.keys(index)) {
        const seen = new Set();
        index[key] = index[key].filter(e => {
            const sig = e.archiveRelPath;
            if (seen.has(sig)) return false;
            seen.add(sig);
            return true;
        });
    }

    return { index, allFiles };
}

/**
 * Given path segments relative to the archive root, figure out:
 *   - Whether this is a Wayback file
 *   - Its timestamp (if Wayback)
 *   - All URL keys this file could be reached by
 *
 * Archive layout examples:
 *   Wayback:  https/web.archive.org/web/<ts>[flags]/<host>[/<port>]/<path>
 *   Direct:   <http|https|ftp>/<host>[/<port>]/<path>
 *   Static:   https/web-static.archive.org/_static/<path>   (treated as Direct)
 */
function classify(parts) {
    if (parts.length < 2) return null;

    const p0 = parts[0].toLowerCase();
    const p1 = parts[1].toLowerCase();

    // ── Wayback file ──────────────────────────────────────────────
    if ((p0 === 'http' || p0 === 'https') &&
        p1 === 'web.archive.org' &&
        parts.length >= 4 &&
        parts[2].toLowerCase() === 'web') {

        const tsRaw = parts[3];
        const tsMatch = tsRaw.match(/^(\d{4,14})/);
        if (!tsMatch) return null;

        const timestamp = tsMatch[1];
        const hostIdx = 4;
        if (parts.length <= hostIdx) return null;

        const hostname = parts[hostIdx];

        let portIdx = hostIdx + 1;
        let port = '';
        if (portIdx < parts.length && /^\d+$/.test(parts[portIdx])) {
            port = parts[portIdx];
            portIdx++;
        }

        const pathname = parts.slice(portIdx).join('/');

        return {
            isWayback: true,
            timestamp,
            urlKeys: urlKeyVariants(hostname, port, '/' + pathname),
        };
    }

    // ── Direct file ───────────────────────────────────────────────
    if ((p0 === 'http' || p0 === 'https' || p0 === 'ftp') && parts.length >= 2) {
        const protocol = p0;
        const hostname = p1;

        let portIdx = 2;
        let port = '';
        if (portIdx < parts.length && /^\d+$/.test(parts[portIdx])) {
            port = parts[portIdx];
            portIdx++;
        }

        const pathname = parts.slice(portIdx).join('/');

        return {
            isWayback: false,
            timestamp: null,
            urlKeys: urlKeyVariants(hostname, port, '/' + pathname, [protocol]),
        };
    }

    return null;
}

/**
 * Generate URL keys for all protocol / www variations.
 * If `protocols` is omitted we try both http and https (Wayback case —
 * the original protocol is not stored on disk).
 */
function urlKeyVariants(hostname, port, pathname, protocols) {
    if (!protocols) protocols = ['http', 'https'];
    const wwwAlt = hostname.startsWith('www.')
        ? hostname.slice(4)
        : 'www.' + hostname;
    const keys = [];
    for (const proto of protocols) {
        keys.push(makeKey(proto, hostname, port, pathname));
        keys.push(makeKey(proto, wwwAlt,   port, pathname));
    }
    return keys;
}

// ==========================================================================
// URL Resolution
// ==========================================================================

/**
 * Given a URL string found in a page, locate the best matching file
 * in the archive.  Returns {archiveRelPath} or null.
 */
// Default document names to try for directory URLs (like /path/ → /path/default.asp)
const DEFAULT_DOCS = [
    'index.html', 'index.htm', 'default.asp', 'default.aspx',
    'default.htm', 'default.html', 'default.shtml', 'index.shtml', 'home.asp', 'home.html', 'main.html'
];

function resolveUrl(urlStr, index, targetDate) {
    const parsed = parseUrl(urlStr);
    if (!parsed) return null;

    const { protocol, hostname, port, pathname } = parsed;
    const targetTs = dateToTimestamp(targetDate);

    // Collect all candidates across protocol/www variants
    const candidates = [];
    const seen = new Set();

    const tryAdd = (proto, host, pn) => {
        // 1. Exact path
        addFromIndex(proto, host, port, pn);
        // 2. Always try appending /index.html — some archived pages like
        //    /isapi/gomscom.asp are stored as gomscom.asp/index.html on disk.
        var cleanPn = pn.replace(/\/$/, '');
        addFromIndex(proto, host, port, cleanPn + '/index.html');
        // 3. If it's a directory URL, try all common default documents
        if (pn.endsWith('/') || pn === '' || pn === '/') {
            for (var d = 0; d < DEFAULT_DOCS.length; d++) {
                addFromIndex(proto, host, port, cleanPn + '/' + DEFAULT_DOCS[d]);
            }
        }
        // 4. If the URL has no extension, try .html and .htm
        if (!pn.match(/\.[a-zA-Z0-9]{1,10}$/) && pn !== '' && pn !== '/') {
            addFromIndex(proto, host, port, pn + '.html');
            addFromIndex(proto, host, port, pn + '.htm');
        }
    };

    const addFromIndex = (proto, host, pnPort, pn) => {
        const key = makeKey(proto, host, pnPort, pn);
        if (seen.has(key)) return;
        seen.add(key);
        const entries = index[key];
        if (entries) {
            for (const e of entries) {
                candidates.push({ ...e, matchProto: proto });
            }
        }
    };

    // Try exact match first, then fall back
    tryAdd(protocol, hostname, pathname);
    const wwwAlt = hostname.startsWith('www.') ? hostname.slice(4) : 'www.' + hostname;
    tryAdd(protocol, wwwAlt, pathname);
    const altProto = protocol === 'http' ? 'https' : 'http';
    tryAdd(altProto, hostname, pathname);
    tryAdd(altProto, wwwAlt, pathname);

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { archiveRelPath: candidates[0].archiveRelPath };

    // Sort: prefer same protocol, then closest timestamp
    candidates.sort((a, b) => {
        const pa = a.matchProto === protocol ? 0 : 1;
        const pb = b.matchProto === protocol ? 0 : 1;
        if (pa !== pb) return pa - pb;

        const tsA = a.timestamp ? parseInt(a.timestamp.padEnd(14, '0')) : 0;
        const tsB = b.timestamp ? parseInt(b.timestamp.padEnd(14, '0')) : 0;
        return Math.abs(tsA - targetTs) - Math.abs(tsB - targetTs);
    });

    return { archiveRelPath: candidates[0].archiveRelPath };
}

/** Convert YYYY[-MM][-DD] to a 14-digit timestamp for comparison. */
function dateToTimestamp(dateStr) {
    if (!dateStr) {
        const now = new Date();
        return parseInt(
            now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') +
            '000000'
        );
    }
    const parts = dateStr.split('-');
    const y = parts[0] || '2000';
    const m = (parts[1] || '01').padStart(2, '0');
    const d = (parts[2] || '01').padStart(2, '0');
    return parseInt(y + m + d + '000000');
}

// ==========================================================================
// Link Rewriting
// ==========================================================================

/**
 * Rewrite all URL references in `content` to relative paths that work on
 * the filesystem.  `currentRelPath` is this file's archive-relative path.
 */
function rewriteLinks(content, currentRelPath, index, targetDate) {
    const currentDir = path.posix.dirname(currentRelPath);

    /**
     * Core helper: given a URL, try to resolve it to a local file.
     * If found, return the relative path from currentDir to the target.
     * If not found, return null.
     */
    /**
     * Compute the hypothetical archive-relative path for a URL, even if
     * the file was never downloaded.  This lets us generate a consistent
     * relative link that becomes a clean 404 under file:// instead of
     * resolving to the filesystem root or trying to hit the internet.
     */
    function computeFallbackPath(absUrl) {
        // ── 1. Wayback absolute URL ──
        //   https://web.archive.org/web/<ts><flags>/<protocol>://<host>/<path>
        var wbAbs = absUrl.match(
            /^https?:\/\/(?:www\.)?web\.archive\.org\/web\/(\d{4,14})([a-z0-9_]*)\/(.+)$/i
        );
        if (wbAbs) {
            return buildWaybackPath(wbAbs[1], wbAbs[2], wbAbs[3]);
        }

        // ── 2. Root-relative Wayback ──
        //   /web/<ts><flags>/<rest>
        var wbRel = absUrl.match(
            /^\/web\/(\d{4,14})([a-z0-9_]*)\/(.+)$/i
        );
        if (wbRel) {
            return buildWaybackPath(wbRel[1], wbRel[2], wbRel[3]);
        }

        // ── 3. Direct absolute URL: http(s)://host/path ──
        var direct = absUrl.match(/^(https?|ftp):\/\/([^/]+)(\/.*)?$/i);
        if (direct) {
            var proto = direct[1].toLowerCase();
            var hostAndPort = direct[2];
            var pathname = direct[3] || '/';
            return buildDirectPath(proto, hostAndPort, pathname);
        }

        // ── 4. Protocol-relative: //host/path ──
        var protoRel = absUrl.match(/^\/\/([^/]+)(\/.*)?$/i);
        if (protoRel) {
            return buildDirectPath('http', protoRel[1], protoRel[2] || '/');
        }

        return null;
    }

    /** Build archive path for a Wayback URL: https/web.archive.org/web/<ts>/<host>/<path> */
    function buildWaybackPath(ts, flags, rest) {
        // Parse rest: "http://host/path", "http/host/path", or "host/path"
        var proto, host, pathname;
        var dsMatch = rest.match(/^(https?|ftp):\/\/(.+)$/i);  // "http://"
        if (dsMatch) {
            proto = dsMatch[1].toLowerCase();
            var hp = dsMatch[2];
            var slash = hp.indexOf('/');
            host = slash >= 0 ? hp.substring(0, slash) : hp;
            pathname = slash >= 0 ? hp.substring(slash) : '/';
        } else {
            var ddMatch = rest.match(/^(https?|ftp)\/([^/]+)(\/.*)?$/i);  // "http/"
            if (ddMatch) {
                proto = ddMatch[1].toLowerCase();
                host = ddMatch[2];
                pathname = ddMatch[3] || '/';
            } else {
                proto = 'http';
                var s = rest.indexOf('/');
                host = s >= 0 ? rest.substring(0, s) : rest;
                pathname = s >= 0 ? rest.substring(s) : '/';
            }
        }

        var parts = ['https', 'web.archive.org', 'web', ts + flags, host.toLowerCase()];
        // Port number from host:port
        var colonIdx = host.indexOf(':');
        if (colonIdx >= 0) {
            parts[4] = host.substring(0, colonIdx).toLowerCase();
            parts.push(host.substring(colonIdx + 1));
        }

        // Push path segments
        var segs = pathname.split('/').filter(function(s) { return s; });
        parts = parts.concat(segs);

        // If URL ends with / or has no path — add index.html.
        // hasExt must be careful: "search.microsoft.com" has a dot but is a
        // hostname, not a filename. Only trust the check when there are actual
        // path segments (segs.length > 0) beyond the hostname.
        var last = parts[parts.length - 1];
        var hasExt = last && segs.length > 0 && /\.[a-zA-Z0-9]{1,10}$/.test(last);
        if (!hasExt && (pathname.endsWith('/') || pathname === '/' || pathname === '')) {
            parts.push('index.html');
        }

        var archivePath = parts.join('/');
        if (needsHtmlSuffix(archivePath)) archivePath += '.html';
        return archivePath;
    }

    /** Build archive path for a direct URL: <proto>/<host>/<path> */
    function buildDirectPath(proto, hostAndPort, pathname) {
        var hostLower = hostAndPort.toLowerCase();
        var parts = [proto, hostLower];
        var colonIdx = hostLower.indexOf(':');
        if (colonIdx >= 0) {
            parts[1] = hostLower.substring(0, colonIdx);
            parts.push(hostLower.substring(colonIdx + 1));
        }

        var segs = pathname.split('/').filter(function(s) { return s; });
        parts = parts.concat(segs);

        var last = parts[parts.length - 1];
        var hasExt = last && segs.length > 0 && /\.[a-zA-Z0-9]{1,10}$/.test(last);
        if (!hasExt && (pathname.endsWith('/') || pathname === '/' || pathname === '')) {
            parts.push('index.html');
        }

        var archivePath = parts.join('/');
        if (needsHtmlSuffix(archivePath)) archivePath += '.html';
        return archivePath;
    }

    function relativize(absUrl) {
        // Strip query string for lookup (it's not part of the file path)
        var lookupUrl = absUrl.replace(/[?#].*$/, '');
        // Capture hash to re-append
        var hash = '';
        var hashIdx = absUrl.indexOf('#');
        if (hashIdx >= 0) hash = absUrl.slice(hashIdx);

        // ── 1. Try index-based resolution first ──
        var resolved = resolveUrl(lookupUrl, index, targetDate);
        if (resolved) {
            var targetPath = resolved.archiveRelPath;
            if (needsHtmlSuffix(targetPath)) targetPath += '.html';
            var rel = path.posix.relative(currentDir, targetPath);
            if (!rel.startsWith('.')) rel = './' + rel;
            return rel + hash;
        }

        // ── 2. Fallback: compute hypothetical archive path ──
        var fallbackPath = computeFallbackPath(absUrl.replace(/[?#].*$/, ''));
        if (fallbackPath) {
            var rel = path.posix.relative(currentDir, fallbackPath);
            if (!rel.startsWith('.')) rel = './' + rel;
            return rel + hash;
        }

        return null;
    }

    /**
     * Handle a "/web/<ts><flags>/<rest>" root-relative Wayback URL.
     * These were already rewritten by the Wayback server and appear
     * extensively in archived HTML.  We convert them to relative
     * filesystem paths.
     */
    function relativizeWaybackPath(waybackPath) {
        // waybackPath looks like: /web/20011215022550cs_/http/microsoft.com/...
        // or: /web/20011215022550/http://microsoft.com/...
        var wbMatch = waybackPath.match(
            /^\/web\/(\d{4,14})([a-z0-9_]*)\/(.+)$/i
        );
        if (!wbMatch) return null;

        var ts = wbMatch[1];
        var flags = wbMatch[2] || '';
        var rest = wbMatch[3];

        // Build a standard URL from `rest`.
        // Cases we see in real archives:
        //   "http://microsoft.com/path"      (double-slash protocol)
        //   "http/microsoft.com/path"        (protocol-dir style)
        //   "microsoft.com/path"             (no protocol at all)
        var lookup;
        var protoMatch = rest.match(/^(https?|ftp):\/\/(.+)$/i);
        if (protoMatch) {
            // "http://microsoft.com/path"
            lookup = protoMatch[1].toLowerCase() + '://' + protoMatch[2];
        } else {
            var dirMatch = rest.match(/^(https?|ftp)\/(.+)$/i);
            if (dirMatch) {
                // "http/microsoft.com/path"
                lookup = dirMatch[1].toLowerCase() + '://' + dirMatch[2];
            } else {
                // "microsoft.com/path" — default to http
                lookup = 'http://' + rest;
            }
        }

        // Also try with the timestamp + flags suffix that appears on disk.
        // The on-disk timestamp dir may include the flags (e.g. "20011215022550cs_").
        // We should look for the file that matches the full timestamp+flags
        // on disk, falling back to the plain timestamp.

        // Actually, the simplest approach: resolve the URL, and if there
        // are multiple candidates, prefer the one whose timestamp dir
        // matches our ts+flags.
        var urlToResolve = lookup.replace(/[?#].*$/, '');
        var hash = '';
        var hashIdx = waybackPath.indexOf('#');
        if (hashIdx >= 0) hash = waybackPath.slice(hashIdx);

        var resolved = resolveUrlWithTsPreference(
            urlToResolve, ts, flags, index, targetDate
        );

        var targetPath;
        if (resolved) {
            targetPath = resolved.archiveRelPath;
        } else {
            // Fallback: compute hypothetical archive path
            targetPath = computeFallbackPath(waybackPath);
        }

        if (!targetPath) return null;
        if (needsHtmlSuffix(targetPath)) targetPath += '.html';

        var rel = path.posix.relative(currentDir, targetPath);
        if (!rel.startsWith('.')) rel = './' + rel;
        return rel + hash;
    }

    /**
     * Extract Wayback host + timestamp from the current page's archive path.
     * e.g. "https/web.archive.org/web/20030404183527/www.microsoft.com/..."
     *   → {ts: "20030404183527", host: "www.microsoft.com"}
     */
    function getWaybackContext(relPath) {
        var m = relPath.match(
            /^(?:https?\/)?web\.archive\.org\/web\/(\d{4,14})([a-z0-9_]*)\/([^/]+)/i
        );
        if (!m) return null;
        return { ts: m[1], flags: m[2] || '', host: m[3] };
    }

    /**
     * Handle bare root-relative paths like /library/toolbar/images/curve.gif.
     * Resolve them against the Wayback snapshot's original domain.
     */
    function relativizeRootRelative(rootPath, context) {
        if (!context) return null;

        // e.g. rootPath = "/library/toolbar/images/curve.gif"
        // context.host = "www.microsoft.com"
        // → archive path: https/web.archive.org/web/<ts>/<host>/library/toolbar/images/curve.gif
        var clean = rootPath.replace(/[?#].*$/, '');
        var hash = '';
        var hIdx = rootPath.indexOf('#');
        if (hIdx >= 0) hash = rootPath.slice(hIdx);

        // Try with the same protocol as the page context
        // (we default to both http and https for Wayback)
        var lookupHttp = 'http://' + context.host + clean;
        var lookupHttps = 'https://' + context.host + clean;

        // Try index-based resolution first
        var resolved = resolveUrlWithTsPreference(lookupHttp, context.ts, context.flags, index, targetDate) ||
                       resolveUrlWithTsPreference(lookupHttps, context.ts, context.flags, index, targetDate) ||
                       resolveUrl(lookupHttp, index, targetDate) ||
                       resolveUrl(lookupHttps, index, targetDate);

        var targetPath;
        if (resolved) {
            targetPath = resolved.archiveRelPath;
        } else {
            // Fallback: compute archive path directly
            targetPath = 'https/web.archive.org/web/' + context.ts + context.flags +
                '/' + context.host + clean;
        }

        if (needsHtmlSuffix(targetPath)) targetPath += '.html';

        var rel = path.posix.relative(currentDir, targetPath);
        if (!rel.startsWith('.')) rel = './' + rel;
        return rel + hash;
    }

    // Cache the Wayback context for this page.
    var pageWaybackContext = getWaybackContext(currentRelPath);

    /**
     * Like resolveUrl, but also tries to match the specific timestamp+flags
     * directory name on disk.
     */
    function resolveUrlWithTsPreference(urlStr, ts, flags, index, targetDate) {
        var parsed = parseUrl(urlStr);
        if (!parsed) return null;

        var protocol = parsed.protocol;
        var hostname = parsed.hostname;
        var port = parsed.port;
        var pathname = parsed.pathname;
        var targetTs = dateToTimestamp(targetDate);

        // Collect candidates
        var candidates = [];
        var seen = new Set();

        function addFromIndex(proto, host, pnPort, pn) {
            var key = makeKey(proto, host, pnPort, pn);
            if (seen.has(key)) return;
            seen.add(key);
            var entries = index[key];
            if (entries) {
                for (var i = 0; i < entries.length; i++) {
                    candidates.push({
                        archiveRelPath: entries[i].archiveRelPath,
                        timestamp: entries[i].timestamp,
                        matchProto: proto,
                    });
                }
            }
        }

        function tryAdd(proto, host, pn) {
            addFromIndex(proto, host, port, pn);
            // Always try appending /index.html
            var cleanPn = pn.replace(/\/$/, '');
            addFromIndex(proto, host, port, cleanPn + '/index.html');
            // If it's a directory URL, try all common default documents
            if (pn.endsWith('/') || pn === '' || pn === '/') {
                for (var d = 0; d < DEFAULT_DOCS.length; d++) {
                    addFromIndex(proto, host, port, cleanPn + '/' + DEFAULT_DOCS[d]);
                }
            }
        }

        tryAdd(protocol, hostname, pathname);
        var wwwAlt = hostname.startsWith('www.') ? hostname.slice(4) : 'www.' + hostname;
        tryAdd(protocol, wwwAlt, pathname);
        var altProto = protocol === 'http' ? 'https' : 'http';
        tryAdd(altProto, hostname, pathname);
        tryAdd(altProto, wwwAlt, pathname);

        if (candidates.length === 0) return null;
        if (candidates.length === 1) return { archiveRelPath: candidates[0].archiveRelPath };

        // Build the expected ts+flags directory name
        var tsDir = ts + flags;

        // Sort: exact tsDir match first, then protocol, then proximity to target date
        candidates.sort(function(a, b) {
            // Does the archive path contain the exact tsDir?
            var aExact = a.archiveRelPath.indexOf('/' + tsDir + '/') >= 0 ? 0 : 1;
            var bExact = b.archiveRelPath.indexOf('/' + tsDir + '/') >= 0 ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;

            // Prefer same protocol
            var pa = a.matchProto === protocol ? 0 : 1;
            var pb = b.matchProto === protocol ? 0 : 1;
            if (pa !== pb) return pa - pb;

            // Proximity to target date
            var tsA = a.timestamp ? parseInt(a.timestamp.padEnd(14, '0')) : 0;
            var tsB = b.timestamp ? parseInt(b.timestamp.padEnd(14, '0')) : 0;
            return Math.abs(tsA - targetTs) - Math.abs(tsB - targetTs);
        });

        return { archiveRelPath: candidates[0].archiveRelPath };
    }

    // ── 1. HTML attributes: href, src, action, background, data ──
    //     Capture the quote character so we preserve it in replacements.
    //     This matters inside <script> blocks: a single-quoted SRC='...' inside
    //     a double-quoted JS string must stay single-quoted.
    function relAttr(url, quote) {
        // Skip fragments, javascript:, mailto:, data: URIs
        if (url.startsWith('#') || /^(javascript|data|mailto|blob):/i.test(url)) {
            return null;
        }

        // Already-relative paths (don't start with http, //, or /)
        if (!/^(https?:|ftp:|\/\/|\/)/i.test(url)) {
            return null;
        }

        // ── Root-relative Wayback path: /web/<ts>/... ──
        if (/^\/web\/\d{4,14}/i.test(url)) {
            return relativizeWaybackPath(url);
        }

        // ── Bare root-relative path: /library/toolbar/... ──
        if (url.startsWith('/') && !url.startsWith('//')) {
            return relativizeRootRelative(url, pageWaybackContext);
        }

        // ── Absolute / protocol-relative URL ──
        return relativize(url);
    }

    var ATTR_RE = /(href|src|action|background|data)\s*=\s*(["'])(.*?)\2/gi;
    content = content.replace(ATTR_RE, function(match, attr, quote, url) {
        var rel = relAttr(url, quote);
        if (rel !== null) return attr + '=' + quote + rel + quote;
        return match;
    });

    // ── 2. CSS url() references ──
    var URL_RE = /url\(\s*["']?(.*?)["']?\s*\)/gi;
    content = content.replace(URL_RE, function(match, url) {
        if (url.startsWith('#') || /^(javascript|data):/i.test(url)) return match;
        if (!/^(https?:|ftp:|\/\/|\/)/i.test(url)) return match;

        if (/^\/web\/\d{4,14}/i.test(url)) {
            var rel = relativizeWaybackPath(url);
            if (rel !== null) return 'url(' + rel + ')';
            return match;
        }

        if (url.startsWith('/') && !url.startsWith('//')) {
            var rel = relativizeRootRelative(url, pageWaybackContext);
            if (rel !== null) return 'url(' + rel + ')';
            return match;
        }

        var rel = relativize(url);
        if (rel !== null) return 'url(' + rel + ')';
        return match;
    });

    // ── 3. CSS @import ──
    var IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(.+?)["']?\s*\)?\s*;/gi;
    content = content.replace(IMPORT_RE, function(match, url) {
        var clean = url.replace(/['"]/g, '').trim();
        if (!/^(https?:|ftp:|\/\/|\/)/i.test(clean)) return match;

        if (/^\/web\/\d{4,14}/i.test(clean)) {
            var rel = relativizeWaybackPath(clean);
            if (rel !== null) return '@import "' + rel + '";';
            return match;
        }

        if (clean.startsWith('/') && !clean.startsWith('//')) {
            var rel = relativizeRootRelative(clean, pageWaybackContext);
            if (rel !== null) return '@import "' + rel + '";';
            return match;
        }

        var rel = relativize(clean);
        if (rel !== null) return '@import "' + rel + '";';
        return match;
    });

    // ── 4. Catch-all: web.archive.org/web/<ts>/… URLs in any context
    //    (inline JS strings, <meta>, srcset, <object data>, etc.) ──
    var WB_CATCHALL = /(?:https?:)?\/\/(?:www\.)?web\.archive\.org\/web\/(\d{4,14})([a-z0-9_]*)\/([^\s"'<>)\]]+)/gi;
    content = content.replace(WB_CATCHALL, function(match, ts, flags, rest) {
        // Reconstruct a proper URL from rest
        var lookup = rest;
        var protoMatch = lookup.match(/^(https?|ftp)\/([^/]+)(\/.*)?$/);
        if (protoMatch) {
            lookup = protoMatch[1] + '://' + protoMatch[2] + (protoMatch[3] || '');
        } else if (!/^https?:\/\//i.test(lookup)) {
            lookup = 'http://' + lookup;
        }
        // Fix double-protocol like "http://http://..."
        lookup = lookup.replace(/^(https?:\/\/)(https?:\/\/)/i, '$1');

        var rel = relativize(lookup);
        if (rel !== null) return rel;
        return match;
    });

    // ── 5. /web/<ts>/... bare paths in any context (inline JS, etc.) ──
    var WB_PATH_CATCHALL = /(?<=["'(\s])(\/web\/\d{4,14}[a-z0-9_]*\/[^\s"'<>)\]]+)/gi;
    content = content.replace(WB_PATH_CATCHALL, function(match) {
        var rel = relativizeWaybackPath(match);
        if (rel !== null) return rel;
        return match;
    });

    // ── 6. web-static.archive.org/_static/… references ──
    var STATIC_RE = /(["'(])(https?:\/\/web-static\.archive\.org\/_static\/([^\s"'<>)\]]+))/gi;
    content = content.replace(STATIC_RE, function(match, open, fullUrl, rest) {
        var staticPath = 'https/web-static.archive.org/_static/' + rest;
        var rel = path.posix.relative(currentDir, staticPath);
        if (!rel.startsWith('.')) rel = './' + rel;
        return open + rel;
    });

    return content;
}

// ==========================================================================
// Index Generation
// ==========================================================================

const PAGE_EXT = new Set([
    '.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml'
]);

function isWebPage(filename) {
    if (filename.includes('screenshot')) return false;
    var ext = path.extname(filename).toLowerCase();
    // .html appended by flattener for non-native HTML files
    if (ext === '.html') return true;
    if (PAGE_EXT.has(ext)) {
        // For server-side extensions, sniff content to exclude CSS/JS masquerading as .asp
        if (NON_NATIVE_EXT.has(ext)) {
            return false; // already handled: if it was HTML, the file would end with .asp.html after flattening
        }
        return true;
    }
    if (ext === '') {
        var base = path.basename(filename).toLowerCase();
        return ['index', 'default', 'home', 'welcome', 'main'].includes(base);
    }
    return false;
}

function generateIndex(outputDir) {
    var found = [];

    function scan(directory) {
        if (!fs.existsSync(directory)) return;
        var items;
        try { items = fs.readdirSync(directory); } catch (e) { return; }

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.startsWith('.') || item === 'node_modules' || item === 'index.html') continue;

            var full = path.join(directory, item);
            var stat;
            try { stat = fs.statSync(full); } catch (e) { continue; }

            if (stat.isDirectory()) {
                scan(full);
            } else if (stat.size > 0 && isWebPage(item)) {
                var relPath = path.relative(outputDir, full).split(path.sep).join('/');
                var info = {
                    filePath: relPath,
                    link: relPath,
                    size: Math.ceil(stat.size / 1024) + 'KB',
                    dateRaw: stat.mtimeMs,
                    dateDisplay: new Date(stat.mtime).toISOString().replace('T', ' ').substring(0, 16),
                    domain: '',
                    type: 'Direct'
                };

                // Detect Wayback structure for display
                var wbMatch = relPath.match(/web\.archive\.org\/web\/(\d{14})([a-z0-9_]*)\/([^/]+)/i);
                if (wbMatch) {
                    var ts = wbMatch[1];
                    info.type = 'Wayback';
                    info.dateDisplay = ts.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5');
                    info.domain = wbMatch[3];
                    info.dateRaw = parseInt(ts);
                } else {
                    var parts = relPath.split('/');
                    info.domain = parts[0];
                }

                found.push(info);
            }
        }
    }

    scan(outputDir);

    // Sort: domain, then date desc
    found.sort(function(a, b) {
        if (a.domain < b.domain) return -1;
        if (a.domain > b.domain) return 1;
        return b.dateRaw - a.dateRaw;
    });

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    var html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">\n<html>\n<head>\n' +
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n' +
        '<title>Local Web Archive</title>\n' +
        '<style type="text/css">\n' +
        '  body { background-color: #FFFFFF; font-family: Verdana, Tahoma, Arial, sans-serif; font-size: 11px; margin: 15px; color: #000000; }\n' +
        '  h1 { font-size: 16px; color: #003399; border-bottom: 2px solid #003399; padding-bottom: 5px; margin-bottom: 15px; }\n' +
        '  table { width: 100%; border-collapse: collapse; border: 1px solid #999999; }\n' +
        '  th { background-color: #ECE9D8; border: 1px solid #999999; padding: 4px; text-align: left; font-weight: bold; color: #333333; }\n' +
        '  td { border: 1px solid #999999; padding: 3px 5px; vertical-align: middle; }\n' +
        '  .row-alt { background-color: #F7F7F7; }\n' +
        '  .row-norm { background-color: #FFFFFF; }\n' +
        '  tr.row-norm:hover, tr.row-alt:hover { background-color: #FFFFCC; }\n' +
        '  a { color: #0000CC; text-decoration: none; }\n' +
        '  a:hover { text-decoration: underline; color: #FF0000; }\n' +
        '  .b-wb { font-size: 10px; color: #FFFFFF; background-color: #CC6600; padding: 1px 3px; font-weight: bold; border: 1px solid #993300; }\n' +
        '  .b-dir { font-size: 10px; color: #FFFFFF; background-color: #0066CC; padding: 1px 3px; font-weight: bold; border: 1px solid #003399; }\n' +
        '  .dom { font-weight: bold; color: #333333; }\n' +
        '  .sml { color: #666666; font-size: 10px; }\n' +
        '  .footer { margin-top: 15px; font-size: 10px; color: #999999; text-align: center; border-top: 1px solid #CCCCCC; padding-top: 5px; }\n' +
        '</style>\n</head>\n<body>\n' +
        '<h1>Local Web Archive (' + found.length + ' Pages)</h1>\n' +
        '<table cellpadding="0" cellspacing="0">\n' +
        '<tr><th width="80">Type</th><th width="140">Date</th><th width="180">Domain</th><th>Path</th><th width="60">Size</th></tr>\n';

    for (var i = 0; i < found.length; i++) {
        var p = found[i];
        var rowClass = (i % 2 === 0) ? 'row-norm' : 'row-alt';
        var badge = p.type === 'Wayback' ? 'b-wb' : 'b-dir';
        html += '<tr class="' + rowClass + '">' +
            '<td align="center"><span class="' + badge + '">' + esc(p.type.toUpperCase()) + '</span></td>' +
            '<td class="sml">' + esc(p.dateDisplay) + '</td>' +
            '<td class="dom">' + esc(p.domain) + '</td>' +
            '<td><a href="' + esc(p.link) + '" target="_blank">' + esc(p.filePath) + '</a></td>' +
            '<td class="sml" align="right">' + esc(p.size) + '</td></tr>\n';
    }

    html += '</table>\n' +
        '<div class="footer">Generated on ' + new Date().toLocaleString() + ' &bull; Standalone archive</div>\n' +
        '</body>\n</html>';

    fs.writeFileSync(path.join(outputDir, 'index.html'), html);
    console.log('  ' + found.length + ' pages indexed');
}

// ==========================================================================
// Main
// ==========================================================================

function main() {
    const args = parseArgs();

    // ── Determine archive directory ──
    let archiveDir;
    if (args['archive-dir']) {
        archiveDir = path.resolve(args['archive-dir']);
    } else {
        const config = loadConfig();
        archiveDir = config.currentSaveLocation;
    }

    if (!fs.existsSync(archiveDir)) {
        console.error('Error: Archive directory not found: ' + archiveDir);
        process.exit(1);
    }

    // ── Determine output directory (required) ──
    if (!args['output-dir']) {
        console.error('Error: --output-dir is required.');
        console.error('Usage: node flatten.js --output-dir=<PATH> [--archive-dir=<PATH>] [--date=<YYYY[-MM][-DD]>]');
        process.exit(1);
    }
    const outputDir = path.resolve(args['output-dir']);

    // ── Target date ──
    const targetDate = args['date'] || null;

    console.log('=== Web Archive Flattener ===');
    console.log('Archive:  ' + archiveDir);
    console.log('Output:   ' + outputDir);
    if (targetDate) {
        console.log('Date preference: ' + targetDate);
    } else {
        console.log('Date preference: today (' + new Date().toISOString().slice(0, 10) + ')');
    }
    console.log('');

    // ── Phase 1: Build index ──
    console.log('Scanning archive directory...');
    const { index, allFiles } = buildIndex(archiveDir);
    console.log('  ' + allFiles.length + ' files indexed (' + Object.keys(index).length + ' unique URL keys)');

    // ── Phase 1b: Sniff which server-side extension files are actually HTML ──
    htmlSuffixSet = buildHtmlSuffixSet(archiveDir, allFiles);
    var sniffedHtml = htmlSuffixSet.size;
    var sniffedOther = 0;
    for (var si = 0; si < allFiles.length; si++) {
        var sp = allFiles[si].archiveRelPath;
        if (NON_NATIVE_EXT.has(extOf(sp)) && !htmlSuffixSet.has(sp)) sniffedOther++;
    }
    if (sniffedHtml > 0 || sniffedOther > 0) {
        console.log('  ' + sniffedHtml + ' non-native files are HTML → .html appended');
        console.log('  ' + sniffedOther + ' non-native files are CSS/JS/image → left as-is');
    }
    console.log('');

    // ── Phase 2: Process files ──
    console.log('Processing files...');

    let processed = 0;
    let rewritten = 0;
    let binaryCopied = 0;
    let errors = 0;
    const total = allFiles.length;

    for (const fileInfo of allFiles) {
        const srcPath = path.join(archiveDir, fileInfo.archiveRelPath);
        var dstPath = path.join(outputDir, fileInfo.archiveRelPath);

        // Append .html for server-side extensions so browsers
        // render them correctly under file://
        if (needsHtmlSuffix(fileInfo.archiveRelPath)) {
            dstPath += '.html';
        }

        const dstDir = path.dirname(dstPath);

        // Ensure the output directory tree exists
        if (!fs.existsSync(dstDir)) {
            fs.mkdirSync(dstDir, { recursive: true });
        }

        const isText = isTextFile(fileInfo.archiveRelPath);
        const isHtml = isHtmlFile(fileInfo.archiveRelPath);

        if (isText || isHtml) {
            try {
                // Read as latin1 so every byte round-trips safely through
                // our regex replacements (which only touch ASCII URLs).
                const buf = fs.readFileSync(srcPath);
                let content = buf.toString('latin1');

                // Clean Wayback injections from HTML files
                if (isHtml && (fileInfo.isWayback ||
                    fileInfo.archiveRelPath.includes('web.archive.org'))) {
                    content = cleanWaybackInjections(content);
                }

                // Rewrite links
                content = rewriteLinks(content, fileInfo.archiveRelPath, index, targetDate);

                // Write back as latin1
                fs.writeFileSync(dstPath, Buffer.from(content, 'latin1'));
                rewritten++;
            } catch (e) {
                console.error('  ERROR: ' + fileInfo.archiveRelPath + ' — ' + e.message);
                // Fall back to binary copy
                try { fs.copyFileSync(srcPath, dstPath); binaryCopied++; }
                catch (e2) { errors++; }
            }
        } else {
            // Binary file: copy byte-for-byte
            try {
                fs.copyFileSync(srcPath, dstPath);
                binaryCopied++;
            } catch (e) {
                console.error('  ERROR copying: ' + fileInfo.archiveRelPath + ' — ' + e.message);
                errors++;
            }
        }

        processed++;
        if (processed % 200 === 0 || processed === total) {
            console.log('  ' + processed + '/' + total + ' files...');
        }
    }

    // ── Phase 3: Generate index.html ──
    console.log('');
    console.log('Generating index.html...');
    generateIndex(outputDir);

    // ── Summary ──
    console.log('');
    console.log('=== Flatten Complete ===');
    console.log('  Text files rewritten:  ' + rewritten);
    console.log('  Binary files copied:   ' + binaryCopied);
    console.log('  Errors:                ' + errors);
    console.log('  Output directory:      ' + outputDir);
    console.log('');
    console.log('You can now open HTML files directly from the output folder.');
    console.log('No server required — all links are relative.');
}

main();
