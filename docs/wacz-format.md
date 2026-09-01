# WACZ format notes

These notes summarize the parts of the WACZ 1.1/1.2 layout this project reads.
The full spec lives in `user-private/specs/wacz/` (not committed).

## Container layout

A `.wacz` file is a standard ZIP archive with this layout:

```
├── archive
│   └── data.warc.gz       (WARC records, stored with STORE method)
├── indexes
│   └── index.cdx          (CDXJ index, one line per record)
├── pages
│   └── pages.jsonl        (entry-point pages, optional)
├── datapackage.json       (manifest)
└── datapackage-digest.json (optional)
```

Key detail: `archive/*` and `indexes/*.cdx` are stored **uncompressed** (ZIP
STORE method) so clients can random-access a single WARC record without
inflating the whole file. Our `zip.ts` reader supports both STORE and DEFLATE.

## CDXJ index (`index.cdx`)

One record per line:

```
<surt-key> <timestamp> {"url": "...", "mime": "...", "offset": N, "length": N, ...}
```

- `timestamp` is a 17-digit value `YYYYMMDDHHMMSSmmm`.
- `offset` / `length` point at a single **gzip member** inside `data.warc.gz`
  (offsets are into the compressed stream — `gzunzip` that slice to recover one
  record).
- `mime` is the response content type, or `warc/revisit` for revisit records.

## WARC record

A single (decompressed) record is:

```
WARC/1.1\r\n
WARC-Type: response\r\n
WARC-Target-URI: <url>\r\n
WARC-Date: <RFC3339>\r\n
Content-Length: N\r\n
...\r\n
\r\n
HTTP/1.1 200 OK\r\n
<http headers>\r\n
\r\n
<body bytes>
```

`WARC-Date` is the canonical RFC3339 timestamp we use in `urls.csv`.

## Timestamps

- `urls.csv` uses the WARC `WARC-Date` (RFC3339), falling back to converting the
  17-digit CDXJ timestamp (assumed UTC) when a record has no date.
- Replay routes use the first 14 digits of the 17-digit CDXJ timestamp
  (`/web/YYYYMMDDHHMMSS/<url>`).

## Lookup variants

The CDXJ index is keyed by exact URL. When resolving a URL reference found in a
page, we try a small set of variants, mirroring common replay behaviour:

1. exact URL,
2. `www.` / bare hostname alternate,
3. `http` / `https` scheme alternate (and combined),
4. directory index documents (`index.html`, `default.asp`, …) for URLs ending
   in `/`,
5. `.html` / `.htm` suffixes for extensionless paths.

## Export naming

`export-to-html` names files `<prefix>~<n><ext>`:

- `prefix` = first 5 characters of the URL's basename (sanitized),
- `n` = counter disambiguating files sharing a prefix+extension,
- `ext` = the URL's own extension, else derived from `mime`, else omitted.

See `docs/export-naming.md` for worked examples.
