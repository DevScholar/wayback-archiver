/**
 * downloader.js (Universal Edition)
 * Supports:
 * 1. Wayback Machine archive links -> saved to http/web.archive.org/web/TIMESTAMP/... or https/web.archive.org/...
 * 2. Direct URL links -> saved directly to http/ or https/ directory
 * 3. Strictly preserves path case sensitivity (fixes issue of JAPAN becoming Japan)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
    sanitizeSegment, loadConfig, randomBase62,
    applyQuerySuffix, hostSegment, extractExplicitPort, csvEscape, parseOriginalUrlCsv
} = require('./common');

// === Configuration Area ===
const config = loadConfig();
const SAVE_ROOT = config.currentSaveLocation;

const CONFIG = {
    urlFile: path.join(__dirname, 'user-private', 'urls.txt'),
    baseDir: SAVE_ROOT, // Download root directory (from config.json)
    concurrency: 8, // Number of concurrent downloads
    mappingFile: path.join(__dirname, 'filename_mapping.json'), // Used to record long filename mappings
    timeout: 120000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36'
};

// === State initialization ===
// The archive directory on disk is the single source of truth for "already
// downloaded": a URL is (re)downloaded unless its file already exists on disk.
// There is no download_state.json — that keyed-by-URL record went stale whenever
// the save location changed or files were deleted, and silently skipped every
// URL while the archive directory was empty.
let urlMapping = {};

// Query-string CSV entries accumulated this run, flushed on saveState().
// Keyed by directory so several downloads into the same directory don't race
// on read-modify-write of one CSV file.
const csvBuffer = new Map();   // dir -> Map(shortened -> originalUrl)
const usedShortened = new Set(); // every shortened name generated this run

try {
    if (fs.existsSync(CONFIG.mappingFile)) {
        urlMapping = JSON.parse(fs.readFileSync(CONFIG.mappingFile));
    }
} catch (e) {}

/**
 * Read the existing original_url.csv in `dir`, if any, and return both a
 * URL→shortened reverse map and the set of shortened names already taken.
 */
function readExistingCsv(dir) {
    const byUrl = {};
    const shortenedNames = new Set();
    try {
        const csvPath = path.join(dir, 'original_url.csv');
        if (fs.existsSync(csvPath)) {
            for (const r of parseOriginalUrlCsv(fs.readFileSync(csvPath, 'utf-8'))) {
                byUrl[r.url] = r.shortened;
                shortenedNames.add(r.shortened);
            }
        }
    } catch (e) {}
    return { byUrl, shortenedNames };
}

/** Write every accumulated CSV entry to disk, merging with existing rows. */
function flushCsv() {
    for (const [dir, entries] of csvBuffer) {
        if (entries.size === 0) continue;
        try {
            fs.mkdirSync(dir, { recursive: true });
            const csvPath = path.join(dir, 'original_url.csv');

            // Merge: existing rows on disk, then this run's entries.
            const merged = new Map();
            if (fs.existsSync(csvPath)) {
                for (const r of parseOriginalUrlCsv(fs.readFileSync(csvPath, 'utf-8'))) {
                    merged.set(r.shortened, r.url);
                }
            }
            for (const [shortened, url] of entries) {
                merged.set(shortened, url);
            }

            const lines = ['Shortened,URL'];
            for (const [shortened, url] of merged) {
                lines.push(csvEscape(shortened) + ',' + csvEscape(url));
            }
            fs.writeFileSync(csvPath, lines.join('\n') + '\n');
        } catch (e) {
            console.error(`Failed to write original_url.csv in ${dir}: ${e.message}`);
        }
    }
    csvBuffer.clear();
}

function saveState() {
    try {
        fs.writeFileSync(CONFIG.mappingFile, JSON.stringify(urlMapping, null, 2));
        flushCsv();
    } catch (e) {}
}

/**
 * [Core] Calculate local storage path
 * Compatible with Wayback links and direct links.
 *
 * Returns { destPath, csv } where `csv` is null unless the URL carried a query
 * string.  In that case the file is renamed with an anti-collision base62
 * suffix and `csv` = { dir, shortened, originalUrl } describes the
 * original_url.csv row to write.
 */
function getLocalPath(inputUrl) {
    try {
        let ts = null; // Timestamp
        let rawUrl = inputUrl;
        let isWayback = false;

        // 1. Determine if it's a Wayback link.
        //    Matching format: /web/20011024204821/http://...
        //
        //    Parse the full URL first and match the wayback signature against
        //    the *pathname* only.  The query string belongs to the inner
        //    original URL (e.g. …/web/ts/http://host/a.asp?x=1) so it must NOT
        //    be stripped here — matching on pathname also keeps a query param
        //    that happens to contain "/web/<ts>/…" from causing a
        //    false-positive wayback match.
        const fullObj = new URL(inputUrl);
        const wbMatch = fullObj.pathname.match(/\/web\/(\d{4,14})([a-z0-9_]+)?\/(.*)/);

        if (wbMatch) {
            isWayback = true;
            // Preserve the Wayback flags suffix (im_, cs_, js_, fw_, if_, …)
            // that follows the timestamp. Dropping it flattens distinct content
            // types that share one timestamp into a single directory.
            ts = wbMatch[1] + (wbMatch[2] || '');
            // Reconstruct the inner original URL (path + query).  Fragment is dropped.
            rawUrl = wbMatch[3] + fullObj.search;
        }

        // 2. Complete protocol (to prevent input of links without protocol headers like google.com)
        if (!rawUrl.startsWith('http')) {
            if (rawUrl.startsWith('ftp')) {
                rawUrl = 'ftp://' + rawUrl.replace(/^ftp:\/\//, '');
            } else {
                rawUrl = 'http://' + rawUrl;
            }
        }

        // 3. General URL parsing
        const urlObj = new URL(rawUrl);

        // 4. Build path segments

        // Protocol directory: 'http' or 'https'
        // Note: If it's a Wayback link, this is usually already included in rawUrl
        const protocolDir = urlObj.protocol.replace(':', '');

        // Hostname: the URL parser already lowercases this (DNS is
        // case-insensitive), which also keeps the filesystem tidy.
        const hostname = urlObj.hostname;

        // Port.  Use the explicit port from the raw URL when present — `new URL()`
        // normalizes default ports (http:80 / https:443) to empty, but we still
        // want to record those so an archive that mixes :80 and :443 requests
        // doesn't collapse them into one directory.  Colon → __port__ in the
        // host segment below.
        const explicitPort = extractExplicitPort(rawUrl);
        const port = explicitPort !== '' ? explicitPort : (urlObj.port || '');
        const query = urlObj.search || ''; // "?a=1&b=2" or ""

        // Path: [Important] decode and strictly preserve case sensitivity
        // urlObj.pathname by default preserves the case sensitivity of rawUrl
        const rawPathName = urlObj.pathname.substring(1); // remove leading /

        let pathParts = [protocolDir, hostSegment(hostname, port)];

        if (rawPathName) {
            const splitted = rawPathName.split('/').filter(p => p);
            pathParts = pathParts.concat(splitted);
        }

        // 5. Filename sanitization (disallow illegal characters, but preserve case)
        const safeParts = pathParts.map(p => {
            try { p = decodeURIComponent(p); } catch(e){}

            // Guard against path traversal: after decoding, a segment that is
            // exactly '.'/'..' (e.g. from %2e%2e) would climb out of baseDir
            // once path.join resolves it. Neutralize it.
            if (p === '.' || p === '..') p = p.replace(/\./g, '_');

            const safe = sanitizeSegment(p);

            // Record the long->short mapping when a name had to be truncated.
            // sanitizeSegment truncates iff the segment exceeded 200 chars, and
            // the char replacement preserves length, so this check mirrors it.
            if (p.length > 200) {
                const originalName = p.replace(/[<>:"/\\|?*]/g, '_');
                if (!urlMapping[safe]) urlMapping[safe] = originalName;
            }
            return safe;
        });

        // 6. Automatically append an index filename.
        // A URL that ends with '/' is a directory listing (Wayback serves a
        // calendar / index page instead of real archived content), so name it
        // distinctly to avoid clobbering a real captured index.html. A bare
        // domain with no path still gets plain index.html.
        if (rawUrl.replace(/[?#].*$/, '').endsWith('/')) {
             safeParts.push('__wayback__directory_index.html');
        } else if (safeParts.length <= 2) {
             safeParts.push('index.html');
        }

        // 7. Query-string handling: rename the file with an anti-collision
        //    base62 suffix so `?`/`&` never land in a filename (and we never
        //    blow the path-length limit).  Reuse an existing mapping so re-runs
        //    are idempotent.
        let csvEntry = null;
        if (query.length > 1) {
            const originalName = safeParts[safeParts.length - 1]; // e.g. "abc.htm"
            const dir = isWayback
                ? path.join(CONFIG.baseDir, 'https', 'web.archive.org', 'web', ts, ...safeParts.slice(1, -1))
                : path.join(CONFIG.baseDir, ...safeParts.slice(0, -1));

            const originalUrl = originalName + query;
            const existing = readExistingCsv(dir);

            let shortened = existing.byUrl[originalUrl];
            if (!shortened) {
                let suffix;
                do {
                    suffix = randomBase62(8);
                    shortened = applyQuerySuffix(originalName, suffix);
                } while (
                    existing.shortenedNames.has(shortened) ||
                    usedShortened.has(shortened) ||
                    fs.existsSync(path.join(dir, shortened))
                );
                usedShortened.add(shortened);
            }

            safeParts[safeParts.length - 1] = shortened;
            csvEntry = { dir, shortened, originalUrl };
        }

        // 8. Assemble final path
        if (isWayback) {
            // Wayback mode: websites/https/web.archive.org/web/TIMESTAMP/domain/path
            // web.archive.org is an HTTPS domain, so it lives under https/.
            // safeParts = [protocolDir, hostname, ...pathParts]
            // Insert 'web.archive.org/web/ts' between protocolDir and hostname
            return {
                destPath: path.join(CONFIG.baseDir, 'https', 'web.archive.org', 'web', ts, ...safeParts.slice(1)),
                csv: csvEntry
            };
        } else {
            // Direct link mode: websites/http/domain/path
            return {
                destPath: path.join(CONFIG.baseDir, ...safeParts),
                csv: csvEntry
            };
        }

    } catch (e) {
        // If the URL format is so bad that even new URL() can't parse it, skip
        console.error(`Skipping invalid URL format: ${inputUrl}`);
        return null;
    }
}

// 429 (Too Many Requests) handling: retry with a fixed delay between attempts.
const MAX_429_RETRIES = 3;   // extra attempts beyond the first
const RETRY_DELAY_MS = 500;  // 0.5s between each retried link

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * General download function
 *
 * `hasQuery` is true when the destination was named for a query-carrying URL
 * (i.e. it is already a shortened filename like `cdx_AA2aEIMj`).  In that
 * case we must NOT do content-type extension completion, because it would
 * rename/move the file away from the name recorded in original_url.csv and
 * break the server's reverse lookup.
 */
function downloadFile(url, suggestedPath, redirectCount = 0, hasQuery = false, retryCount = 0) {
    if (redirectCount > 5) return Promise.reject("Too many redirects");

    return new Promise((resolve, reject) => {
        // Automatically select protocol module
        const isHttps = url.startsWith('https:');
        const proto = isHttps ? https : http;

        const options = {
            headers: {
                'User-Agent': CONFIG.userAgent,
                // Simulate browser Accept
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
            }
        };

        const req = proto.get(url, options, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let newUrl = res.headers.location;
                // Handle relative path redirects
                if (newUrl.startsWith('/')) {
                    const u = new URL(url);
                    newUrl = `${u.protocol}//${u.host}${newUrl}`;
                } else if (!newUrl.startsWith('http')) {
                    // Sometimes Location only has filename
                    const u = new URL(url);
                    const basePath = path.posix.dirname(u.pathname);
                    newUrl = `${u.protocol}//${u.host}${basePath}/${newUrl}`;
                }

                res.resume();
                downloadFile(newUrl, suggestedPath, redirectCount + 1, hasQuery, retryCount).then(resolve).catch(reject);
                return;
            }

            // 429 Too Many Requests → back off 0.5s and retry (up to MAX_429_RETRIES).
            if (res.statusCode === 429) {
                res.resume();
                if (retryCount < MAX_429_RETRIES) {
                    sleep(RETRY_DELAY_MS).then(() =>
                        downloadFile(url, suggestedPath, redirectCount, hasQuery, retryCount + 1)
                            .then(resolve).catch(reject)
                    );
                } else {
                    reject(`HTTP 429 (gave up after ${MAX_429_RETRIES} retries)`);
                }
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(`HTTP ${res.statusCode}`);
                return;
            }

            let finalDest = suggestedPath;
            const currentExt = path.extname(finalDest);
            const ct = res.headers['content-type'] || '';

            // Intelligent extension completion (if path has no extension,
            // complete based on header) — skipped for query-shortened names.
            if (!currentExt && !hasQuery) {
                if (ct.includes('text/html')) finalDest = path.join(finalDest, 'index.html');
                else if (ct.includes('image/jpeg')) finalDest += '.jpg';
                else if (ct.includes('image/png')) finalDest += '.png';
                else if (ct.includes('image/gif')) finalDest += '.gif';
                else if (ct.includes('javascript')) finalDest += '.js';
                else if (ct.includes('css')) finalDest += '.css';
            }

            // Ensure directory tree exists
            try {
                fs.mkdirSync(path.dirname(finalDest), { recursive: true });
            } catch (err) {
                reject(`Mkdir Failed: ${err.message}`);
                return;
            }

            // Write file stream
            const fileStream = fs.createWriteStream(finalDest);
            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(() => {
                    // Zero-byte file check
                    fs.stat(finalDest, (err, stats) => {
                        if (!err && stats.size === 0) {
                            fs.unlink(finalDest, () => {}); 
                            reject("Zero Byte File Detected");
                        } else {
                            resolve(); 
                        }
                    });
                });
            });

            fileStream.on('error', (err) => {
                fs.unlink(finalDest, () => {});
                reject(`Write Failed: ${err.message}`);
            });
        });

        req.on('error', (e) => reject(`Network: ${e.message}`));
        req.on('timeout', () => { req.abort(); reject("Timeout"); });
        req.setTimeout(CONFIG.timeout);
    });
}

async function start() {
    console.log("=== Universal Downloader Started ===");
    console.log("Modes Supported: [Wayback Machine] & [Direct Link]");
    console.log(`Saving to: ${CONFIG.baseDir}`);

    if (!fs.existsSync(CONFIG.urlFile)) {
        console.error(`Error: ${CONFIG.urlFile} not found.`);
        return;
    }

    const rawContent = fs.readFileSync(CONFIG.urlFile, 'utf-8');
    const urls = [...new Set(rawContent.split('\n')
        .map(u => u.trim())
        .filter(u => {
            if (!u || u.startsWith('#')) return false; 
            // Filter out Wayback Machine screenshot links to save space
            if (u.includes('/screenshot/')) return false;
            return true;
        })
    )];

    console.log(`Loaded ${urls.length} unique URLs.`);

    let currentIndex = 0;
    
    // Worker thread logic
    const worker = async (id) => {
        while (currentIndex < urls.length) {
            const url = urls[currentIndex++];

            // Get storage path
            const result = getLocalPath(url);

            if (!result) {
                // If parsing fails, don't error, just skip
                // console.log(`[Thread ${id}] Skipped invalid URL`);
                continue;
            }
            const dest = result.destPath;

            // Local file existence check.
            //
            // This is the ONLY skip signal.  Disk is the single source of truth:
            // a URL is downloaded unless its file already exists on disk, so
            // re-running after a save-location change or file deletion correctly
            // re-downloads instead of silently skipping.
            let skip = false;
            // Check if file itself exists
            if (fs.existsSync(dest) && fs.statSync(dest).isFile() && fs.statSync(dest).size > 0) skip = true;
            // Check if it already exists as index.html
            else if (fs.existsSync(path.join(dest, 'index.html')) && fs.statSync(path.join(dest, 'index.html')).size > 0) skip = true;

            if (skip) {
                continue;
            }

            try {
                await downloadFile(url, dest, 0, !!result.csv);
                // Record the query mapping once the file is safely on disk.
                if (result.csv) {
                    if (!csvBuffer.has(result.csv.dir)) csvBuffer.set(result.csv.dir, new Map());
                    csvBuffer.get(result.csv.dir).set(result.csv.shortened, result.csv.originalUrl);
                }
                console.log(`[Thread ${id}] OK: ${url}`);
            } catch (err) {
                console.log(`[Thread ${id}] FAIL: ${err} | ${url}`);
            }

            if (currentIndex % 10 === 0) saveState();
        }
    };

    const threads = [];
    for (let i = 0; i < CONFIG.concurrency; i++) {
        threads.push(worker(i + 1));
    }

    await Promise.all(threads);
    saveState();
    console.log('\n=== All Tasks Completed ===');
}

start().catch((e) => {
    console.error('Fatal error:', e);
    saveState();
    process.exit(1);
});