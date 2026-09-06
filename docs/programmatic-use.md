# Programmatic use

The CLI tools are thin wrappers over a set of library modules under
`src/archive`, `src/replay`, and `src/lib`. [`src/index.ts`](../src/index.ts)
re-exports that library surface as a single public entry point, so you can
read, write, and replay WACZ archives from your own code.

```ts
import { Wacz, buildWarcRecord, createDefaultPipeline } from '@devscholar/wayback-archiver';
```

When running under `tsx` or working inside this repo, you can import the source
directly instead:

```ts
import { Wacz } from './src/index.ts';
```

> **Stability note.** The package is `"private"` (not published to npm), so
> `@devscholar/wayback-archiver` resolves only after you link or copy it into
> your project. The library surface is versioned with the package, but it has
> not been frozen as a long-term public API: pin a specific version and treat a
> major bump as a breaking change.

Every example assumes `archive.wacz` is a WACZ produced by the downloader or
restorer.

## Reading an archive

[`src/archive/wacz.ts`](../src/archive/wacz.ts) exports the `Wacz` facade, which
opens a WACZ once and reads records on demand (memory stays proportional to the
entry count, not the archive size).

```ts
import { Wacz } from '@devscholar/wayback-archiver';

const wacz = new Wacz('./archive.wacz');

wacz.title;              // datapackage.json title, or "Web Archive"
wacz.pages;              // [{ url, ts, title?, id?, size? }, ...] from pages.jsonl
wacz.entries;            // every CDXJ entry in the index

// Best index entry for a URL (any capture), or null.
const entry = wacz.resolve('https://example.com/');

// Nearest capture at/before a timestamp prefix (Wayback-style replay).
const at = wacz.resolveAt('https://example.com/', '20260831074847');

// Resolve AND decompress the WARC record, following `revisit` dedup refs.
const resolved = wacz.resolveRecord('https://example.com/');
if (resolved) {
    resolved.entry;       // CdxjEntry — offset/length/status/mime/...
    resolved.matchedUrl;  // the URL that actually matched the index
    resolved.record;      // WarcRecord — the parsed HTTP response
    resolved.record.body;          // Buffer of the HTTP payload
    resolved.record.httpStatus;    // 200, 404, ...
    resolved.record.httpHeaders;   // Map<string, string>, lowercased keys
}

// Thumbnail (page screenshot) for a page capture, or null.
const thumb = wacz.thumbnailFor('https://example.com/', '2026-08-31T07:48:47Z');
```

`resolveRecord` accepts an optional second argument to resolve at a timestamp:

```ts
const r = wacz.resolveRecord('https://example.com/', '20260831074847');
```

## Writing WARC records

[`src/archive/warc-writer.ts`](../src/archive/warc-writer.ts) serializes a
fetched HTTP response into a WARC 1.1 `response` record, byte-compatible with
what `warcio.js` / archiveweb.page write.

```ts
import { buildWarcRecord, payloadDigest, cdxjTsToRfc3339, nowTs17 } from '@devscholar/wayback-archiver';

const record = buildWarcRecord({
    recordId: '<urn:uuid:...>',
    targetUri: 'https://example.com/',
    dateRfc3339: cdxjTsToRfc3339(nowTs17()),
    response: {
        status: 200,
        statusText: 'OK',
        headers: [['Content-Type', 'text/html']],
        body: Buffer.from('<!doctype html><html>...</html>'),
    },
    // Optional: how the payload bytes should be decoded, when the server
    // declared no charset (legacy bodies, e.g. Windows-1252).
    identifiedPayloadType: 'text/html; charset=windows-1252',
});

// CDXJ digest field: `sha-256:<hex of the HTTP payload>` (note the dash).
const digest = payloadDigest(body);
```

## Low-level parsing

The individual formats are also exposed:

```ts
import { parseWarcRecord, parseCdxj, ZipReader, writeZipFile } from '@devscholar/wayback-archiver';

// A single decompressed WARC record -> headers + HTTP status/headers/body.
const rec = parseWarcRecord(warcRecordBytes);

// A CDXJ index file -> ordered entries with offset/length into the WARC.
const entries = parseCdxj(cdxjText);

// The ZIP layer underneath WACZ (STORE + DEFLATE, positional reads).
const zip = ZipReader.open('./archive.wacz');
zip.names();                       // every entry path
zip.readEntry('datapackage.json'); // whole entry, decompressed
zip.storedRange('archive/data.warc.gz', offset, length); // raw bytes of one gzip member
zip.close();
```

## Replay pipeline

[`src/replay/plugins.ts`](../src/replay/plugins.ts) composes the response
rewriting that both the replay server and the HTML exporter drive. A plugin
intercepts a body before it is written, rewrites URL references to stay local,
and releases the result.

```ts
import {
    createDefaultPipeline,
    createExportPipeline,
} from './src/replay/plugins.ts';

// The server pipeline: byte-level URL rewriting + the client-side url-fixer shim.
const serverPipeline = createDefaultPipeline();

// The flat-export pipeline: URL rewriting only (no runtime shim — see note below).
const exportPipeline = createExportPipeline();

const out = serverPipeline.apply({
    url: 'https://example.com/index.html', // base for resolving relative refs
    ts: '20260831074847',                  // 14-digit ts for /web/<ts>/ routes
    mime: 'text/html',
    body: Buffer.from('<!doctype html>...'),
    mode: 'server',                        // 'server' | 'flat'
    // flat mode only:
    // flatMap, flatPathMap, flatCiMap: Map<string, string>
});
```

The lower-level rewrite primitive is exported from
[`src/replay/rewrite.ts`](../src/replay/rewrite.ts):

```ts
import { rewriteContent, detectContentKind } from '@devscholar/wayback-archiver';

const kind = detectContentKind('text/html'); // 'html' | 'css' | 'js' | null
const rewritten = rewriteContent(html, 'https://example.com/', (absUrl) => {
    return '/local/' + absUrl; // or null to leave a reference untouched
}, kind);
```

## URL and timestamp helpers

[`src/lib/url.ts`](../src/lib/url.ts) and [`src/lib/time.ts`](../src/lib/time.ts)
hold the normalization and timestamp logic the rest of the codebase shares.

```ts
import { lookupKey, surtKey, lookupPathKey, lookupKeyCi, candidateUrls, cdxjTsToRfc3339, rfc3339ToTs14, nowTs17 } from '@devscholar/wayback-archiver';

lookupKey('https://example.com/#frag'); // drop fragment, normalize scheme/host
surtKey('https://www.example.org/index.html'); // 'org,example,www)/index.html'
lookupPathKey('https://example.com/a?b=1');     // 'https://example.com/a'
lookupKeyCi('https://example.com/Path');        // lowercased path (fallback-only)
candidateUrls('https://example.com/dir/');      // directory-index + no-ext variants

cdxjTsToRfc3339('20260831074839556'); // '2026-08-31T07:48:39.556Z'
rfc3339ToTs14('2026-08-31T07:48:39.556Z'); // '20260831074839'
nowTs17();                                  // current UTC, 17 digits
```

## Index page

[`src/replay/index-page.ts`](../src/replay/index-page.ts) renders the collection
index as HTML 4.01 (table layout, no CSS3) for legacy-browser viewing.

```ts
import { buildPageRows, renderIndexPage } from '@devscholar/wayback-archiver';

const rows = buildPageRows(
    wacz.pages,
    (url, ts) => `/web/${rfc3339ToTs14(ts)}/${url}`, // link target, or null to omit
    (url, ts) => {                                   // optional thumbnail
        const t = wacz.thumbnailFor(url, ts);
        return t ? `/web/${t.timestamp}/${t.url}` : null;
    },
);

const html = renderIndexPage(wacz.title, rows);
```

## Known tradeoffs

- **Synchronous I/O.** `Wacz` reads WARC records with positional `fs.readSync`
  calls (deliberately, to keep memory proportional to the entry count rather
  than the archive size). That is fine for CLI use but will block a Node event
  loop if embedded in a long-lived server. If a `serveWacz` layer ever lands, an
  async read path is the obvious next step; the plugin pipeline operates on
  in-memory buffers and would be unaffected.

- **API is not frozen.** There is no contract-test suite or semantic-versioning
  discipline yet; the exported surface is expected to evolve. The
  `entries`/`pages` getters return copies and `Wacz` owns a `close()` /
  `[Symbol.dispose]` so it can be released deterministically, but the wider
  "task" verbs (`createWacz`, `exportWacz`, `serveWacz`, `restoreWacz`) and a
  typed error model are still open — intended to be added once there is a real
  consumer, not before.

