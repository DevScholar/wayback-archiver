#!/usr/bin/env node
/**
 * merge.ts
 *
 * Combines several WACZ files into one archive.
 *
 * Usage:
 *   npx tsx src/cli/merge.ts --input-files=a.wacz,b.wacz --output-file=merged.wacz [--title="..."]
 *
 *   --input-files  one or more WACZ paths, comma-separated. Repeat the flag to
 *                  add more (each occurrence is split on commas too).
 *   --output-file  destination .wacz path. Required, and never one of the
 *                  inputs.
 *   --title        archive title. Defaults to the output file's basename.
 *
 * Records are copied byte for byte, so every digest one carries stays valid and
 * the result still passes `verify`. Only byte offsets and the WARC file name
 * are rewritten. The bytes between indexed records -- the `warcinfo` block and
 * the `request` records, which the CDX index does not list -- are carried over
 * too, so the merge loses nothing.
 *
 * A capture the output already holds is skipped: two records with the same URL,
 * timestamp and payload digest are the same capture, so merging an archive that
 * overlaps another does not store it twice. Merging the same file twice
 * therefore changes nothing. Records of one URL captured at different times are
 * all kept, exactly as each input has them; `dedupe.ts` collapses those.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CdxjEntry } from "../archive/cdxj.js";
import {
  loadWacz,
  writeBundle,
  type BundleSegment,
} from "../archive/wacz-bundle.js";
import { parseArgv, splitList } from "../lib/args.js";
import { rfc3339ToTs14 } from "../lib/time.js";

const USAGE =
  'Usage: npx tsx src/cli/merge.ts --input-files=a.wacz,b.wacz --output-file=merged.wacz [--title="..."]';

export interface MergeOptions {
  inputFiles: string[];
  outputFile: string;
  title?: string;
  /** Progress reporter. Defaults to `console.log`; tests pass a no-op. */
  log?: (line: string) => void;
}

export interface MergeResult {
  /** Records written, i.e. index lines in the output. */
  records: number;
  pages: number;
  warcBytes: number;
  /** Records skipped because the output already held that exact capture. */
  duplicateCaptures: number;
  /** Un-indexed members skipped because an identical one was already copied. */
  duplicateGaps: number;
  /** URLs that still carry more than one capture, for the `dedupe` hint. */
  multiCaptureUrls: number;
  /** Index entries whose record bytes could not be located. */
  unresolved: number;
  /** Index entries whose byte range overlapped another record. */
  overlapping: number;
}

/** Two records are the same capture when URL, timestamp and payload digest all
 * match. Without a digest, the compressed member length stands in: it is a
 * weaker signal, but it still tells a repeated copy from a changed page. */
function captureKey(entry: CdxjEntry): string {
  const content =
    entry.digest && entry.digest.length > 0
      ? entry.digest
      : `length:${entry.length}`;
  return `${entry.url}\t${entry.timestamp}\t${content}`;
}

/** A page entry is one capture of one URL, so it is keyed the same way. */
function pageKey(page: Record<string, unknown>): string {
  const url = typeof page.url === "string" ? page.url : "";
  const ts = typeof page.ts === "string" ? rfc3339ToTs14(page.ts) : "";
  return `${url}\t${ts}`;
}

/** True when two paths name the same file. Compared through `realpath`, so a
 * relative path, a symlink or a differently cased Windows path is caught. */
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function mergeArchives(opts: MergeOptions): MergeResult {
  const log = opts.log ?? console.log;
  const inputs = opts.inputFiles.map((file) => path.resolve(file));
  if (inputs.length === 0) {
    throw new Error("no input archive given");
  }
  const outputFile = path.resolve(opts.outputFile);
  for (const input of inputs) {
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
      throw new Error(`input archive not found: ${input}`);
    }
    if (sameFile(input, outputFile)) {
      throw new Error(
        `refusing to overwrite an input archive: ${outputFile}\n` +
          "write to a new file instead, then replace the original when it looks right",
      );
    }
  }
  const title =
    opts.title?.trim() || path.basename(outputFile).replace(/\.wacz$/i, "");

  // Open every input before printing anything, so a broken input fails without
  // a half-finished report.
  const archives = inputs.map((file) => loadWacz(file));

  log("=== WACZ Merge ===");
  log("Inputs:    " + inputs.length);
  for (const [index, input] of inputs.entries()) {
    log(`  ${index + 1}. ${input}`);
  }
  log("Output:    " + outputFile);
  log("Title:     " + title);

  // Copy each input's segments in order. A segment whose every entry is a
  // repeated capture is dropped whole; a segment that keeps at least one entry
  // (a member listed under two URLs, say) is written once. An un-indexed
  // segment (a `warcinfo` block or a `request` record) is dropped only when an
  // identical one is already in the output, which makes re-merging an archive
  // a no-op rather than a growing pile of repeated annotations.
  const segments: BundleSegment[] = [];
  const seen = new Set<string>();
  const seenGaps = new Set<string>();
  const keptByUrl = new Map<string, number>();
  let duplicateCaptures = 0;
  let duplicateGaps = 0;
  let unresolved = 0;
  let overlapping = 0;

  for (const archive of archives) {
    unresolved += archive.unresolved.length;
    overlapping += archive.overlapping.length;
    for (const segment of archive.segments) {
      if (segment.entries.length === 0) {
        const key = crypto
          .createHash("sha256")
          .update(segment.raw)
          .digest("hex");
        if (seenGaps.has(key)) {
          duplicateGaps++;
          continue;
        }
        seenGaps.add(key);
        segments.push(segment);
        continue;
      }
      const entries: CdxjEntry[] = [];
      for (const entry of segment.entries) {
        const key = captureKey(entry);
        if (seen.has(key)) {
          duplicateCaptures++;
          continue;
        }
        seen.add(key);
        entries.push(entry);
        keptByUrl.set(entry.url, (keptByUrl.get(entry.url) ?? 0) + 1);
      }
      if (entries.length > 0) segments.push({ raw: segment.raw, entries });
    }
  }

  // Page entries: one per capture, so the same capture listed by two inputs is
  // listed once. The format header lines are kept, deduplicated by content.
  const pageHeaders: Record<string, unknown>[] = [];
  const headerSeen = new Set<string>();
  const pages: Record<string, unknown>[] = [];
  const pageSeen = new Set<string>();
  for (const archive of archives) {
    for (const header of archive.pageHeaders) {
      const key = JSON.stringify(header);
      if (headerSeen.has(key)) continue;
      headerSeen.add(key);
      pageHeaders.push(header);
    }
    for (const page of archive.pages) {
      const key = pageKey(page);
      if (pageSeen.has(key)) continue;
      pageSeen.add(key);
      pages.push(page);
    }
  }

  const written = writeBundle({
    outputFile,
    title,
    segments,
    pageHeaders,
    pages,
    datapackage: archives[0]?.datapackage,
  });

  let multiCaptureUrls = 0;
  for (const count of keptByUrl.values()) {
    if (count > 1) multiCaptureUrls++;
  }

  log(`Records:   ${written.records}`);
  log(`Pages:     ${written.pages}`);
  log(`WARC:      ${formatBytes(written.warcBytes)}`);
  if (duplicateCaptures > 0) {
    log(`Skipped:   ${duplicateCaptures} capture(s) the archive already held`);
  }
  if (duplicateGaps > 0) {
    log(`Skipped:   ${duplicateGaps} un-indexed member(s) already present`);
  }
  if (unresolved > 0) {
    log(
      `Warning:   ${unresolved} index entr(ies) point at no WARC record and were dropped`,
    );
  }
  if (overlapping > 0) {
    log(
      `Warning:   ${overlapping} index entr(ies) overlap another record and were dropped`,
    );
  }
  if (multiCaptureUrls > 0) {
    log(
      `Note:      ${multiCaptureUrls} URL(s) keep more than one capture; ` +
        "run dedupe.ts to collapse them",
    );
  }

  log("\n=== Done ===");
  log("Wrote " + outputFile);

  return {
    records: written.records,
    pages: written.pages,
    warcBytes: written.warcBytes,
    duplicateCaptures,
    duplicateGaps,
    multiCaptureUrls,
    unresolved,
    overlapping,
  };
}

export function main(argv: string[]): void {
  const parsed = parseArgv(argv, ["--input-files", "--output-file", "--title"]);
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
  const outputFile = (parsed.values.get("--output-file") ?? []).at(-1) ?? "";
  if (inputFiles.length === 0) {
    console.error("Error: --input-files is required");
    console.error(USAGE);
    process.exit(1);
  }
  if (!outputFile.trim()) {
    console.error("Error: --output-file is required");
    console.error(USAGE);
    process.exit(1);
  }
  const titles = parsed.values.get("--title") ?? [];
  mergeArchives({ inputFiles, outputFile, title: titles.at(-1) });
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
