# Wayback Archiver

Read [WACZ](https://webrecorder.net/wacz) web archives: capture URLs into a new
WACZ, export them to a standalone flat HTML folder, or serve them for replay in
a browser.


## Requirements

- Node.js >= 20
- `npm install` (installs TypeScript, `tsx`, and `@types/node` only)

## Capture URLs into a WACZ

```
npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"] [--user-agent="..."] [--accept="..."] [--accept-language="..."]
```

`my-urls.txt` holds one URL per line (blank lines and `#` comments are
ignored). Each URL is fetched once and archived as a WARC 1.1 `response` record
inside `archive/data.warc.gz`, preceded by a `request` record that records the
client identity it was fetched under (a Windows NT 10.0 / Chrome 100
`User-Agent`, plus `Accept` and `Accept-Language: en-US,en;q=0.9`). The title
defaults to the output file's basename.

**Redirects are archived hop by hop.** A 3xx is not followed silently: each hop
is kept as its own (empty-body) `response` record under its own URL, with its
`location` header, and only the final response carries the body. Replaying the
original URL therefore walks the same redirect chain the live fetch did, and the
redirect itself — the era's server deciding where to send the browser — survives
as historical material.

Every attempt is recorded natively in the WARC, success or failure. A success
writes one `response` record per redirect hop; a failure writes a WARC 1.1
`metadata` record (with a `fetchError` field in its `application/warc-fields`
block) linked to the `request` record via `WARC-Concurrent-To`. The `request`
record is always written, so the archive preserves the *intent* — what was asked
for, under which client identity — even when nothing came back. This is what lets
an audit distinguish "this URL was never asked for" from "this URL was asked for
but the fetch failed".

The download is **incremental**: if `--output-file` already exists, it is
appended to rather than replaced. URLs already in the archive are skipped (not
re-fetched), existing records are kept byte-for-byte, and only new URLs are
added. Omitting `--title` keeps the existing title; providing it renames the
archive. Options: `--concurrency` (default 8), `--user-agent`, `--accept`, and
`--accept-language` (each defaults to its Chrome-100-style value and is recorded
in the request record).

## Restore a Wayback Machine capture

```
npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--title <t>]
```

When ArchiveWeb.page crawls `https://web.archive.org/web/<ts>/http://host/...`,
it archives the replayed page *wrapped in Wayback's own chrome* (top toolbar,
donation banner, `wombat.js`, `bundle-playback.js`, analytics) side by side with
the real, third-party content, every URL rewritten to a `/web/<ts>[mod_]/<url>`
route. This tool inverts those transforms to produce a WACZ that looks as if the
pages were captured directly, in the past:

- drops every record hosted on `*.archive.org` (the Wayback chrome), keeping only
  the real third-party content;
- unwraps `/web/<ts>[mod_]/<url>` (and the absolute
  `https://web.archive.org/web/<ts>[mod_]/<url>` form) back to the inner `<url>`;
- strips the injected `<head>` scripts, the toolbar, and the trailing
  "FILE ARCHIVED ON ..." footer from HTML;
- follows 302 redirect chains and WARC `revisit` references to the final record,
  then stamps it with the *actual* capture time (the final URL's timestamp or
  `x-archive-orig-date`), not the requested replay time — including converting
  Wayback's "redirect notice" interstitials back into real 3xx records;
- restores the historical HTTP headers from `X-Archive-Orig-*`, so a modern
  replay artifact (`server: nginx`, CSP, `cache-control`) never leaks into the
  restored record.

Every record Wayback actually served is kept verbatim, including empty bodies,
error pages, and tiny stubs. If `--output-file` is omitted, output defaults to
`<archive>-restored.wacz` next to the input; the title defaults to
`<original-title> (restored)`.

## Export to standalone HTML

```
npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>] [--with=thumbnail,view]
```

Extracts every archived resource into a flat folder. Files are named
`<prefix>~<n><ext>` where `<prefix>` is the first five characters of the
original file name and `<n>` disambiguates files that share a prefix
(`about~1.html`, `infor~2.asp`, `cdx~1`). Two metadata files are written to the
output root:

- `urls.csv` — `File Name,Timestamp,Original URLs` mapping, timestamps in
  WACZ-compatible RFC3339 form.
- `index.html` — a pre-generated index page.

The per-page screenshots (`urn:thumbnail:` and `urn:view:` records) are large
and are only used for the index-page preview, so they are **not exported by
default**. Pass `--with=thumbnail` and/or `--with=view` to include them
(`--with=thumbnail` also restores the preview column on `index.html`).

If `--out` is omitted, output defaults to `<archive>-html/` next to the archive.

## Serve for replay

```
npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose]
```

Serves the archive at `http://localhost:8080/`. The index page is generated on
demand from the archive's index, and archived content is served through
`/web/<timestamp>/<url>` routes with links rewritten to stay local. Pass
`--expose` to bind `0.0.0.0` and allow LAN access.

Replay routes accept the Wayback `id_` modifier: `/web/<timestamp>id_/<url>`
serves the capture's *identity* — the original bytes exactly as archived, with
no link rewriting and no url-fixer shim injected.

## Verify archive integrity

```
npx tsx src/cli/verify.ts <archive.wacz>
```

Confirms, byte for byte, that nothing in the archive has changed since it was
written. The downloader records every digest an integrity check needs — each
resource's `sha256` hash in `datapackage.json`, the `datapackage-digest.json`
that hashes `datapackage.json` itself, and each WARC record's
`WARC-Payload-Digest` / `WARC-Block-Digest` — and this command reads them back,
layer by layer:

- `datapackage-digest.json` → `sha256(datapackage.json)`;
- each resource's `hash` + `bytes` → its stored bytes (covering the whole
  `data.warc.gz`, including the un-indexed `request` and `metadata` records);
- each indexed response record's `WARC-Block-Digest` and `WARC-Payload-Digest`
  → re-derived over the exact byte spans they cover.

Exit code is 0 only when every layer passes. This is an **offline audit**, run
deliberately (after copying an archive to new media, or on a schedule to catch
bit-rot) — the replay server still reads by trusting the index, and never pays
the hashing cost on its hot path.

## License

MIT
