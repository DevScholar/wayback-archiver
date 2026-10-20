#!/usr/bin/env node
/**
 * dedupe.ts
 *
 * Removes duplicate captures of one URL from a WACZ.
 *
 * Usage:
 *   npx tsx src/cli/dedupe.ts --input-files=in.wacz [--output-file=out.wacz] [--exemption-minutes=60] [--dry-run] [--title="..."]
 *
 *   --input-files        one WACZ path (repeating or comma-separating the flag
 *                        is accepted, but dedupe rewrites one archive at a
 *                        time; use merge.ts first).
 *   --output-file        destination .wacz path. Defaults to
 *                        `<input>-deduped.wacz` next to the input.
 *   --exemption-minutes  captures more than this many minutes apart are NOT
 *                        duplicates. Omit it and every record of one exact URL
 *                        collapses to one, keeping the earliest real response.
 *   --dry-run            print what would be removed, write nothing.
 *   --title              archive title. Defaults to the input's title.
 *
 * A duplicate is a second record for the *same exact URL*: two URLs that differ
 * in a query parameter, a trailing slash or letter case are different captures
 * and are never compared. Payload bytes are not compared either; the URL and
 * the capture time decide.
 *
 * Records of one URL are grouped by capture time. A gap larger than the
 * exemption window starts a new group, so `--exemption-minutes=60` keeps one
 * capture per hour and an archive restored from the Wayback Machine (with
 * captures years apart) keeps each of its historical snapshots.
 *
 * Within a group the survivor is the earliest record that carries a payload;
 * a `revisit` record only points at another record, so it loses to the response
 * it names. A revisit that survives keeps the record it points at alive: taking
 * that record away would leave replay with nothing to serve.
 *
 * Only index lines and gzip members are touched. Kept records are copied byte
 * for byte, so their digests still check out with `verify`.
 */

import * as fs from "fs";
import * as path from "path";
import type { CdxjEntry } from "../archive/cdxj.js";
import {
  loadWacz,
  peekWarcHeaders,
  writeBundle,
  type BundleSegment,
  type LoadedWacz,
} from "../archive/wacz-bundle.js";
import { parseArgv, splitList } from "../lib/args.js";
import { rfc3339ToTs14 } from "../lib/time.js";

const USAGE =
  'Usage: npx tsx src/cli/dedupe.ts --input-files=in.wacz [--output-file=out.wacz] [--exemption-minutes=60] [--dry-run] [--title="..."]';

/** Milliseconds since the epoch for a CDXJ timestamp (UTC). A shorter
 * timestamp, such as a 14-digit capture time, is read as far as it goes and
 * padded with zeroes. */
function captureMillis(timestamp: string): number {
  const digits = timestamp.replace(/\D/g, "").padEnd(17, "0").slice(0, 17);
  const parts = [
    digits.slice(0, 4),
    digits.slice(4, 6),
    digits.slice(6, 8),
    digits.slice(8, 10),
    digits.slice(10, 12),
    digits.slice(12, 14),
    digits.slice(14, 17),
  ].map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const [year, month, day, hour, minute, second, milli] = parts;
  const value = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  return Number.isFinite(value) ? value : 0;
}

/** One page entry's capture key: the URL plus its capture time, so two captures
 * of one URL stay distinct while a repeated line collapses. */
function pageKey(url: string, ts14: string): string {
  return `${url}\t${ts14}`;
}

export interface DedupeOptions {
  /** Captures farther apart than this many minutes are not duplicates.
   * Omitted means no exemption: every record of one exact URL collapses. */
  exemptionMinutes?: number;
}

export interface DedupePlan {
  kept: Set<CdxjEntry>;
  dropped: CdxjEntry[];
  /** URLs that lost at least one record. */
  urlsReduced: number;
  /** Records kept only because a surviving revisit points at them. */
  referentsKept: number;
  revisitsKept: number;
  revisitsDropped: number;
}

/**
 * Work out which records survive. Pure: no file is written, so `--dry-run` and
 * the summary both read the same plan the writer uses.
 */
export function planDedupe(
  loaded: LoadedWacz,
  opts: DedupeOptions = {},
): DedupePlan {
  const windowMs =
    opts.exemptionMinutes === undefined
      ? Number.POSITIVE_INFINITY
      : opts.exemptionMinutes * 60_000;

  const byUrl = new Map<string, CdxjEntry[]>();
  for (const entry of loaded.entries) {
    const list = byUrl.get(entry.url);
    if (list) list.push(entry);
    else byUrl.set(entry.url, [entry]);
  }

  // Read the WARC header of every record in a URL group that holds more than
  // one record. The CDX `mime` normally says `warc/revisit`, but a writer that
  // records the content type instead would hide the difference, and picking a
  // revisit as the survivor would drop the payload it only points at.
  const typeByEntry = new Map<CdxjEntry, string>();
  const headersByEntry = new Map<CdxjEntry, Map<string, string>>();
  const peek = (entry: CdxjEntry): Map<string, string> | null => {
    const cached = headersByEntry.get(entry);
    if (cached) return cached;
    const segment = loaded.byEntry.get(entry);
    if (!segment) return null;
    const headers = peekWarcHeaders(segment.raw);
    if (headers) headersByEntry.set(entry, headers);
    return headers;
  };
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    for (const entry of list) {
      const headers = peek(entry);
      const type = (headers?.get("warc-type") ?? "").toLowerCase();
      if (type) typeByEntry.set(entry, type);
    }
  }
  const isRevisit = (entry: CdxjEntry): boolean => {
    const type = typeByEntry.get(entry);
    if (type) return type === "revisit";
    return entry.mime.trim().toLowerCase() === "warc/revisit";
  };

  const kept = new Set<CdxjEntry>();
  const dropped = new Set<CdxjEntry>();
  const reducedUrls = new Set<string>();

  for (const [url, list] of byUrl) {
    if (list.length < 2) {
      for (const entry of list) kept.add(entry);
      continue;
    }

    const sorted = [...list].sort((a, b) => {
      const delta = captureMillis(a.timestamp) - captureMillis(b.timestamp);
      if (delta !== 0) return delta;
      if (a.timestamp !== b.timestamp)
        return a.timestamp < b.timestamp ? -1 : 1;
      return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    });

    let cluster: CdxjEntry[] = [];
    let lastMillis = 0;
    const flush = (): void => {
      if (cluster.length === 0) return;
      const responses = cluster.filter((entry) => !isRevisit(entry));
      const survivor = responses[0] ?? cluster[0];
      kept.add(survivor);
      for (const entry of cluster) {
        if (entry !== survivor) dropped.add(entry);
      }
      if (cluster.length > 1) reducedUrls.add(url);
      cluster = [];
    };
    for (const entry of sorted) {
      const millis = captureMillis(entry.timestamp);
      if (cluster.length > 0 && millis - lastMillis > windowMs) flush();
      cluster.push(entry);
      lastMillis = millis;
    }
    flush();
  }

  // A revisit carries no payload of its own: replay resolves it through the
  // record it names. Dropping that record would leave the revisit pointing at
  // nothing, so any record a surviving revisit refers to is kept too.
  const pending = [...kept].filter(isRevisit);
  const visited = new Set<CdxjEntry>();
  let referentsKept = 0;
  while (pending.length > 0) {
    const revisit = pending.pop()!;
    if (visited.has(revisit)) continue;
    visited.add(revisit);
    const referent = findReferent(revisit, loaded, byUrl, isRevisit, peek);
    if (!referent || kept.has(referent)) continue;
    kept.add(referent);
    dropped.delete(referent);
    referentsKept++;
    if (isRevisit(referent)) pending.push(referent);
  }

  const survivors = [...kept];
  const removed = [...dropped];
  return {
    kept,
    dropped: removed,
    urlsReduced: reducedUrls.size,
    referentsKept,
    revisitsKept: survivors.filter(isRevisit).length,
    revisitsDropped: removed.filter(isRevisit).length,
  };
}

/** The record a revisit names, looked up by `WARC-Refers-To-Target-URI` and
 * `WARC-Refers-To-Date`, falling back to the latest capture before the revisit
 * when the date is missing, and to `WARC-Refers-To` (a record ID) as a last
 * resort. */
function findReferent(
  revisit: CdxjEntry,
  loaded: LoadedWacz,
  byUrl: Map<string, CdxjEntry[]>,
  isRevisit: (entry: CdxjEntry) => boolean,
  peek: (entry: CdxjEntry) => Map<string, string> | null,
): CdxjEntry | null {
  const headers = peek(revisit);
  if (!headers) return null;
  const targetUri = headers.get("warc-refers-to-target-uri") ?? "";
  const refersDate = headers.get("warc-refers-to-date") ?? "";
  const recordId = headers.get("warc-refers-to") ?? "";

  if (targetUri) {
    const candidates = (byUrl.get(targetUri) ?? []).filter(
      (entry) => entry !== revisit,
    );
    if (candidates.length > 0) {
      const ts14 = refersDate ? rfc3339ToTs14(refersDate) : "";
      if (ts14) {
        const exact = candidates.filter(
          (entry) => entry.timestamp.slice(0, 14) === ts14,
        );
        if (exact.length > 0) {
          return exact.find((entry) => !isRevisit(entry)) ?? exact[0];
        }
      }
      const before = candidates.filter(
        (entry) =>
          captureMillis(entry.timestamp) <= captureMillis(revisit.timestamp),
      );
      const pool = before.length > 0 ? before : candidates;
      return pool.find((entry) => !isRevisit(entry)) ?? pool[pool.length - 1];
    }
  }

  if (recordId) {
    // Only the record ID names the referent, so every record has to be asked
    // for its own ID. The header peeks are cached, so a second revisit with the
    // same shape is free.
    for (const entry of loaded.entries) {
      const entryHeaders = peek(entry);
      if (entryHeaders?.get("warc-record-id") === recordId) return entry;
    }
  }
  return null;
}

/** Drop page entries whose capture no longer exists. A page line names one
 * capture (URL + time); a line for a removed record would link to nothing. */
export function filterPages(
  loaded: LoadedWacz,
  plan: DedupePlan,
): Record<string, unknown>[] {
  const keptKeys = new Set<string>();
  const keptUrls = new Set<string>();
  for (const entry of plan.kept) {
    keptUrls.add(entry.url);
    keptKeys.add(pageKey(entry.url, entry.timestamp.slice(0, 14)));
  }
  const droppedKeys = new Set<string>();
  const droppedUrls = new Set<string>();
  for (const entry of plan.dropped) {
    droppedUrls.add(entry.url);
    droppedKeys.add(pageKey(entry.url, entry.timestamp.slice(0, 14)));
  }

  return loaded.pages.filter((page) => {
    const url = typeof page.url === "string" ? page.url : "";
    if (!url) return true;
    if (typeof page.ts !== "string") {
      // No capture time to match: keep the line while the URL has a record.
      return keptUrls.has(url) || !droppedUrls.has(url);
    }
    const key = pageKey(url, rfc3339ToTs14(page.ts));
    return keptKeys.has(key) || !droppedKeys.has(key);
  });
}

export interface DedupeRunOptions {
  inputFiles: string[];
  outputFile?: string;
  title?: string;
  exemptionMinutes?: number;
  dryRun?: boolean;
  /** Progress reporter. Defaults to `console.log`; tests pass a no-op. */
  log?: (line: string) => void;
}

export interface DedupeResult {
  recordsBefore: number;
  recordsAfter: number;
  pagesBefore: number;
  pagesAfter: number;
  dropped: number;
  urlsReduced: number;
  referentsKept: number;
  revisitsKept: number;
  revisitsDropped: number;
  /** False for a dry run, which writes nothing. */
  wrote: boolean;
}

function formatExemption(minutes: number | undefined): string {
  if (minutes === undefined) {
    return "none (every record of one URL collapses to one)";
  }
  return `captures more than ${minutes} minute(s) apart are kept`;
}

function sameFile(left: string, right: string): boolean {
  const real = (value: string): string => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const a = real(left);
  const b = real(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export function dedupeArchive(opts: DedupeRunOptions): DedupeResult {
  const log = opts.log ?? console.log;
  const inputs = opts.inputFiles.map((file) => path.resolve(file));
  if (inputs.length === 0) {
    throw new Error("no input archive given");
  }
  if (inputs.length > 1) {
    throw new Error(
      "dedupe rewrites one archive at a time; run merge.ts first, then dedupe the merged file",
    );
  }
  const inputPath = inputs[0];
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`input archive not found: ${inputPath}`);
  }
  if (
    opts.exemptionMinutes !== undefined &&
    (!Number.isFinite(opts.exemptionMinutes) || opts.exemptionMinutes < 0)
  ) {
    throw new Error(
      `--exemption-minutes must be a number of minutes, 0 or more: ${opts.exemptionMinutes}`,
    );
  }

  const base = path.basename(inputPath).replace(/\.wacz$/i, "");
  const outputFile = path.resolve(
    opts.outputFile ??
      path.join(path.dirname(inputPath), base + "-deduped.wacz"),
  );
  if (sameFile(inputPath, outputFile)) {
    throw new Error(
      `refusing to overwrite the input archive: ${outputFile}\n` +
        "write to a new file instead, then replace the original when it looks right",
    );
  }

  const loaded = loadWacz(inputPath);
  const plan = planDedupe(loaded, {
    exemptionMinutes: opts.exemptionMinutes,
  });
  const pages = filterPages(loaded, plan);

  const recordsBefore = loaded.entries.length;
  const recordsAfter = plan.kept.size;

  log("=== WACZ Dedupe ===");
  log("Input:     " + inputPath);
  log("Output:    " + outputFile + (opts.dryRun ? " (dry run)" : ""));
  log("Title:     " + (opts.title ?? loaded.title ?? ""));
  log("Grouping:  exact URL, query string included");
  log("Exemption: " + formatExemption(opts.exemptionMinutes));
  log(
    `Records:   ${recordsBefore} -> ${recordsAfter} ` +
      `(${plan.dropped.length} dropped, ${plan.urlsReduced} URL(s) reduced)`,
  );
  if (plan.revisitsKept > 0 || plan.revisitsDropped > 0) {
    log(
      `Revisits:  ${plan.revisitsKept} kept, ${plan.revisitsDropped} dropped, ` +
        `${plan.referentsKept} referent(s) kept so no revisit points at nothing`,
    );
  }
  log(`Pages:     ${loaded.pages.length} -> ${pages.length}`);
  if (loaded.unresolved.length > 0) {
    log(
      `Warning:   ${loaded.unresolved.length} index entr(ies) point at no WARC record and were dropped`,
    );
  }

  if (plan.dropped.length === 0) {
    log("\nNothing to remove: no URL has more than one record in the window.");
  } else {
    const sample = plan.dropped.slice(0, 20);
    log("\nRemoved:");
    for (const entry of sample) log(`  ${entry.timestamp} ${entry.url}`);
    if (plan.dropped.length > sample.length) {
      log(`  ... and ${plan.dropped.length - sample.length} more`);
    }
  }

  const segments: BundleSegment[] = [];
  for (const segment of loaded.segments) {
    if (segment.entries.length === 0) {
      segments.push(segment);
      continue;
    }
    const entries = segment.entries.filter((entry) => plan.kept.has(entry));
    if (entries.length === 0) continue;
    segments.push({ raw: segment.raw, entries });
  }

  if (opts.dryRun) {
    log("\n=== Dry run: nothing written ===");
    return {
      recordsBefore,
      recordsAfter,
      pagesBefore: loaded.pages.length,
      pagesAfter: pages.length,
      dropped: plan.dropped.length,
      urlsReduced: plan.urlsReduced,
      referentsKept: plan.referentsKept,
      revisitsKept: plan.revisitsKept,
      revisitsDropped: plan.revisitsDropped,
      wrote: false,
    };
  }

  writeBundle({
    outputFile,
    title: opts.title ?? (loaded.title || base),
    segments,
    pageHeaders: loaded.pageHeaders,
    pages,
    datapackage: loaded.datapackage,
  });

  log("\n=== Done ===");
  log("Wrote " + outputFile);

  return {
    recordsBefore,
    recordsAfter,
    pagesBefore: loaded.pages.length,
    pagesAfter: pages.length,
    dropped: plan.dropped.length,
    urlsReduced: plan.urlsReduced,
    referentsKept: plan.referentsKept,
    revisitsKept: plan.revisitsKept,
    revisitsDropped: plan.revisitsDropped,
    wrote: true,
  };
}

export function main(argv: string[]): void {
  const parsed = parseArgv(
    argv,
    ["--input-files", "--output-file", "--title", "--exemption-minutes"],
    ["--dry-run"],
  );
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) console.error("Error: " + error);
    console.error(USAGE);
    process.exit(1);
  }
  if (parsed.positional.length > 0) {
    console.error(`Error: unexpected argument ${parsed.positional[0]}`);
    console.error(USAGE);
    process.exit(1);
  }

  const inputFiles = (parsed.values.get("--input-files") ?? []).flatMap(
    splitList,
  );
  if (inputFiles.length === 0) {
    console.error("Error: --input-files is required");
    console.error(USAGE);
    process.exit(1);
  }

  const exemptionText = (parsed.values.get("--exemption-minutes") ?? []).at(-1);
  let exemptionMinutes: number | undefined;
  if (exemptionText !== undefined) {
    exemptionMinutes = Number(exemptionText);
    if (!Number.isFinite(exemptionMinutes) || exemptionMinutes < 0) {
      console.error(
        `Error: --exemption-minutes must be a number of minutes, 0 or more: ${exemptionText}`,
      );
      console.error(USAGE);
      process.exit(1);
    }
  }

  dedupeArchive({
    inputFiles,
    outputFile: (parsed.values.get("--output-file") ?? []).at(-1),
    title: (parsed.values.get("--title") ?? []).at(-1),
    exemptionMinutes,
    dryRun: parsed.values.has("--dry-run"),
  });
}

// Run only when executed directly (not when imported by a test).
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("Fatal: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
