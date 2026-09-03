/**
 * export-to-html.ts
 *
 * Exports a WACZ archive into a standalone, flat folder of files that can be
 * browsed directly from the filesystem (file://) without a server.
 *
 * Naming: every extracted file is named `<prefix>~<n><ext>` where `<prefix>`
 * is the first five characters of the original file name (the URL's basename),
 * lowercased, and `<n>` is a counter that disambiguates files sharing a
 * prefix. The extension is taken from the URL when present, otherwise derived
 * from the content type (text/html -> .html, image/jpeg -> .jpg, ...),
 * otherwise omitted -- matching examples like `about~1.html`, `infor~2.asp`,
 * `cdx~1`.
 *
 * Two metadata files are written to the output root:
 *   urls.csv   -- "File Name,Timestamp,Original URLs" mapping, timestamps in
 *                WACZ-compatible RFC3339 form.
 *   index.html -- a pre-generated index page (the replay server also generates
 *                this on demand).
 *
 * Usage:
 *   npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wacz, ResolvedRecord } from '../archive/wacz';
import { CdxjEntry } from '../archive/cdxj';
import { lookupKey, lookupVariants, lookupPathKey, lookupKeyCi } from '../lib/url';
import { renderIndexPage, buildPageRows, IndexRow } from '../replay/index-page';
import { cdxjTsToRfc3339, rfc3339ToTs14 } from '../lib/time';
import { createExportPipeline, ReplayContext, FLAT_NOT_FOUND_FILE } from '../replay/plugins';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { wacz: string; out: string } {
    let wacz = '';
    let out = '';
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') {
            out = argv[++i] || '';
        } else if (a.startsWith('--out=')) {
            out = a.slice('--out='.length);
        } else if (!a.startsWith('--')) {
            positional.push(a);
        }
    }
    if (positional.length > 0) wacz = positional[0];
    if (!wacz) {
        console.error('Usage: npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>]');
        process.exit(1);
    }
    if (!out) {
        out = path.join(path.dirname(path.resolve(wacz)), path.basename(wacz, '.wacz') + '-html');
    }
    return { wacz: path.resolve(wacz), out: path.resolve(out) };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Map a content-type (or CDXJ mime) to a file extension, or '' if unknown. */
function extFromMime(mime: string): string {
    const m = mime.toLowerCase();
    if (m.includes('text/html')) return '.html';
    if (m.includes('image/jpeg')) return '.jpg';
    if (m.includes('image/png')) return '.png';
    if (m.includes('image/gif')) return '.gif';
    if (m.includes('image/svg')) return '.svg';
    if (m.includes('text/css')) return '.css';
    if (m.includes('javascript')) return '.js';
    if (m.includes('application/json')) return '.json';
    if (m.includes('text/plain')) return '.txt';
    if (m.includes('image/bmp')) return '.bmp';
    if (m.includes('image/x-icon') || m.includes('image/vnd.microsoft.icon')) return '.ico';
    return '';
}

/** Strip characters that are illegal in filenames on Windows/Linux. */
function sanitizeName(s: string): string {
    return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/**
 * Server-side / SSI page extensions that produce HTML bodies but are not
 * recognized as HTML by a browser reading straight from disk. Under `file://`
 * the browser infers MIME from the file extension alone, so leaving these as
 * `.asp`/`.shtml`/… makes the browser render the raw markup (or offer to
 * download it) instead of displaying the page. When such a resource is
 * actually HTML, its flat file is renamed to `.html`.
 */
const HTML_SCRIPT_EXTS = new Set(['.asp', '.aspx', '.php', '.cfm', '.cgi', '.jsp', '.shtml']);

/**
 * Top-level domains that show up as the tail of a bare hostname when a URL is
 * just a domain root — e.g. `http://www.microsoft.com/` seen through a Wayback
 * replay URL gives basename `www.microsoft.com`. `splitName` then splits at the
 * last dot and treats `.com`/`.org`/… as if they were file extensions, but a
 * browser under `file://` has no MIME for them and offers to download the page
 * instead of rendering it. Like the SSI extensions above, a TLD "extension" on
 * an HTML resource is rewritten to `.html`.
 */
const DOMAIN_TLDS = new Set([
    '.com', '.org', '.net', '.edu', '.gov', '.mil', '.int',
    '.io', '.co', '.tv', '.me', '.cc', '.info', '.biz', '.name', '.mobi', '.asia',
    '.uk', '.us', '.ca', '.au', '.nz', '.de', '.fr', '.it', '.es', '.nl', '.se',
    '.no', '.dk', '.fi', '.at', '.be', '.ch', '.pl', '.cz', '.sk', '.hu', '.gr',
    '.pt', '.ru', '.cn', '.jp', '.kr', '.tw', '.hk', '.sg', '.in', '.br', '.mx',
    '.za', '.ar', '.cl', '.tr', '.il', '.ie', '.is',
]);

/** Rewrite extensions that are not real file types, but only when the resource
 * is known:
 *
 *   - A bare-hostname TLD (`.com`, `.org`, …) is never a real file extension:
 *     under `file://` the browser has no MIME for it and offers to download the
 *     resource instead of rendering it. Fall back to the content-type's own
 *     extension — a page becomes `.html`, a `urn:view:` screenshot becomes
 *     `.png`, and so on.
 *   - A server-side script extension (`.php`, `.asp`, …) on an HTML body must
 *     become `.html`; the same suffix on a JSON or image response keeps its own
 *     identity. */
function normalizeExt(ext: string, mime: string): string {
    const fromMime = extFromMime(mime);
    if (DOMAIN_TLDS.has(ext)) return fromMime || ext;
    if (HTML_SCRIPT_EXTS.has(ext) && fromMime === '.html') return '.html';
    return ext;
}

interface NameParts {
    stem: string;
    urlExt: string;
}

function urlBasename(url: string): string {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = '';
    }
    let base = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    base = base.slice(base.lastIndexOf('/') + 1);
    if (base === '') base = 'index';
    try {
        base = decodeURIComponent(base);
    } catch {
        /* keep raw */
    }
    return sanitizeName(base);
}

function splitName(url: string): NameParts {
    const base = urlBasename(url);
    const dot = base.lastIndexOf('.');
    if (dot > 0) {
        return { stem: base.slice(0, dot), urlExt: base.slice(dot).toLowerCase() };
    }
    return { stem: base, urlExt: '' };
}

/**
 * Identity of a single capture: normalized URL + 14-digit timestamp. Two
 * captures of the same URL at different times are distinct pages and must each
 * be exported (a multi-capture archive lists every version). The 14-digit
 * timestamp is the shared unit here: pages.jsonl carries second precision and
 * the restorer stamps whole seconds, so it uniquely identifies a capture.
 */
function captureKey(url: string, ts14: string): string {
    return lookupKey(url) + ' ' + ts14;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(field: string): string {
    const s = String(field);
    if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/** Minimal, self-contained "not saved" page. The inline script reads the
 * original URL out of the `?url=` query parameter and shows it. It runs fine
 * under file:// (no server, no fetch). No CSS, and written to render on
 * Internet Explorer 6. */
function renderNotFoundPage(): string {
    return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>URL not saved</title>
</head>
<body>
<h1>This URL was not saved in the archive</h1>
<p>The following address is not present in this export:</p>
<p id="url"></p>
<script type="text/javascript">
(function () {
  var m = /[?&]url=([^&]+)/.exec(location.search);
  var url = '';
  if (m) {
    try { url = decodeURIComponent(m[1].replace(/\\+/g, ' ')); } catch (e) { url = m[1]; }
  }
  var el = document.getElementById('url');
  if (el) {
    el.innerText = url || '(unknown URL)';
  }
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    const { wacz: waczPath, out: outDir } = parseArgs(process.argv.slice(2));

    console.log('=== WACZ Export to HTML ===');
    console.log('Archive:  ' + waczPath);
    console.log('Output:   ' + outDir);

    const wacz = new Wacz(waczPath);

    // Deduplicate entries by capture (normalized URL + timestamp), keeping the
    // first occurrence of a true duplicate. Distinct timestamps of the same URL
    // are distinct captures and must each be exported -- a multi-capture archive
    // (e.g. the same Microsoft homepage in 1996 and 1998) lists every version.
    const seen = new Set<string>();
    const unique: CdxjEntry[] = [];
    for (const e of wacz.entries) {
        const k = captureKey(e.url, e.timestamp.slice(0, 14));
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(e);
    }
    unique.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    console.log(`  ${unique.length} unique captures in index`);

    // Assign flat names to the entries we will actually export (200 responses,
    // skipping warc/revisit records).
    const exported = unique.filter((e) => e.mime !== 'warc/revisit' && (e.status == null || e.status === 200));

    const counters = new Map<string, number>();
    const flatName = new Map<string, string>(); // captureKey(url, ts14) -> flat name

    for (const e of exported) {
        const { stem, urlExt } = splitName(e.url);
        // Lowercase the prefix *after* slicing: some non-ASCII letters change
        // byte length when lowercased (U+00DF, U+0130), so slicing first keeps the prefix
        // a true "first five characters, lowercased". Lowercasing also makes the
        // stem consistent with the already-lowercased extension, and prevents
        // case-collisions (FOO.png vs foo.png) on case-insensitive filesystems.
        const prefix = sanitizeName(stem.slice(0, 5)).toLowerCase();
        const ext = normalizeExt(urlExt || extFromMime(e.mime), e.mime);
        const groupKey = prefix + '|' + ext;
        const n = (counters.get(groupKey) || 0) + 1;
        counters.set(groupKey, n);
        const name = `${prefix}~${n}${ext}`;
        flatName.set(captureKey(e.url, e.timestamp.slice(0, 14)), name);
    }

    // URL -> flat name, including www/protocol variants for link rewriting.
    const flatByKey = new Map<string, string>();
    // scheme/host/port/path -> flat name, any query: the fallback that makes a
    // cache-busted reference (theme.css?v=2) resolve to the stored variant.
    const flatPathByKey = new Map<string, string>();
    // lookupKeyCi(url) -> flat name: case-insensitive path fallback, tried last
    // so a differently-cased reference still resolves on legacy servers (old
    // IIS) where the page and the capture disagree on path case.
    const flatByKeyCi = new Map<string, string>();
    for (const e of exported) {
        const name = flatName.get(captureKey(e.url, e.timestamp.slice(0, 14)));
        if (!name) continue;
        for (const v of lookupVariants(e.url)) {
            const k = lookupKey(v);
            if (!flatByKey.has(k)) flatByKey.set(k, name);
        }
        const pk = lookupPathKey(e.url);
        if (!flatPathByKey.has(pk)) flatPathByKey.set(pk, name);
        const ck = lookupKeyCi(e.url);
        if (!flatByKeyCi.has(ck)) flatByKeyCi.set(ck, name);
    }

    // Redirects (301/302/...): the crawler stored a redirect record with a
    // `Location` header, not the final bytes. Map each redirect source URL to
    // the flat file of its final 200 target, following chains, so a link to
    // the source resolves locally instead of 404ing. The source itself is not
    // written as a file -- the browser would have followed it to the target.
    const redirectByKey = new Map<string, string>(); // lookupKey(src) -> abs target (one hop)
    for (const e of unique) {
        const s = e.status;
        if (typeof s !== 'number' || s < 300 || s >= 400) continue;
        let rec: ResolvedRecord;
        try {
            rec = wacz.resolveRecord(e.url)!;
        } catch {
            continue;
        }
        const loc = rec.record.httpHeaders.get('location');
        if (!loc) continue;
        let target: string;
        try {
            target = new URL(loc, e.url).href;
        } catch {
            continue;
        }
        redirectByKey.set(lookupKey(e.url), target);
    }
    const resolveRedirectChain = (url: string): string => {
        let cur = url;
        for (let i = 0; i < 8; i++) {
            const next = redirectByKey.get(lookupKey(cur));
            if (!next) break;
            cur = next;
        }
        return cur;
    };
    for (const e of unique) {
        const s = e.status;
        if (typeof s !== 'number' || s < 300 || s >= 400) continue;
        const final = resolveRedirectChain(e.url);
        const name = flatByKey.get(lookupKey(final));
        if (!name) continue;
        for (const v of lookupVariants(e.url)) {
            const k = lookupKey(v);
            if (!flatByKey.has(k)) flatByKey.set(k, name);
        }
        const pk = lookupPathKey(e.url);
        if (!flatPathByKey.has(pk)) flatPathByKey.set(pk, name);
    }

    // `flatByKey` is the lookupKey(url) -> file name map used by the static
    // rewriter to turn plain URL references into flat file names.
    const pipeline = createExportPipeline();

    fs.mkdirSync(outDir, { recursive: true });

    const rows: IndexRow[] = [];
    let written = 0;
    let skipped = 0;

    for (const e of exported) {
        const name = flatName.get(captureKey(e.url, e.timestamp.slice(0, 14)));
        if (!name) continue;

        let rec: ResolvedRecord;
        try {
            // Resolve at this capture's own timestamp: a multi-capture URL has
            // several records, and the default (earliest) would export the wrong
            // version for every later capture.
            rec = wacz.resolveRecord(e.url, e.timestamp)!;
        } catch (err) {
            console.error('  ERROR reading ' + e.url + ': ' + (err as Error).message);
            skipped++;
            continue;
        }

        const ts = rec.record.date || cdxjTsToRfc3339(e.timestamp);

        // Run the body through the static-rewrite-only pipeline: plain URL
        // references (href/src/srcset, JS import, CSS @import) become flat
        // file names. No client shim is injected under file://. Non-text
        // files pass through unchanged.
        const ctx: ReplayContext = {
            url: e.url,
            ts: e.timestamp.slice(0, 14),
            mime: e.mime,
            body: rec.record.body,
            mode: 'flat',
            flatMap: flatByKey,
            flatPathMap: flatPathByKey,
            flatCiMap: flatByKeyCi,
        };
        const body = pipeline.apply(ctx);

        fs.writeFileSync(path.join(outDir, name), body);
        rows.push({ href: name, name, timestamp: ts, url: e.url });
        written++;
    }

    // urls.csv
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const csvLines = ['File Name,Timestamp,Original URLs'];
    for (const r of rows) {
        csvLines.push(`${csvEscape(r.name)},${csvEscape(r.timestamp)},${csvEscape(r.url)}`);
    }
    fs.writeFileSync(path.join(outDir, 'urls.csv'), csvLines.join('\n') + '\n');

    // index.html (pre-generated) -- lists the archive's *pages*, linking to the
    // flat file name each page was exported to.
    const pageRows = buildPageRows(wacz.pages, (url, ts) =>
        flatName.get(captureKey(url, rfc3339ToTs14(ts))) ?? null,
    );
    fs.writeFileSync(
        path.join(outDir, 'index.html'),
        renderIndexPage(wacz.title, pageRows, ['Page', 'Timestamp', 'Original URL']),
    );

    // 404.html -- the captive "not saved" page. Every unsaved URL reference is
    // rewritten to `404.html?url=<original>`; a tiny inline script reads the
    // original URL back out and displays it.
    fs.writeFileSync(path.join(outDir, FLAT_NOT_FOUND_FILE), renderNotFoundPage());

    console.log('');
    console.log('=== Export Complete ===');
    console.log(`  Files written: ${written}`);
    console.log(`  Skipped:       ${skipped}`);
    console.log('  urls.csv:      ' + path.join(outDir, 'urls.csv'));
    console.log('  index.html:    ' + path.join(outDir, 'index.html'));
    console.log('  404.html:      ' + path.join(outDir, FLAT_NOT_FOUND_FILE));
}

main();
