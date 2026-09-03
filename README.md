# Wayback Archiver

Read [WACZ](https://webrecorder.net/wacz) web archives: capture URLs into a new
WACZ, export them to a standalone flat HTML folder, or serve them for replay in
a browser.


## Requirements

- Node.js >= 20
- `npm install` (installs TypeScript, `tsx`, and `@types/node` only)

## Capture URLs into a WACZ

```
npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"]
```

`my-urls.txt` holds one URL per line (blank lines and `#` comments are
ignored). Each URL is fetched once and archived as a WARC 1.1 `response` record
inside `archive/data.warc.gz`; the title defaults to the output file's basename.

The download is **incremental**: if `--output-file` already exists, it is
appended to rather than replaced. URLs already in the archive are skipped (not
re-fetched), existing records are kept byte-for-byte, and only new URLs are
added. Omitting `--title` keeps the existing title; providing it renames the
archive. Options: `--concurrency` (default 8).

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
npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>]
```

Extracts every archived resource into a flat folder. Files are named
`<prefix>~<n><ext>` where `<prefix>` is the first five characters of the
original file name and `<n>` disambiguates files that share a prefix
(`about~1.html`, `infor~2.asp`, `cdx~1`). Two metadata files are written to the
output root:

- `urls.csv` — `File Name,Timestamp,Original URLs` mapping, timestamps in
  WACZ-compatible RFC3339 form.
- `index.html` — a pre-generated index page.

If `--out` is omitted, output defaults to `<archive>-html/` next to the archive.

## Serve for replay

```
npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose]
```

Serves the archive at `http://localhost:8080/`. The index page is generated on
demand from the archive's index, and archived content is served through
`/web/<timestamp>/<url>` routes with links rewritten to stay local. Pass
`--expose` to bind `0.0.0.0` and allow LAN access.

## License

MIT
