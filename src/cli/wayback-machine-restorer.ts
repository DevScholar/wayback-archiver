#!/usr/bin/env node
/**
 * wayback-machine-restorer.ts
 *
 * Re-fetches a WACZ that captured the *Wayback Machine replaying* old pages as
 * a set of pure, byte-for-byte originals.
 *
 * When a crawler walks `https://web.archive.org/web/<ts>/http://host/...` it
 * archives the replayed page wrapped in Wayback's own chrome (top toolbar,
 * donation banner, `wombat.js`, ...), with every URL rewritten to a
 * `/web/<ts>[mod_]/<url>` route. That replayed copy is *lossy*: wombat.js
 * reserializes the DOM (tag case and quoting normalize, CRLF becomes LF,
 * relative URLs become absolute), so the era's original bytes can never be
 * recovered from it afterward.
 *
 * This tool therefore does not try to un-rewrite the replayed bytes. Instead it
 * reads the *list* of Wayback replay URLs the input WACZ captured, and for each
 * one fetches a fresh copy of its `id_` identity route -- the route that serves
 * the archived bytes exactly as captured, with no rewriting and no chrome. The
 * result is a WACZ that looks as if the pages were captured directly, in the
 * past:
 *
 *   - each `/web/<ts>[mod_]/<url>` is fetched as `/web/<ts>id_/<url>` and stored
 *     under the inner `<url>`;
 *   - headers are rebuilt from the historical `X-Archive-Orig-*` values (so a
 *     modern replay artifact never leaks in);
 *   - each record is stamped with its *historical* capture time, not the wall
 *     clock.
 *
 * A URL captured at several dates is several snapshots, and each is restored
 * independently: records are de-duplicated by inner URL AND capture timestamp,
 * so the routes of one capture collapse to one record while distinct historical
 * captures never overwrite each other.
 *
 * A Wayback playback redirect, the timestamp shift Wayback writes when it has
 * no capture at the requested time, is retrieval scaffolding: the old server
 * never sent it, and its target is another Wayback URL. It is followed, never
 * archived, and the capture it reaches keeps that capture's own time. The
 * requested timestamp is then left as-is for a later run, exactly like a failed
 * fetch. Wayback's own "not in archive" error page is treated the same way,
 * since it is the 2026 frontend rather than the resource.
 *
 * A resource that cannot be re-fetched is skipped: a network error writes
 * nothing, and a rate limit (429) is retried on a separate slow queue a bounded
 * number of times before also being skipped -- matching how the downloader
 * treats a failed capture.
 *
 * By default an unrestored snapshot is left as-is in the output, so a later run
 * can retry it. `--drop-unrestored` instead omits those Wayback replay records:
 * the result then contains only historical records plus non-replay content
 * (screenshots, archive.org pages), carried unchanged. The input WACZ remains
 * the lossless source either way.
 *
 * The output is incremental: if `--output-file` already exists, its URLs are
 * skipped and only newly-restored URLs are appended, so re-running the same
 * command resumes where a previous run left off.
 *
 * Fetches use a normal browser `User-Agent` (see downloader.ts) so Wayback does
 * not serve a bot response. The normal pool runs at `--concurrency` in
 * parallel; any URL that answers 429 is set aside on a rate-limit list and
 * drained one at a time at `--rate-limit-delay` with backoff.
 *
 * Usage:
 *   npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--log-file <path>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3] [--offline] [--drop-unrestored]
 *
 * Every run is logged to `<input stem>-restored.log` (or `--log-file`), next to
 * the input archive: the console's own lines, plus a per-resource detail line
 * per snapshot, per fetch attempt and per redirect hop. A restore is long enough
 * that the terminal that ran it is often gone before its result is examined, and
 * "why was this image not reused" or "why did this page shift to another time"
 * is answered only by that detail. The file is appended to, so repeated runs of
 * one archive keep their history.
 *
 * The work lives under `src/restore`: the archive's own bytes are resolved in
 * `local-reuse`, the network in `fetch` and `network-pass`, and the output in
 * `write`.
 */

import { RunLog } from "../lib/run-log.js";
import { parseArgs } from "../restore/args.js";
import { restoreArchive } from "../restore/run.js";

/**
 * Start one restore run and mirror everything it reports into its log file.
 * A fatal error is written to the log as well, so the reason a run stopped is
 * still readable after the terminal is gone.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = new RunLog(args.logFile);
  try {
    await restoreArchive(args, log);
  } catch (error) {
    log.error(
      "Fatal: " +
        (error instanceof Error
          ? (error.stack ?? error.message)
          : String(error)),
    );
    process.exitCode = 1;
  } finally {
    log.close();
  }
}

// Run only when executed directly (not when imported by a test). `main` handles
// its own failure so the log file records why the run stopped.
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  await main();
}
