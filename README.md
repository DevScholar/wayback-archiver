# Wayback Archiver

Read [WACZ](https://webrecorder.net/wacz) web archives: capture URLs into a new
WACZ, export them to a standalone flat HTML folder, or serve them for replay in
a browser.

The project was rewritten around the WACZ container format. All
Archive.org-specific handling was removed, the TypeScript codebase is split into
small single-purpose modules, and there are no runtime dependencies (only
TypeScript and `tsx` are needed as dev dependencies — no GPL/AGPL libraries).

## Requirements

- Node.js >= 20
- `npm install` (installs TypeScript, `tsx`, and `@types/node` only)

## Capture URLs into a WACZ

```
npx tsx src/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"]
```

`my-urls.txt` holds one URL per line (blank lines and `#` comments are
ignored). Each URL is fetched once and archived as a WARC 1.1 `response` record
inside `archive/data.warc.gz`; the title defaults to the output file's basename.

The download is **incremental**: if `--output-file` already exists, it is
appended to rather than replaced. URLs already in the archive are skipped (not
re-fetched), existing records are kept byte-for-byte, and only new URLs are
added. Omitting `--title` keeps the existing title; providing it renames the
archive. Options: `--concurrency` (default 8).

## Export to standalone HTML

```
npx tsx src/export-to-html.ts <archive.wacz> [--out <dir>]
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
npx tsx src/server.ts <archive.wacz> [--port 8080] [--expose]
```

Serves the archive at `http://localhost:8080/`. The index page is generated on
demand from the archive's index, and archived content is served through
`/web/<timestamp>/<url>` routes with links rewritten to stay local. Pass
`--expose` to bind `0.0.0.0` and allow LAN access.

## License

MIT
