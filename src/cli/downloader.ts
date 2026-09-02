/**
 * downloader.ts
 *
 * Crawls a list of URLs and packages them into a WACZ file for replay with
 * `server.ts` / `export-to-html.ts`.
 *
 * Usage:
 *   npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"]
 *
 *   --url-list     path to a text file with one URL per line (blank lines and
 *                  `#` comments ignored). Only http/https URLs are fetched.
 *   --output-file  destination .wacz path.
 *   --title        archive title. Defaults to the output file's basename for a
 *                  new archive; when the file already exists, omitting --title
 *                  keeps its current title and providing it renames it.
 *   --concurrency  number of parallel fetches (default 8).
 *
 * Incremental: if `--output-file` already exists it is treated as the existing
 * archive. URLs already captured in it are skipped (not re-fetched), and only
 * new URLs are appended -- the existing records, their offsets and timestamps
 * are preserved byte-for-byte. Re-running with an extended URL list grows the
 * same file rather than replacing it.
 *
 * Each URL is fetched once and written as a WARC 1.1 `response` record into
 * `archive/data.warc.gz` (stored uncompressed in the ZIP, so a single record
 * can be read by byte range). `indexes/index.cdx` maps SURT-key + timestamp to
 * each record's offset/length, and `pages/pages.jsonl` lists every fetched URL
 * as an entry point. Redirects are followed transparently; the final response
 * is archived under the URL that was requested.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { writeZipFile } from '../archive/zip-writer';
import { buildWarcRecord, payloadDigest } from '../archive/warc-writer';
import { surtKey } from '../lib/url';
import { nowTs17, cdxjTsToRfc3339 } from '../lib/time';
import { ZipReader } from '../archive/zip';
import { parseCdxj } from '../archive/cdxj';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
    urlList: string;
    outputFile: string;
    title?: string;
    concurrency: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { urlList: '', outputFile: '', concurrency: 8 };
    for (const a of argv) {
        const eq = a.indexOf('=');
        const key = eq >= 0 ? a.slice(0, eq) : a;
        const val = eq >= 0 ? a.slice(eq + 1) : '';
        if (key === '--url-list') args.urlList = val;
        else if (key === '--output-file') args.outputFile = val;
        else if (key === '--title') args.title = val;
        else if (key === '--concurrency') args.concurrency = parseInt(val, 10) || 8;
    }
    if (!args.urlList) {
        console.error('Usage: npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"]');
        process.exit(1);
    }
    if (!args.outputFile) {
        console.error('Error: --output-file is required');
        process.exit(1);
    }
    return args;
}

function readUrlList(filePath: string): string[] {
    const text = fs.readFileSync(filePath, 'utf-8');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
        const u = raw.trim();
        if (!u || u.startsWith('#')) continue;
        if (!/^https?:\/\//i.test(u)) continue;
        if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36';

const DEFAULT_HEADERS: http.OutgoingHttpHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
};

// 429 (Too Many Requests) handling: retry with a fixed delay between attempts.
const MAX_429_RETRIES = 3;   // extra attempts beyond the first
const RETRY_DELAY_MS = 500;  // 0.5s between each retried link

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface Fetched {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Buffer;
    dateRfc3339: string;
}

/** Follow redirects (up to 8 hops) and collect the final response body.
 * 429 responses are retried a few times with a fixed delay before giving up. */
function fetchUrl(url: string): Promise<Fetched> {
    const started = new Date();
    return new Promise((resolve, reject) => {
        const attempt = (current: string, hops: number, retryCount: number): void => {
            if (hops > 8) {
                reject(new Error('too many redirects'));
                return;
            }
            const lib = current.startsWith('https:') ? https : http;
            const req = lib.get(current, { headers: DEFAULT_HEADERS }, (res) => {
                const status = res.statusCode || 0;
                const statusText = res.statusMessage || '';
                const loc = res.headers.location;

                // 429 Too Many Requests -> back off 0.5s and retry (bounded).
                if (status === 429) {
                    res.resume();
                    if (retryCount < MAX_429_RETRIES) {
                        sleep(RETRY_DELAY_MS).then(() => attempt(current, hops, retryCount + 1));
                    } else {
                        reject(new Error(`HTTP 429 (gave up after ${MAX_429_RETRIES} retries)`));
                    }
                    return;
                }

                if (status >= 300 && status < 400 && loc) {
                    res.resume();
                    let next: string;
                    try {
                        next = new URL(loc, current).href;
                    } catch {
                        next = loc;
                    }
                    if (!/^https?:\/\//i.test(next)) {
                        reject(new Error(`bad redirect location: ${loc}`));
                        return;
                    }
                    attempt(next, hops + 1, retryCount);
                    return;
                }

                // Transparently decompress so the archived record carries the
                // decoded payload (matching how the crawler stores it). When we
                // decompress, the original `content-encoding` and the
                // pre-decompression `content-length` no longer describe the
                // body, so drop both -- otherwise the record would claim to be
                // gzip while holding decoded bytes, and a third-party replayer
                // would try to gunzip it again.
                const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
                const decompress = encoding.includes('gzip') || encoding.includes('deflate');

                const headers: [string, string][] = [];
                for (const [k, v] of Object.entries(res.headers)) {
                    if (v === undefined) continue;
                    const lower = k.toLowerCase();
                    if (decompress && (lower === 'content-encoding' || lower === 'content-length')) continue;
                    headers.push([k, Array.isArray(v) ? v.join(', ') : v]);
                }

                let stream: NodeJS.ReadableStream = res;
                if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip());
                else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());

                const chunks: Buffer[] = [];
                stream.on('data', (c: Buffer) => chunks.push(c));
                stream.on('error', (e) => reject(e));
                stream.on('end', () => {
                    resolve({
                        status,
                        statusText,
                        headers,
                        body: Buffer.concat(chunks),
                        dateRfc3339: started.toISOString(),
                    });
                });
            });
            req.on('error', (e) => reject(e));
            req.setTimeout(120000, () => {
                req.destroy(new Error('timeout'));
            });
        };
        attempt(url, 0, 0);
    });
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

/** A fetched URL + its serialized WARC record (offset/length assigned later). */
interface NewRecord {
    url: string;
    ts: string;
    status: number;
    mime: string;
    digest: string;
    record: Buffer;
}

/** Everything we need from an existing WACZ to append to it. */
interface ExistingArchive {
    title: string;
    warcGz: Buffer;
    indexLines: string[];
    pagesText: string;
    datapackage: Record<string, unknown>;
}

/** Load an existing WACZ for appending, or null when the file is absent. */
function loadExisting(filePath: string): ExistingArchive | null {
    if (!fs.existsSync(filePath)) return null;
    const z = ZipReader.open(filePath);
    const names = z.names();

    const warcNames = names.filter((n) => n.endsWith('.warc') || n.endsWith('.warc.gz'));
    if (warcNames.length !== 1) {
        throw new Error(
            `${filePath} is not a single-WARC archive (found ${warcNames.length} archive entries); append is unsupported.`,
        );
    }
    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    if (!indexName) {
        throw new Error(`${filePath} exists but has no CDX index \u2014 not a WACZ.`);
    }

    let datapackage: Record<string, unknown> = {};
    try {
        datapackage = JSON.parse(z.readEntry('datapackage.json').toString('utf8'));
    } catch {
        /* datapackage.json is optional */
    }

    const warcGz = z.readEntry(warcNames[0]);
    const indexLines = z.readEntry(indexName).toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    let pagesText = '';
    try {
        pagesText = z.readEntry('pages/pages.jsonl').toString('utf8');
    } catch {
        /* pages.jsonl is optional */
    }

    return {
        title: typeof datapackage.title === 'string' ? datapackage.title : '',
        warcGz,
        indexLines,
        pagesText,
        datapackage,
    };
}

function resource(name: string, p: string, data: Buffer): Record<string, unknown> {
    return {
        name,
        path: p,
        hash: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
    };
}

function indexLine(r: NewRecord, offset: number, length: number): string {
    const json = {
        url: r.url,
        digest: r.digest,
        mime: r.mime,
        offset,
        length,
        status: r.status,
        filename: 'data.warc.gz',
    };
    return `${surtKey(r.url)} ${r.ts} ${JSON.stringify(json)}`;
}

function writeWacz(opts: {
    outputFile: string;
    title: string;
    existing: ExistingArchive | null;
    newRecords: NewRecord[];
}): void {
    const { outputFile, title, existing, newRecords } = opts;

    // Append each new record as its own gzip member after the existing WARC
    // stream. Offsets of existing records are untouched; new offsets start at
    // the end of the existing stream.
    const baseOffset = existing ? existing.warcGz.length : 0;
    const warcParts: Buffer[] = existing ? [existing.warcGz] : [];
    const newIndexLines: string[] = [];
    const newPageObjs: Record<string, unknown>[] = [];
    let offset = baseOffset;

    for (const r of newRecords) {
        const member = zlib.gzipSync(r.record);
        warcParts.push(member);
        newIndexLines.push(indexLine(r, offset, member.length));
        newPageObjs.push({ url: r.url, ts: cdxjTsToRfc3339(r.ts), title: r.url });
        offset += member.length;
    }
    const warcGz = Buffer.concat(warcParts);

    // Re-sort the merged CDXJ index (append requires the whole index to stay
    // sorted by SURT key + timestamp).
    const allIndexLines = [...(existing ? existing.indexLines : []), ...newIndexLines].sort();
    const cdx = Buffer.from(allIndexLines.join('\n') + '\n', 'utf-8');

    // pages.jsonl: keep the existing content, append the new pages.
    let pagesText: string;
    if (existing && existing.pagesText) {
        pagesText =
            existing.pagesText.replace(/\s+$/, '') +
            '\n' +
            newPageObjs.map((o) => JSON.stringify(o)).join('\n') +
            '\n';
    } else {
        pagesText =
            [{ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }, ...newPageObjs]
                .map((o) => JSON.stringify(o))
                .join('\n') + '\n';
    }
    const pages = Buffer.from(pagesText, 'utf-8');

    // datapackage: preserve existing metadata, override title/resources/modified.
    const nowIso = new Date().toISOString();
    const resources = [
        resource('pages.jsonl', 'pages/pages.jsonl', pages),
        resource('data.warc.gz', 'archive/data.warc.gz', warcGz),
        resource('index.cdx', 'indexes/index.cdx', cdx),
    ];
    const dp: Record<string, unknown> = existing
        ? { ...existing.datapackage }
        : {
              profile: 'data-package',
              wacz_version: '1.1.1',
              software: 'wayback-archiver',
              created: nowIso,
          };
    dp.title = title;
    dp.modified = nowIso;
    dp.resources = resources;
    const datapackageBuf = Buffer.from(JSON.stringify(dp, null, 2) + '\n', 'utf-8');

    const digestJson = {
        path: 'datapackage.json',
        hash: 'sha256:' + crypto.createHash('sha256').update(datapackageBuf).digest('hex'),
    };

    writeZipFile(outputFile, [
        { name: 'datapackage.json', data: datapackageBuf, method: 'deflate' },
        { name: 'datapackage-digest.json', data: Buffer.from(JSON.stringify(digestJson, null, 2) + '\n', 'utf-8'), method: 'deflate' },
        { name: 'pages/pages.jsonl', data: pages, method: 'deflate' },
        { name: 'archive/data.warc.gz', data: warcGz, method: 'store' },
        { name: 'indexes/index.cdx', data: cdx, method: 'store' },
    ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const urls = readUrlList(path.resolve(args.urlList));
    const outputFile = path.resolve(args.outputFile);
    const basename = path.basename(outputFile).replace(/\.wacz$/i, '');

    const existing = loadExisting(outputFile);
    const existingUrls = new Set(
        existing ? parseCdxj(existing.indexLines.join('\n')).map((e) => e.url) : [],
    );
    const toFetch = urls.filter((u) => !existingUrls.has(u));
    const skipped = urls.length - toFetch.length;
    const title = args.title ?? (existing && existing.title ? existing.title : basename);

    console.log('=== WACZ Downloader ===');
    console.log('URL list:  ' + args.urlList);
    console.log('Output:    ' + outputFile + (existing ? ' (appending)' : ' (new)'));
    console.log('Title:     ' + title);
    console.log(`${skipped} already archived, fetching ${toFetch.length} URL(s) (concurrency ${args.concurrency})...\n`);

    const newRecords: NewRecord[] = [];
    let cursor = 0;
    let ok = 0;
    let failed = 0;

    const worker = async (id: number): Promise<void> => {
        while (true) {
            const i = cursor++;
            if (i >= toFetch.length) break;
            const url = toFetch[i];
            try {
                const resp = await fetchUrl(url);
                const record = buildWarcRecord({
                    recordId: `<urn:uuid:${crypto.randomUUID()}>`,
                    targetUri: url,
                    dateRfc3339: resp.dateRfc3339,
                    response: {
                        status: resp.status,
                        statusText: resp.statusText,
                        headers: resp.headers,
                        body: resp.body,
                    },
                });
                const ctype = (resp.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '').split(';')[0].trim();
                newRecords.push({
                    url,
                    ts: nowTs17(),
                    status: resp.status,
                    mime: ctype || 'application/octet-stream',
                    digest: payloadDigest(resp.body),
                    record,
                });
                ok++;
                console.log(`[${id}] OK ${resp.status} ${url}`);
            } catch (e) {
                failed++;
                console.log(`[${id}] FAIL ${(e as Error).message} | ${url}`);
            }
        }
    };

    const threads: Promise<void>[] = [];
    for (let i = 0; i < args.concurrency; i++) threads.push(worker(i + 1));
    await Promise.all(threads);

    // Workers finish out of order; sort by URL so pages.jsonl, record order,
    // and the resulting CDXJ are stable across runs (timestamps are still
    // wall-clock, but the ordering is deterministic).
    newRecords.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

    console.log(`\n${ok} captured, ${failed} failed`);

    if (toFetch.length === 0) {
        if (existing && args.title === undefined) {
            console.log('All URLs already archived and no title change \u2014 nothing to do.');
            return;
        }
        if (!existing) {
            console.error('No URLs to archive.');
            process.exit(1);
        }
    }

    writeWacz({ outputFile, title, existing, newRecords });
    console.log('\n=== Done ===');
    console.log('Wrote ' + outputFile);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
