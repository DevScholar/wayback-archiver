/**
 * server.js (XP Compatible Edition)
 * 
 * Features:
 * 1. HTML4 directory listing style compatible with IE6/7/8 (no Emoji, using Table layout).
 * 2. Prioritizes loading index.html from the same directory as the script (generated homepage).
 * 3. Archive content is still looked up in the websites folder.
 * 4. Includes external link forced localization fix.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeSegment, escapeHtml, isPathInside, loadConfig } = require('./common');

const PORT = 8080;

// Read save location from config.json
const serverConfig = loadConfig();

// Directory where archive files are stored (also contains index.html)
const ARCHIVE_DIR = serverConfig.currentSaveLocation;

const CLEAN_WAYBACK_INJECTIONS = true;

const INFRASTRUCTURE_DOMAINS = [
    'archive.org', 'web.archive.org', 'web-static.archive.org',
    'analytics.archive.org', 'polyfill.archive.org'
];

const MIME_TYPES = {
    '.html': 'text/html', '.htm': 'text/html', '.asp': 'text/html', '.aspx': 'text/html',
    '.php': 'text/html', '.cfm': 'text/html', '.shtml': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.ico': 'image/x-icon', '.txt': 'text/plain', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};

function getLocalExternalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

function sanitize(name) {
    return sanitizeSegment(name);
}

// ---- Generate directory listing (XP/IE6 compatible style) ----
function serveDirectoryListing(res, dirPath, requestUrl) {
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
            res.writeHead(500);
            return res.end("Error reading directory");
        }

        const parentDir = path.posix.dirname(requestUrl);
        const isRoot = requestUrl === '/' || requestUrl === '';
        
        // Sorting
        files.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        // Generate HTML 4.01 Strict (table layout, no CSS3, no Emoji)
        let html = `
<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>Index of ${escapeHtml(requestUrl)}</title>
<style type="text/css">
  body { font-family: Verdana, Arial, sans-serif; font-size: 10pt; background-color: #FFFFFF; color: #000000; }
  h2 { margin-bottom: 10px; border-bottom: 1px solid #000000; padding-bottom: 5px; }
  table { border-collapse: collapse; width: 100%; border: 1px solid #CCCCCC; }
  th { background-color: #EFEFEF; text-align: left; padding: 4px; border-bottom: 1px solid #CCCCCC; font-size: 9pt; }
  td { padding: 4px; border-bottom: 1px solid #EEEEEE; font-size: 9pt; }
  a { text-decoration: none; color: #000080; }
  a:hover { text-decoration: underline; color: #FF0000; }
  .type { font-family: "Courier New", Courier, monospace; font-weight: bold; color: #555555; }
  .size { text-align: right; color: #666666; }
</style>
</head>
<body>
<h2>Index of ${escapeHtml(requestUrl)}</h2>
<table cellspacing="0">
<tr><th width="50">Type</th><th>Name</th><th width="80" align="right">Size</th></tr>`;

        if (!isRoot) {
            const parentHref = parentDir === '.' ? '/' : parentDir;
            html += `<tr><td class="type">[DIR]</td><td><a href="${escapeHtml(parentHref)}">[ Parent Directory ]</a></td><td>-</td></tr>`;
        }

        files.forEach(file => {
            let name = file.name;
            // Build the URL with POSIX joins so we always get forward slashes,
            // regardless of the host OS.
            let href = path.posix.join(requestUrl, name);
            let typeStr = file.isDirectory() ? '[DIR]' : '[FILE]';
            let sizeStr = '-';

            if (file.isDirectory()) {
                href += '/';
            } else {
                try {
                    const stats = fs.statSync(path.join(dirPath, name));
                    sizeStr = (stats.size / 1024).toFixed(1) + ' KB';
                } catch(e) {}
            }

            html += `<tr>
                <td class="type">${typeStr}</td>
                <td><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></td>
                <td class="size">${sizeStr}</td>
            </tr>`;
        });

        html += `</table>
<hr>
<div style="font-size: 8pt; color: #888888;">Wayback Server (XP Edition)</div>
</body></html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
}

function findFileSmart(baseDir, relativeUrlPath) {
    if (!fs.existsSync(baseDir)) return null;

    let processedPath = relativeUrlPath
        .replace(/^https?:\/\//, (match) => match.startsWith('https') ? 'https/' : 'http/')
        .replace(/:\d+/, (port) => `/${port.replace(':', '')}`);

    let parts = processedPath.split('/').filter(p => p && p !== '.');
    if (parts.length === 0) {
        // First check if there is a default homepage
        const idx = path.join(baseDir, 'index.html');
        if (fs.existsSync(idx)) return idx;
        const defHtm = path.join(baseDir, 'default.htm');
        if (fs.existsSync(defHtm)) return defHtm;
        return null;
    }

    function searchRecursive(currentDir, currentParts) {
        if (currentParts.length === 0) {
            if (fs.existsSync(currentDir) && fs.statSync(currentDir).isFile()) return currentDir;
            const idx = path.join(currentDir, 'index.html');
            if (fs.existsSync(idx)) return idx;
            return null;
        }

        const rawPart = currentParts[0];
        const targetPartLower = sanitize(rawPart).toLowerCase(); 
        const remain = currentParts.slice(1);

        if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) return null;

        const items = fs.readdirSync(currentDir);
        const currentDirName = path.basename(currentDir);
        const isProtocolDir = (currentDirName === 'http' || currentDirName === 'https');

        for (const item of items) {
            const itemLower = item.toLowerCase();
            let isMatch = false;

            if (itemLower === targetPartLower) isMatch = true;
            else if (isProtocolDir) {
                if (itemLower === 'www.' + targetPartLower) isMatch = true;
                if ('www.' + itemLower === targetPartLower) isMatch = true;
            }

            if (isMatch) {
                const res = searchRecursive(path.join(currentDir, item), remain);
                if (res) return res;
            }
        }
        return null; 
    }

    let found = searchRecursive(baseDir, parts);
    if (found) return found;

    if (parts.length > 0 && !parts[0].startsWith('http')) {
        let tryHttp = searchRecursive(baseDir, ['http', ...parts]);
        if (tryHttp) return tryHttp;
    }
    return null;
}

// Link rewriting (maintain repair functionality)
function rewriteLinksForWayback(buffer, timestamp, host) {
    let content = buffer.toString('latin1');

    // ── Wayback Machine injection treatment ──────────────────────
    //
    // Rather than blindly stripping the entire head-injection block we
    // KEEP wombat.js / bundle-playback.js so the client-side rewriting
    // engine still runs.  What we DO strip:
    //   • the visible toolbar UI (<!-- BEGIN WAYBACK TOOLBAR INSERT --> …)
    //   • athena.js (archive analytics – useless offline)
    //   • the archive_analytics inline snippet
    //   • Ruffle (Flash emulator – not needed)
    //
    // The remaining pieces (wombat.js, bundle-playback.js, banner CSS /
    // iconochive CSS) are served from local disk via the /_static/ route
    // so the page never touches the real web.archive.org.
    if (CLEAN_WAYBACK_INJECTIONS) {

        // 1. Toolbar UI (the visible banner inside <body>)
        content = content.replace(
            /<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi,
            ''
        );

        // 2. athena.js + its inline archive_analytics snippet
        content = content.replace(
            /<script[^>]*src=["'][^"']*athena\.js["'][^>]*>[\s\S]*?<\/script>/gi,
            ''
        );
        content = content.replace(
            /<script[^>]*>\s*window\.addEventListener\('DOMContentLoaded'[\s\S]*?archive_analytics\.send_pageview\(\{[\s\S]*?\}\);\s*<\/script>/gi,
            ''
        );

        // 3. Ruffle (Flash emulator – not needed)
        content = content.replace(
            /<script>\s*window\.RufflePlayer[\s\S]*?<\/script>/gi,
            ''
        );
        content = content.replace(
            /<script[^>]*src=["'][^"']*ruffle[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
            ''
        );

        // 4. Rewrite resource URLs in the head injection from
        //    https://web-static.archive.org/_static/…  →  /_static/…
        //    (wombat.js, bundle-playback.js, banner CSS, iconochive CSS, ruffle)
        content = content.replace(
            /https?:\/\/web-static\.archive\.org\/_static\//gi,
            '/_static/'
        );

        // 5. Rewrite wombat.js runtime configuration for the local server.
        //    __wm.init and __wm.wombat need absolute http://<host>/… URLs
        //    so wombat / bundle-playback.js can construct valid URL objects
        //    and route all requests back to us instead of real archive.org.
        if (host) {
            const localOrigin = `http://${host}`;
            // __wm.init – prefix wombat uses to recognise already-rewritten URLs
            content = content.replace(
                /__wm\.init\([“'][^”']*[“']\)/g,
                `__wm.init(“${localOrigin}/web”)`
            );
            // __wm.wombat 3rd arg – the replay host origin
            content = content.replace(
                /”https?:\/\/web\.archive\.org\/”/g,
                `”${localOrigin}/”`
            );
        }

        // 6. Remove the end marker (it's a harmless comment)
        content = content.replace(/<!-- End Wayback Rewrite JS Include -->/gi, '');
    }

    // ── Link rewriting (attribute-level) ─────────────────────────
    // Still needed for static HTML attributes that reference external
    // (non-archived) URLs.  wombat handles the runtime / JS-constructed
    // cases; we handle the markup so the browser never hits the real
    // archive.org on first paint.

    const prefix = `/web/${timestamp}/`;
    const regex = /(href|src|action|background)=["'](.*?)["']/gi;

    content = content.replace(regex, (match, attr, url) => {
        if (/^https?:\/\/(www\.)?web\.archive\.org\/web\//i.test(url)) {
            const localRelativeUrl = url.replace(/^https?:\/\/(www\.)?web\.archive\.org/i, '');
            return `${attr}="${localRelativeUrl}"`;
        }
        if (url.startsWith('/web/')) return match;
        if (!url.startsWith('http')) return match;

        let domainStr = url.replace(/^https?:\/\//, '').split('/')[0];
        if (domainStr) domainStr = domainStr.toLowerCase();

        if (INFRASTRUCTURE_DOMAINS.includes(domainStr)) {
            const cleanPath = url.replace(/^https?:\/\//, '');
            return `${attr}="/${cleanPath}"`;
        }
        return `${attr}="${prefix}${url}"`;
    });

    content = content.replace(/url\(['"]?(http.*?)['"]?\)/gi, (match, url) => {
        if (/^https?:\/\/(www\.)?web\.archive\.org\/web\//i.test(url)) {
            const localRelativeUrl = url.replace(/^https?:\/\/(www\.)?web\.archive\.org/i, '');
            return `url('${localRelativeUrl}')`;
        }
        if (url.includes('/web/')) return match;
        return `url('${prefix}${url}')`;
    });

    // Catch-all: rewrite remaining web.archive.org/web/<ts>/… URLs
    // regardless of context (inline JS strings, <meta> tags, srcset,
    // <object data>, protocol-relative URLs, etc.).
    //
    // IMPORTANT: this runs AFTER the head-injection rewriting above,
    // so wombat config URLs (already rewritten to  "/web"  and  "/")
    // are NOT matched by this pass.
    content = content.replace(
        /(?:https?:)?\/\/(?:www\.)?web\.archive\.org\/web\/(\d{4,14})/gi,
        '/web/$1'
    );

    return Buffer.from(content, 'latin1');
}

function findWaybackArchive(targetTs, rawUrlPath) {
    // rawUrlPath comes from the wayback regex capture and may be:
    //   "http://host/path"  (from link rewriting, double-slash protocol)
    //   "http/host/path"    (old style, single-slash protocol dir)
    //   "host/path"         (from index.html links, no protocol prefix at all)
    // The on-disk layout is: <ARCHIVE_DIR>/https/web.archive.org/web/<ts>/<host>/<path>
    // So we strip any protocol prefix and keep just <host>/<path>.

    // 1. Strip protocol:// prefix (e.g. "http://example.com/..." → "example.com/...")
    let restPath = rawUrlPath.replace(/^https?:\/\//i, '');

    // 2. Strip protocol/ prefix (e.g. "http/example.com/..." → "example.com/...")
    restPath = restPath.replace(/^https?\/|^ftp\//i, '');

    const waybackBase = path.join(ARCHIVE_DIR, 'https', 'web.archive.org', 'web');
    if (!fs.existsSync(waybackBase)) return null;

    // targetTs may carry the Wayback flags suffix (e.g. "20011215022550cs_").
    // Compare on the numeric timestamp, but prefer the exact ts+flags dir.
    let normalizedTs = (targetTs.match(/^\d+/) || [''])[0].padEnd(14, '0').substring(0, 14);
    const targetTime = parseInt(normalizedTs);

    let tsDirs;
    try {
        tsDirs = fs.readdirSync(waybackBase).filter(t => /^\d{4,14}([a-z]{2}_)?$/.test(t));
    } catch (e) { return null; }

    // Fast path: exact timestamp+flags directory. Also resolves ties when the
    // same timestamp has several flag variants (id_, im_, cs_, js_, …).
    if (fs.existsSync(path.join(waybackBase, targetTs))) {
        const exactFile = findFileSmart(path.join(waybackBase, targetTs), restPath);
        if (exactFile) return { ts: targetTs, fullPath: exactFile };
    }

    let bestMatch = null;
    let minDiff = Infinity;

    for (const tsDir of tsDirs) {
        const tsNumStr = tsDir.match(/^\d+/)[0].padEnd(14, '0');
        const currentDiff = Math.abs(parseInt(tsNumStr) - targetTime);

        const timestampPath = path.join(waybackBase, tsDir);
        const foundFile = findFileSmart(timestampPath, restPath);

        if (foundFile) {
            if (currentDiff < minDiff) {
                minDiff = currentDiff;
                bestMatch = { ts: tsDir, fullPath: foundFile };
            }
            if (currentDiff === 0) break;
        }
    }
    return bestMatch;
}

function serveFile(res, filePath, rewriteTs = null, host = null) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    const isTextWeb = ['.html', '.htm', '.asp', '.php', '.aspx', '.cfm', '.shtml'].includes(ext);
    const isCss = (ext === '.css');
    const isJs = (ext === '.js');

    // Only files whose bytes we must inspect (charset sniffing) or rewrite
    // (Wayback link fixup) need to sit in memory.  Archived JS files must
    // also be buffered so the catch-all can rewrite static web.archive.org
    // URLs in string literals (e.g. toolbar.js tracking pixels).
    // IMPORTANT: /_static/ assets are served via streamFile() directly,
    // so wombat.js itself is NEVER buffered and rewritten.
    const needsBuffer = isTextWeb || ((isCss || isJs) && rewriteTs);

    if (!needsBuffer) {
        streamFile(res, filePath, mime);
        return;
    }

    fs.readFile(filePath, (err, buf) => {
        if (err) {
            console.error("Error serving:", filePath, err.message);
            const notFound = err.code === 'ENOENT';
            res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'text/plain' });
            res.end(notFound ? '404 Not Found' : 'Server Error');
            return;
        }

        let content = buf;
        if (rewriteTs && (isTextWeb || isCss || isJs)) {
            content = rewriteLinksForWayback(content, rewriteTs, host);
        }

        let detectedCharset = null;
        if (isTextWeb) {
            // Use a generous window: Wayback injects a large header block
            // (scripts + toolbar) before the page's real <meta> declaration.
            const headSnippet = content.subarray(0, 8192).toString('latin1');

            // IMPORTANT: only trust charset declared *inside a <meta> tag* (the
            // real document encoding). Wayback-injected <script ... charset="utf-8">
            // tags appear first in the archived HTML; matching charset= anywhere
            // would pick up "utf-8" from those scripts and wrongly override the
            // page's real charset (e.g. iso-8859-1), corrupting the rendering.
            const metaHttpEquiv = headSnippet.match(
                /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*["']?([a-zA-Z0-9\-_]+)/i
            );
            const metaCharset = headSnippet.match(
                /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9\-_]+)/i
            );
            if (metaHttpEquiv) detectedCharset = metaHttpEquiv[1];
            else if (metaCharset) detectedCharset = metaCharset[1];
        }

        // When no charset is declared in the page, default to iso-8859-1 via the
        // HTTP header so the browser doesn't guess wrong (e.g. legacy Western
        // European pages without a <meta charset> would otherwise be misread as
        // UTF-8). This does NOT modify the file content in memory.
        const headers = { 'Content-Type': detectedCharset ? `${mime}; charset=${detectedCharset}` : (isTextWeb ? `${mime}; charset=iso-8859-1` : mime) };
        res.writeHead(200, headers);
        res.end(content);
    });
}

// Stream a file to the client without buffering it in memory.
function streamFile(res, filePath, mime) {
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        // Content-Length keeps legacy browsers (IE6) happy and lets them show
        // download progress instead of relying on chunked transfer encoding.
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stats.size });

        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => {
            console.error("Error streaming:", filePath, e.message);
            res.destroy(); // Headers already sent; abort the connection.
        });
        stream.pipe(res);
    });
}

const server = http.createServer((req, res) => {
    let reqUrl = req.url;
    if (/^https?:\/\//.test(reqUrl)) reqUrl = reqUrl.replace(/^https?:\/\/[^\/]+/, '');

    // === Specifically handle root path requests (support externally generated index.html) ===
    if (reqUrl === '/' || reqUrl === '/index.html') {
        const externalIndex = path.join(ARCHIVE_DIR, 'index.html');
        if (fs.existsSync(externalIndex)) {
            console.log('[Root] Serving index.html from archive');
            serveFile(res, externalIndex, null);
            return;
        }
    }

    // === 1. Serve Wayback static assets (wombat.js, bundle-playback.js,
    //     banner CSS, fonts, …) from local disk.  The head-injection
    //     rewriter maps https://web-static.archive.org/_static/ → /_static/
    //     so these are served locally instead of hitting archive.org. ===
    if (reqUrl.startsWith('/_static/')) {
        let staticPath = reqUrl.replace(/\?.*$/, '');          // drop cache busters
        staticPath = decodeURIComponent(staticPath);
        const localFsPath = path.join(ARCHIVE_DIR, 'https',
            'web-static.archive.org', '_static',
            staticPath.replace(/^\/_static\//, ''));
        if (fs.existsSync(localFsPath) && fs.statSync(localFsPath).isFile()) {
            const ext = path.extname(localFsPath).toLowerCase();
            const mime = MIME_TYPES[ext] || 'application/octet-stream';
            streamFile(res, localFsPath, mime);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
        }
        return;
    }

    // === 2. Process Wayback format requests ===
    const wbRegex = /^\/(?:https?\/)?(?:web\.archive\.org\/)?web\/(\d{4,14})([a-z0-9_]+)?\/(.*)/;
    const waybackMatch = reqUrl.match(wbRegex);

    if (waybackMatch) {
        // Keep the flags suffix (cs_, im_, js_, …) so we serve the exact
        // variant the URL asks for, not just any dir at the same timestamp.
        const requestTs = waybackMatch[1] + (waybackMatch[2] || '');
        let targetUrl = waybackMatch[3];
        // Strip query string and fragment — they are not part of the file path on disk.
        targetUrl = targetUrl.replace(/[?#].*$/, '');

        const match = findWaybackArchive(requestTs, targetUrl);
        if (match) {
            serveFile(res, match.fullPath, match.ts, req.headers.host); 
            return;
        } else {
            console.log(`[404 Wayback] Not found: ${targetUrl}`);
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end(`404: Page not found locally.`);
            return;
        }
    }

    // === 3. Process regular file/directory browsing (limited to ARCHIVE_DIR) ===
    let searchPath = reqUrl.replace(/\?.*$/, '');
    if (searchPath.startsWith('/')) searchPath = searchPath.substring(1);
    searchPath = decodeURIComponent(searchPath);

    // Prioritize searching for files in ARCHIVE_DIR (websites folder)
    const foundPath = findFileSmart(ARCHIVE_DIR, searchPath);
    
    if (foundPath) {
        serveFile(res, foundPath, null); 
    } else {
        // If file not found, check if it's a physical directory, then display list
        let physicalPath = path.join(ARCHIVE_DIR, searchPath);
        
        if (!fs.existsSync(physicalPath) && searchPath.includes(':/')) {
             let fixedSearch = searchPath.replace(':/', '/');
             physicalPath = path.join(ARCHIVE_DIR, fixedSearch);
        }

        if (fs.existsSync(physicalPath) && fs.statSync(physicalPath).isDirectory()
            && isPathInside(physicalPath, ARCHIVE_DIR)) {
            serveDirectoryListing(res, physicalPath, reqUrl);
        } else {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('404 Not Found');
        }
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalExternalIP();
    console.log(`\n=== Wayback Server (XP Compatible) ===`);
    console.log(`- Local Access: http://localhost:${PORT}`);
    console.log(`- LAN/VM Access: http://${ip}:${PORT}`);
    console.log(`- Archive Dir:  ${ARCHIVE_DIR}`);
    console.log('- Index:    ' + path.join(ARCHIVE_DIR, 'index.html'));
    console.log(`\nReady for legacy browsers...`);
});