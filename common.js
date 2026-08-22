/**
 * common.js
 * Shared helpers used by downloader.js, indexer.js and server.js.
 *
 * IMPORTANT: sanitizeSegment() must stay byte-for-byte identical between the
 * downloader (which names files on disk) and the server (which looks them up).
 * Keeping the single implementation here is what guarantees that.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// === Config loader ===

/** Resolve the platform-specific user documents directory. */
function getUserDocumentsDir() {
    const platform = os.platform();
    const home = os.homedir();
    if (platform === 'win32') {
        // On Windows, "My Documents" is typically under the user profile.
        // We try the env var first, then fall back to the well-known path.
        if (process.env.USERPROFILE) {
            const doc = path.join(process.env.USERPROFILE, 'Documents');
            if (fs.existsSync(doc)) return doc;
        }
        return path.join(home, 'Documents');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Documents');
    }
    // Linux / other Unix
    return path.join(home, 'Documents');
}

/**
 * Read config.json and resolve the `currentSaveLocation` field.
 * Replaces the `__USER_DOCUMENTS__` placeholder with the actual path.
 */
function loadConfig() {
    const configPath = path.join(__dirname, 'user-private', 'config.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const userDocs = getUserDocumentsDir();
    const resolved = raw.currentSaveLocation.replace('__USER_DOCUMENTS__', userDocs);
    return { currentSaveLocation: resolved };
}

// Max length before a path segment gets truncated + hashed.
const MAX_SEGMENT_LEN = 200;

/**
 * Turn one URL path segment into a filesystem-safe name.
 * - Replaces characters illegal on Windows/Linux with '_'.
 * - Collapses very long names to "first150_<md5-8><ext>" so we don't blow the
 *   255-char filename limit.
 * Case is preserved (JAPAN stays JAPAN, not Japan).
 */
function sanitizeSegment(name) {
    let safe = String(name).replace(/[<>:"/\\|?*]/g, '_');
    if (safe.length > MAX_SEGMENT_LEN) {
        const ext = path.extname(safe);
        const hash = crypto.createHash('md5').update(safe).digest('hex').substring(0, 8);
        safe = safe.substring(0, 150) + `_${hash}${ext}`;
    }
    return safe;
}

/** Escape a string for safe interpolation into HTML text or attributes. */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * True if `child` resolves to `parent` or a path inside it.
 * Used to keep request handling from escaping the archive root.
 */
function isPathInside(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// === Query-string / port filename encoding ===
//
// The archive stores URLs with query strings (the `?a=1&b=2` part) as files on
// disk.  `?` and `&` are illegal in Windows filenames, and shoving the whole
// query into the path blows past the 255-char filename limit, so instead we:
//   • encode a port colon as `__port__` (kept as part of the host segment), and
//   • replace the query with a short anti-collision base62 suffix, recording the
//     original URL in a per-directory `original_url.csv`.
//
// These functions MUST stay byte-for-byte identical between the downloader
// (which names files), the flattener (which resolves them), and the server
// (which looks them up) — exactly like sanitizeSegment above.

// Separator used for a port inside a hostname segment.
const PORT_SEP = '__port__';

// Alphabet for the anti-collision query suffix.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Generate a random base62 string of the given length. */
function randomBase62(length) {
    let s = '';
    for (let i = 0; i < length; i++) {
        s += BASE62[Math.floor(Math.random() * BASE62.length)];
    }
    return s;
}

/** Split a filename into { base, ext } (ext keeps the leading dot). */
function splitExt(name) {
    const ext = path.extname(name);
    return { base: name.slice(0, name.length - ext.length), ext };
}

/** Insert an anti-collision suffix before the extension: "abc.htm" -> "abc_XXXX.htm". */
function applyQuerySuffix(name, suffix) {
    const { base, ext } = splitExt(name);
    return base + '_' + suffix + ext;
}

/** Encode host[:port] as a single directory segment: "microsoft.com:80" -> "microsoft.com__port__80". */
function hostSegment(hostname, port) {
    return port ? hostname + PORT_SEP + port : hostname;
}

/**
 * Extract an explicit numeric port from a raw URL string, including default
 * ports that `new URL()` normalizes away (e.g. http:80 / https:443).  Returns
 * '' when no port is present.  Handles IPv6 authorities like [::1]:8080.
 */
function extractExplicitPort(rawUrl) {
    const m = String(rawUrl).match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
    if (!m) return '';
    const authority = m[1];
    if (authority.startsWith('[')) {
        const end = authority.indexOf(']');
        if (end < 0) return '';
        const rest = authority.slice(end + 1);
        return rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : '';
    }
    const colonIdx = authority.lastIndexOf(':');
    if (colonIdx < 0) return '';
    const port = authority.slice(colonIdx + 1);
    return /^\d+$/.test(port) ? port : '';
}

/** Escape a field for CSV output (quotes only when necessary). */
function csvEscape(field) {
    const s = String(field);
    if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/** Parse one CSV line into fields (handles quoted fields). */
function parseCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else {
                cur += c;
            }
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { fields.push(cur); cur = ''; }
            else cur += c;
        }
    }
    fields.push(cur);
    return fields;
}

/**
 * Parse an original_url.csv body into [{ shortened, url }].
 * Skips the "Shortened,URL" header row if present.
 */
function parseOriginalUrlCsv(body) {
    const rows = [];
    const lines = String(body).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;
        if (i === 0 && /^shortened$/i.test(parseCsvLine(line)[0])) continue; // header
        const fields = parseCsvLine(line);
        if (fields.length >= 2 && fields[0] !== '' && fields[1] !== '') {
            rows.push({ shortened: fields[0], url: fields[1] });
        }
    }
    return rows;
}

/**
 * Read original_url.csv in `dir` and return a Map of
 * shortened-filename → { base, query }.  `base` is the query-less filename
 * (e.g. "abc.htm") and `query` keeps its leading '?' (e.g. "?a=1&b=2").
 */
function readQueryMap(dir) {
    const map = new Map();
    try {
        const csvPath = path.join(dir, 'original_url.csv');
        if (fs.existsSync(csvPath)) {
            for (const r of parseOriginalUrlCsv(fs.readFileSync(csvPath, 'utf-8'))) {
                const qIdx = r.url.indexOf('?');
                if (qIdx >= 0) {
                    map.set(r.shortened, { base: r.url.slice(0, qIdx), query: r.url.slice(qIdx) });
                }
            }
        }
    } catch (e) {}
    return map;
}

/**
 * Resolve a query-carrying request to the on-disk shortened file.
 * Given a directory, the query-less base filename and the raw query string
 * (with leading '?'), look up original_url.csv and return the full path to
 * the shortened file, or null.  Base-name matching is case-insensitive
 * (matching the server's filename lookup), the query is exact.
 */
function resolveQueryFile(dir, baseName, query) {
    if (!query || query === '?') return null;
    const csvPath = path.join(dir, 'original_url.csv');
    if (!fs.existsSync(csvPath)) return null;
    const baseLower = String(baseName).toLowerCase();
    let rows;
    try { rows = parseOriginalUrlCsv(fs.readFileSync(csvPath, 'utf-8')); }
    catch (e) { return null; }
    for (const r of rows) {
        const qIdx = r.url.indexOf('?');
        if (qIdx < 0) continue;
        if (r.url.slice(0, qIdx).toLowerCase() === baseLower && r.url.slice(qIdx) === query) {
            const full = path.join(dir, r.shortened);
            if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
        }
    }
    return null;
}

module.exports = {
    sanitizeSegment, escapeHtml, isPathInside, loadConfig, getUserDocumentsDir, MAX_SEGMENT_LEN,
    PORT_SEP, randomBase62, splitExt, applyQuerySuffix, hostSegment, extractExplicitPort,
    csvEscape, parseOriginalUrlCsv, readQueryMap, resolveQueryFile
};
