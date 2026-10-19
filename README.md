# Wayback Archiver

Read [WACZ](https://webrecorder.net/wacz) web archives: capture URLs into a new
WACZ, export them to a flat HTML folder, or serve them for replay in a browser.

## Requirements

- Node.js >= 20
- `npm install` (installs TypeScript, `tsx`, and `@types/node` only)

## Capture URLs into a WACZ

```
npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"] [--user-agent="..."] [--accept="..."] [--accept-language="..."] [--wayback]
```

`my-urls.txt` holds one URL per line. Blank lines and `#` comments are ignored.
Each URL is fetched once and stored as a WARC 1.1 `response` record in
`archive/data.warc.gz`. A `request` record comes first and holds the client
identity used for the fetch: a Windows NT 10.0 / Edge 150 `User-Agent`, plus
`Accept` and `Accept-Language: en-US,en;q=0.9`. The title defaults to the output
file's basename.

A fresh archive starts with one `warcinfo` record (`software`, `format`,
`isPartOf`). A success writes one `response` record per redirect hop. A 3xx is not
followed silently: each hop is kept as its own empty-body `response` under its own
URL, with its `location` header, and only the final response carries the body.
Replay walks the same chain, and the redirect stays as historical material. A
failed fetch writes nothing, because WARC has no standard field for a capture
error.

### Capturing Wayback Machine replays as pure originals (`--wayback`)

By default the downloader fetches each URL directly. With `--wayback`, each
url-list line is a **Wayback Machine replay URL**
(`https://web.archive.org/web/<ts>[mod_]/<url>`). The downloader fetches the
`id_` form, which serves the archived bytes **exactly as captured**: no rewritten
links, no toolbar, no injected scripts.

The bytes are stored under the inner `<url>`, the headers are rebuilt from the
historical `X-Archive-Orig-*` values (so `server: nginx` and CSP never leak in),
and the record is stamped with the *historical* capture time, not the current
clock. The result is a WACZ that looks like a direct capture from the past.

Every modifier becomes `id_`. `im_` images already equal `id_`, since images are
not rewritten. `cs_` and `js_` add a Wayback footer and rewrite URLs. Only `id_`
leaves the bytes alone. The other routes lose information that cannot be
recovered later: relative paths become absolute, and tag case and quoting
normalize. A faithful archive must fetch `id_` from the start. Any line that is
not a replay URL is skipped with a warning.

A run resumes an existing `--output-file` instead of replacing it. URLs already
in the archive are skipped, existing records stay byte for byte, and only new
URLs are added. Omitting `--title` keeps the existing title, and providing it
renames the archive. Options: `--concurrency` (default 8), `--user-agent`,
`--accept`, and `--accept-language`. Each defaults to its Chrome-100-style value
and is recorded in the request record.

## Restore a Wayback Machine capture

```
npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3] [--offline] [--drop-unrestored]
```

ArchiveWeb.page archives a Wayback replay page together with Wayback's own
chrome: top toolbar, donation banner, `wombat.js`, `bundle-playback.js`,
analytics. Every URL is rewritten to a `/web/<ts>[mod_]/<url>` route. That copy is
lossy: `wombat.js` reserializes the DOM, so tag case and quoting normalize, CRLF
becomes LF, and relative URLs become absolute. None of that can be undone later.

This tool does not un-rewrite those bytes. It reads the *list* of replay URLs in
the input WACZ and refetches each `id_` route, which serves the bytes exactly as
captured, with no rewriting and no chrome. For each snapshot it:

- unwraps each `/web/<ts>[mod_]/<url>` to its `id_` form, fetches it, and stores
  the original bytes under the inner `<url>`;
- rebuilds the historical headers from `X-Archive-Orig-*`, so a modern replay
  artifact (`server: nginx`, CSP, `cache-control`) never leaks into the record;
- keeps a charset hint: Wayback's `X-Archive-Guessed-Charset` wins, written as
  `WARC-Identified-Payload-Type`, with ArchiveWeb.page's own identified type as
  the fallback. A page whose server declared no charset still replays with the
  encoding of its bytes;
- stamps the record with its *historical* capture time;
- follows a redirect the era's server sent, hop by hop, archiving each hop under
  its own URL with its historical status and `Location`, and fetches each hop
  through Wayback at the same capture time, so the live web is never contacted;
- follows but never archives a Wayback playback redirect, the timestamp shift
  Wayback writes when it has no capture at the requested time. The capture it
  reaches is stamped with that capture's real time, and the requested timestamp
  is left for a later run, like a failed fetch.

One URL captured at several dates gives several snapshots, each restored on its
own. Records are de-duplicated by inner URL *and* capture timestamp, so the routes
of one capture (bare, `im_`, ...) collapse into one, and distinct captures never
overwrite each other.

Wayback's own error page (the 2026 page titled "Wayback Machine") is never stored.
The snapshot is left as is for a later retry.

Binary media never hit the network. Wayback only rewrites HTML, CSS, and
JavaScript bodies, so an `im_` (image), `oe_` (embedded object: `.dcr`, `.exe`,
`.wav`, plugin data), or `id_` capture already in the input WACZ is byte for byte
the identity. The restorer reuses it locally. Only pages (`cs_`, `js_`, bare) need
a fresh `id_` request. If a reused record's own content type turns out to be text
(an HTML error page served for a missing image, say), it is re-fetched, because
that body was rewritten. A snapshot with no local body is re-fetched too, not
skipped.

A resource that cannot be re-fetched is skipped. A network error writes nothing,
and a rate limit (429) moves to a slow queue and is retried at
`--rate-limit-delay` with backoff before it is skipped as well.

The download is **incremental**: an existing `--output-file` keeps the URLs it
already holds, so a re-run resumes where the last one stopped. A normal browser
`User-Agent` (the same Edge 150 string) keeps Wayback from serving a bot
response. Without `--output-file`, output defaults to `<archive>-restored.wacz`
next to the input.

By default a snapshot that could not be restored stays in the output for a later
retry. `--drop-unrestored` drops those replay records instead, so the result holds
only historical records plus non-replay content (screenshots, archive.org pages)
carried unchanged. The input WACZ remains the lossless source either way.

## Export to standalone HTML

```
npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>] [--with=thumbnail,view]
```

Extracts every archived resource into a flat folder. Files are named
`<prefix>~<n><ext>`, where `<prefix>` is the first five characters of the
original file name and `<n>` disambiguates files that share a prefix
(`about~1.html`, `infor~2.asp`, `cdx~1`). Two metadata files go in the output
root:

- `urls.csv`: `File Name,Timestamp,Original URLs`, with timestamps in
  WACZ-compatible RFC3339 form.
- `wayback-index.html`: a pre-generated index page.

Per-page screenshots (`urn:thumbnail:` and `urn:view:` records) are large and only
feed the index-page preview, so they are **not exported by default**. Pass
`--with=thumbnail` and/or `--with=view` to include them. `--with=thumbnail` also
restores the preview column on `wayback-index.html`.

Without `--out`, output defaults to `<archive>-html/` next to the archive.

## Serve for replay

```
npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose]
```

Serves the archive at `http://localhost:8080/`. The index page is generated on
demand from the archive's index. Archived content is served through
`/web/<timestamp>/<url>` routes, with links rewritten to stay local. `--expose`
binds `0.0.0.0` to allow LAN access.

A replay URL with no record returns the same plain "URL not saved" page the flat
export writes (`unarchived-message.html`), with the missing address shown. It has
no CSS.

A page whose archived `Content-Type` declares no charset (normal for 1990s
servers) is served with the archive's `WARC-Identified-Payload-Type` when present,
then a `<meta>` charset, then the bytes. Valid UTF-8 stays UTF-8, and legacy
single-byte text is declared `windows-1252`. Stored bytes are never transcoded.

Replay routes accept the Wayback `id_` modifier.
`/web/<timestamp>id_/<url>` serves the capture's *identity*: the original bytes as
archived, with no link rewriting and no url-fixer shim injected.

## Verify archive integrity

```
npx tsx src/cli/verify.ts <archive.wacz>
```

Confirms, byte for byte, that the archive has not changed since it was written.
The downloader records every digest a check needs: each resource's `sha256` hash
in `datapackage.json`, the `datapackage-digest.json` that hashes
`datapackage.json` itself, and each WARC record's `WARC-Payload-Digest` and
`WARC-Block-Digest`. This command reads them back, layer by layer:

- `datapackage-digest.json` is checked against `sha256(datapackage.json)`;
- each resource's `hash` and `bytes` are checked against its stored bytes, which
  covers the whole `data.warc.gz`, including the un-indexed `request` and
  `metadata` records;
- each indexed response record's `WARC-Block-Digest` and `WARC-Payload-Digest` are
  re-derived over the exact byte spans they cover. A `revisit` record has no
  payload of its own, so its digest is checked against the record named by
  `WARC-Refers-To`, and reported as unverifiable (not failed) when that record is
  not in the archive. A non-HTTP record (`resource`, `metadata`) is checked over
  its whole block, which is its payload.

The exit code is 0 only when every layer passes. This is an **offline audit**, run
on purpose: after copying an archive to new media, or on a schedule to catch bit
rot.

## License

MIT
