/**
 * run.ts
 *
 * One de-duplication run: load the archive, plan which captures survive, report
 * the plan, and write the archive with the removed records spliced out. Only
 * index lines and gzip members are touched; kept records are copied byte for
 * byte, so their digests still check out with `verify`.
 */

import * as fs from "fs";
import * as path from "path";
import { loadWacz, type BundleSegment } from "../archive/wacz-bundle.js";
import { writeBundle } from "../archive/wacz-write.js";
import { planDedupe, filterPages } from "./plan.js";

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
