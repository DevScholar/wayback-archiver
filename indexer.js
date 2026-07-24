/**
 * indexer.js
 * IE6 Compatible Version
 * Generates an HTML 4.01 index page optimized for older browsers (IE6, Netscape).
 */

const fs = require('fs');
const path = require('path');
const { escapeHtml, loadConfig } = require('./common');

// === Configuration ===
const config = loadConfig();

const CONFIG = {
    rootDir: config.currentSaveLocation,
    outputFile: path.join(config.currentSaveLocation, 'index.html'),
    
    // Extensions considered as web pages
    pageExtensions: ['.html', '.htm', '.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp'],
    
    // Ignore list
    ignoreList: [
        'node_modules', 
        'download_state.json', 
        'filename_mapping.json', 
        '__MACOSX', 
        '.DS_Store',
        'http_', 'https_'
    ]
};

let foundPages = [];

function scanDir(directory) {
    if (!fs.existsSync(directory)) return;
    let items;
    try { items = fs.readdirSync(directory); } catch (e) { return; }

    items.forEach(item => {
        if (item.startsWith('.') || CONFIG.ignoreList.includes(item)) return;
        
        const fullPath = path.join(directory, item);
        let stat;
        try { stat = fs.statSync(fullPath); } catch (e) { return; }

        if (stat.isDirectory()) {
            scanDir(fullPath);
        } else {
            if (stat.size > 0 && isWebPage(item, fullPath)) {
                addPageToIndex(fullPath, stat);
            }
        }
    });
}

// Extensions that may not be served as HTML, but whose content might be.
const NON_NATIVE_EXT = new Set(['.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp']);

function isWebPage(filename, fullPath) {
    if (fullPath.includes('screenshot')) return false;

    const ext = path.extname(filename).toLowerCase();
    const nameNoExt = path.parse(filename).name.toLowerCase();

    // Known web-page extensions
    if (CONFIG.pageExtensions.includes(ext)) return true;
    // No extension, common index names
    if (ext === '' && ['index', 'default', 'home', 'welcome', 'main'].includes(nameNoExt)) return true;

    // For server-side extensions (.asp, .php, etc.), sniff content:
    // if the first 4 KB contain <html, treat it as a web page.
    if (NON_NATIVE_EXT.has(ext)) {
        try {
            const fd = fs.openSync(fullPath, 'r');
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            return /<html/i.test(buf.toString('latin1', 0, n));
        } catch (e) {
            return false;
        }
    }

    return false;
}

function addPageToIndex(fullPath, stat) {
    let relativePath = path.relative(CONFIG.rootDir, fullPath).split(path.sep).join('/');

    let pageInfo = {
        filePath: relativePath,
        link: relativePath, 
        size: Math.ceil(stat.size / 1024) + 'KB',
        dateRaw: stat.mtimeMs,
        dateDisplay: '',
        domain: '', // Will be filled below
        type: 'Standard'
    };

    // Regex for Wayback structure
    const waybackMatch = relativePath.match(/web\.archive\.org\/web\/(\d{14})[a-z0-9_]*\/(.*)/);

    if (waybackMatch) {
        const timestamp = waybackMatch[1];
        const contentPath = waybackMatch[2]; 

        // Add spaces for readability in old browsers
        const dateStr = timestamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5');
        
        const parts = contentPath.split('/');
        let extractedDomain = 'archive.org';
        if (parts.length >= 1 && parts[0]) {
            extractedDomain = parts[0];
        }

        pageInfo.type = 'Wayback';
        pageInfo.dateDisplay = dateStr;
        pageInfo.domain = extractedDomain;
        pageInfo.dateRaw = parseInt(timestamp);

    } else {
        const pathParts = relativePath.split('/');
        pageInfo.domain = pathParts[0]; 

        const mtime = new Date(stat.mtime);
        pageInfo.dateDisplay = mtime.toISOString().replace('T', ' ').substring(0, 16);
        pageInfo.type = 'Direct';
    }

    foundPages.push(pageInfo);
}

function generateHtml() {
    // Sort logic
    foundPages.sort((a, b) => {
        if (a.domain < b.domain) return -1;
        if (a.domain > b.domain) return 1;
        return b.dateRaw - a.dateRaw; 
    });

    // === IE6 Styled HTML ===
    // 1. DTD HTML 4.01
    // 2. Simple Tables
    // 3. Verdana Font (The Windows XP Classic)
    // 4. Manual row coloring (IE6 gives no support for nth-child)
    
    let html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>Local Web Mirror Index</title>
<style type="text/css">
    body { background-color: #FFFFFF; font-family: Verdana, Tahoma, Arial, sans-serif; font-size: 11px; margin: 15px; color: #000000; }
    h1 { font-size: 16px; color: #003399; border-bottom: 2px solid #003399; padding-bottom: 5px; margin-bottom: 15px; }
    
    table { width: 100%; border-collapse: collapse; border: 1px solid #999999; }
    th { background-color: #ECE9D8; border: 1px solid #999999; padding: 4px; text-align: left; font-weight: bold; color: #333333; }
    td { border: 1px solid #999999; padding: 3px 5px; vertical-align: middle; }
    
    /* IE6 Zebra Striping Helper */
    .row-alt { background-color: #F7F7F7; }
    .row-norm { background-color: #FFFFFF; }
    tr.row-norm:hover, tr.row-alt:hover { background-color: #FFFFCC; }

    a { color: #0000CC; text-decoration: none; }
    a:hover { text-decoration: underline; color: #FF0000; }
    
    /* Simple Badges without Border-Radius */
    .b-wb { font-size: 10px; color: #FFFFFF; background-color: #CC6600; padding: 1px 3px; font-weight: bold; border: 1px solid #993300; }
    .b-dir { font-size: 10px; color: #FFFFFF; background-color: #0066CC; padding: 1px 3px; font-weight: bold; border: 1px solid #003399; }
    
    .dom { font-weight: bold; color: #333333; }
    .sml { color: #666666; font-size: 10px; }
    .footer { margin-top: 15px; font-size: 10px; color: #999999; text-align: center; border-top: 1px solid #CCCCCC; padding-top: 5px;}
</style>
</head>
<body>

<h1>Local Web Archive Index (${foundPages.length} Pages)</h1>

<table cellpadding="0" cellspacing="0">
    <tr>
        <th width="80">Type</th>
        <th width="140">Date</th>
        <th width="180">Domain</th>
        <th>Path</th>
        <th width="60">Size</th>
    </tr>
    ${foundPages.map((p, i) => {
        // Manual alternating row Logic for IE6 (no :nth-child support)
        const rowClass = (i % 2 === 0) ? 'row-norm' : 'row-alt';
        const badgeClass = p.type === 'Wayback' ? 'b-wb' : 'b-dir';
        
        return `
    <tr class="${rowClass}">
        <td align="center"><span class="${badgeClass}">${escapeHtml(p.type.toUpperCase())}</span></td>
        <td class="sml">${escapeHtml(p.dateDisplay)}</td>
        <td class="dom">${escapeHtml(p.domain)}</td>
        <td><a href="${escapeHtml(p.link)}" target="_blank">${escapeHtml(p.filePath)}</a></td>
        <td class="sml" align="right">${escapeHtml(p.size)}</td>
    </tr>`;
    }).join('\n')}
</table>

<div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; Best viewed in Internet Explorer 6
</div>

</body>
</html>`;

    fs.writeFileSync(CONFIG.outputFile, html);
    console.log(`\n=== Index Generated (IE6 Style) ===`);
    console.log(`Total Pages: ${foundPages.length}`);
}

// === Execution ===
if (!fs.existsSync(CONFIG.rootDir)) {
    console.error(`Error: '${CONFIG.rootDir}' not found.`);
} else {
    console.log(`Scanning...`);
    scanDir(CONFIG.rootDir);
    if (foundPages.length === 0) {
        console.log("No web pages found.");
    } else {
        generateHtml();
    }
}