#!/usr/bin/env node
/**
 * downloader.ts
 *
 * Crawls a list of URLs and packages them into a WACZ file for replay with
 * `server.ts` / `export-to-html.ts`.
 *
 * Usage:
 *   npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"] [--user-agent="..."] [--accept="..."] [--accept-language="..."]
 *
 *   --url-list        path to a text file with one URL per line (blank lines and
 *                     `#` comments ignored). Only http/https URLs are fetched.
 *   --output-file     destination .wacz path.
 *   --title           archive title. Defaults to the output file's basename for a
 *                     new archive; when the file already exists, omitting --title
 *                     keeps its current title and providing it renames it.
 *   --user-agent      `User-Agent` header to fetch with (defaults to an Edge 150
 *                     on Windows NT 10.0 string). Recorded in the request record.
 *   --accept          `Accept` header to fetch with (defaults to a Chrome-style
 *                     HTML-first value). Recorded in the request record.
 *   --accept-language `Accept-Language` header to fetch with (defaults to
 *                     `en-US,en;q=0.9`). Recorded in the request record.
 *   --concurrency     number of parallel fetches (default 8).
 *   --wayback         treat each URL as a Wayback Machine replay URL
 *                     (`https://web.archive.org/web/<ts>[mod_]/<url>`): fetch its
 *                     `id_` form and store the original bytes under the inner
 *                     URL, stamped at the historical capture time.
 *
 * Incremental: if `--output-file` already exists it is treated as the existing
 * archive. URLs already captured in it are skipped (not re-fetched), and only
 * new URLs are appended -- the existing records, their offsets and timestamps
 * are preserved byte-for-byte. Re-running with an extended URL list grows the
 * same file rather than replacing it.
 *
 * Each URL is fetched once and written as a WARC 1.1 `request`/`response` pair
 * into `archive/data.warc.gz` (stored uncompressed in the ZIP, so a single
 * record can be read by byte range). The `request` record records how the URL
 * was fetched -- the client identity (`User-Agent`, `Accept`, `Accept-Language`
 * headers actually sent) -- and the `response` record carries the archived
 * payload; the two are linked by `WARC-Concurrent-To`. `indexes/index.cdx` maps
 * SURT-key + timestamp to each response record's offset/length (the request
 * records are unindexed annotations), and `pages/pages.jsonl` lists every
 * fetched URL as an entry point. Redirects are followed transparently; the
 * final response is archived under the URL that was requested.
 *
 * The run itself lives under `src/capture`: `fetch` follows one URL's redirect
 * chain, `title` reads a page title, `package` writes the WACZ, and `run` is
 * the crawl loop.
 */

import { runDownloader } from "../capture/run.js";

runDownloader(process.argv.slice(2)).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
