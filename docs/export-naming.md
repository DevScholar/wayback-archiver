# Export naming scheme

`export-to-html.ts` flattens every archived resource into a single directory and
renames files as `<prefix>~<n><ext>`.

## Rules

1. **Stem** — the basename of the resource URL, percent-decoded and sanitized
   (characters `<>:"/\|?*` become `_`). A URL ending in `/` uses its last path
   segment; a bare root uses `index`.
2. **Prefix** — the first 5 characters of the stem (or the whole stem if
   shorter).
3. **Extension** — the URL's own extension when present; otherwise derived from
   the content type (`text/html` → `.html`, `image/jpeg` → `.jpg`,
   `image/png` → `.png`, `image/gif` → `.gif`, `text/css` → `.css`,
   `javascript` → `.js`, `application/json` → `.json`, `text/plain` → `.txt`);
   otherwise omitted.
4. **Counter** — files sharing the same `prefix` + extension are numbered
   `~1`, `~2`, … in URL-sorted order.

## Examples

| URL                                | MIME        | Flat name     |
| ---------------------------------- | ----------- | ------------- |
| `/about.html`                      | text/html   | `about~1.html`|
| `/information.asp`                 | text/html   | `infor~1.asp` |
| `/information-archive.asp`         | text/html   | `infor~2.asp` |
| `/cdx`                             | text/plain  | `cdx~1`       |
| `/` (homepage)                     | text/html   | `index~1.html`|
| `/pages/year2000/`                 | text/html   | `year2~1.html`|

## Metadata

- `urls.csv` — header `File Name,Timestamp,Original URLs`, one row per exported
  file, sorted by file name. Timestamps are RFC3339 (`WARC-Date`).
- `index.html` — a pre-generated index page listing the same rows, so the flat
  folder is browsable without the server.

## Link rewriting

Text files (HTML/CSS/JS) have their URL references rewritten to the flat name of
the matching archived file, resolved through the same variant rules as the
server (`docs/wacz-format.md`). Binary files are copied byte-for-byte.
