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
const { sanitizeSegment, loadConfig } = require('./common');

// === Configuration Area ===
const config = loadConfig();
const SAVE_ROOT = config.currentSaveLocation;

const CONFIG = {
    urlFile: path.join(__dirname, 'user-private', 'urls.txt'),
    baseDir: SAVE_ROOT, // Download root directory (from config.json)
    concurrency: 8, // Number of concurrent downloads
    stateFile: path.join(__dirname, 'download_state.json'),
    mappingFile: path.join(__dirname, 'filename_mapping.json'), // Used to record long filename mappings
    timeout: 30000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36'
};

// === State initialization ===
let downloaded = new Set();
let urlMapping = {};

try {
    if (fs.existsSync(CONFIG.stateFile)) {
        downloaded = new Set(JSON.parse(fs.readFileSync(CONFIG.stateFile)));
    }
} catch (e) {}

try {
    if (fs.existsSync(CONFIG.mappingFile)) {
        urlMapping = JSON.parse(fs.readFileSync(CONFIG.mappingFile));
    }
} catch (e) {}

function saveState() {
    try {
        fs.writeFileSync(CONFIG.stateFile, JSON.stringify([...downloaded], null, 2));
        fs.writeFileSync(CONFIG.mappingFile, JSON.stringify(urlMapping, null, 2));
    } catch (e) {}
}

/**
 * [Core] Calculate local storage path
 * Compatible with Wayback links and direct links
 */
function getLocalPath(inputUrl) {
    try {
        let ts = null; // Timestamp
        let rawUrl = inputUrl;
        let isWayback = false;

        // 1. Determine if it's a Wayback link.
        //    Matching format: /web/20011024204821/http://...
        //
        //    Strip query string and fragment BEFORE the regex so query params
        //    that happen to contain "/web/<ts>/…" (e.g.
        //    donate.php?referer=…/web/…/…) don't cause false-positive wayback
        //    matches that throw when new URL() tries to parse garbled input.
        const baseUrl = inputUrl.replace(/[?#].*$/, '');
        const wbMatch = baseUrl.match(/\/web\/(\d{4,14})([a-z0-9_]+)?\/(.*)/);

        if (wbMatch) {
            isWayback = true;
            ts = wbMatch[1];
            rawUrl = wbMatch[3]; // Extract the actual original URL
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
        
        // Port
        const port = urlObj.port ? urlObj.port : '';

        // Path: [Important] decode and strictly preserve case sensitivity
        // urlObj.pathname by default preserves the case sensitivity of rawUrl
        const rawPathName = urlObj.pathname.substring(1); // remove leading /
        
        let pathParts = [protocolDir, hostname];
        if (port) pathParts.push(port);

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

        // 6. Automatically append index.html
        // If URL ends with /, or only has domain without path
        if (rawUrl.endsWith('/') || safeParts.length <= 2) { 
             safeParts.push('index.html');
        }

        // 7. Assemble final path
        if (isWayback) {
            // Wayback mode: websites/https/web.archive.org/web/TIMESTAMP/domain/path
            // web.archive.org is an HTTPS domain, so it lives under https/.
            // safeParts = [protocolDir, hostname, ...pathParts]
            // Insert 'web.archive.org/web/ts' between protocolDir and hostname
            return path.join(CONFIG.baseDir, 'https', 'web.archive.org', 'web', ts, ...safeParts.slice(1));
        } else {
            // Direct link mode: websites/http/domain/path
            return path.join(CONFIG.baseDir, ...safeParts);
        }

    } catch (e) {
        // If the URL format is so bad that even new URL() can't parse it, skip
        console.error(`Skipping invalid URL format: ${inputUrl}`);
        return null;
    }
}

/**
 * General download function
 */
function downloadFile(url, suggestedPath, redirectCount = 0) {
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
                downloadFile(newUrl, suggestedPath, redirectCount + 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(`HTTP ${res.statusCode}`);
                return;
            }

            // Intelligent extension completion (if path has no extension, complete based on header)
            let finalDest = suggestedPath;
            const currentExt = path.extname(finalDest);
            
            if (!currentExt) {
                const ct = res.headers['content-type'] || '';
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
            
            if (downloaded.has(url)) continue;

            // Get storage path
            const dest = getLocalPath(url);
            
            if (!dest) {
                // If parsing fails, don't error, just skip
                // console.log(`[Thread ${id}] Skipped invalid URL`);
                continue; 
            }

            // Local file existence check
            let skip = false;
            // Check if file itself exists
            if (fs.existsSync(dest) && fs.statSync(dest).isFile() && fs.statSync(dest).size > 0) skip = true;
            // Check if it already exists as index.html
            else if (fs.existsSync(path.join(dest, 'index.html')) && fs.statSync(path.join(dest, 'index.html')).size > 0) skip = true;
            
            if (skip) {
                downloaded.add(url);
                continue;
            }

            try {
                await downloadFile(url, dest);
                // Print slightly shorter logs
                const displayUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
                console.log(`[Thread ${id}] OK: ${displayUrl}`);
                downloaded.add(url);
            } catch (err) {
                console.log(`[Thread ${id}] FAIL: ${err} | ${url.substring(0, 50)}...`);
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