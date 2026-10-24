/**
 * run.ts
 *
 * One flat export: name every exported capture, resolve its record, rewrite its
 * links to the flat file names, and write the resources plus the metadata
 * files.
 */

import * as fs from "fs";
import * as path from "path";
import { Wacz, type ResolvedRecord } from "../archive/wacz.js";
import type { CdxjEntry } from "../archive/cdxj.js";
import type { IndexRow } from "../replay/index-page.js";
import { cdxjTsToRfc3339 } from "../lib/time.js";
import { createExportPipeline, type ReplayContext } from "../replay/plugins.js";
import { captureKey, flatFileName } from "./naming.js";
import { buildFlatLinks } from "./links.js";
import {
  writeFlatNotFoundPage,
  writeIndexHtml,
  writeUrlCsv,
} from "./index-files.js";

export interface ExportOptions {
  /** Path of the archive to export. */
  waczPath: string;
  /** Directory the flat files are written to. */
  outDir: string;
  /** Screenshot record kinds to include (`thumbnail`, `view`). */
  withTypes: Set<string>;
  /** Progress reporter. Defaults to `console.log`. */
  log?: (line: string) => void;
}

export interface ExportResult {
  /** Resources written, of the captures that were exported. */
  files: number;
  /** Captures that could not be read. */
  skipped: number;
  /** Unique captures found in the index. */
  captures: number;
}

/** Screenshot records: a PNG per page, used only for the index preview, so
 * they are not exported unless their type was asked for. */
const SCREENSHOT_URN_RE = /^urn:(thumbnail|view):/i;

/**
 * Export a WACZ into a standalone, flat folder of files that can be browsed
 * directly from the filesystem (file://) without a server.
 *
 * Captures are deduplicated by capture (normalized URL + timestamp), keeping
 * the first occurrence of a true duplicate. Distinct timestamps of the same URL
 * are distinct captures and must each be exported -- a multi-capture archive
 * (e.g. the same Microsoft homepage in 1996 and 1998) lists every version.
 */
export function exportArchive(opts: ExportOptions): ExportResult {
  const log = opts.log ?? console.log;
  const wacz = new Wacz(opts.waczPath);
  try {
    return exportWith(wacz, opts, log);
  } finally {
    wacz.close();
  }
}

function exportWith(
  wacz: Wacz,
  opts: ExportOptions,
  log: (line: string) => void,
): ExportResult {
  const { outDir, withTypes } = opts;

  const seen = new Set<string>();
  const unique: CdxjEntry[] = [];
  for (const e of wacz.entries) {
    const k = captureKey(e.url, e.timestamp.slice(0, 14));
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }
  unique.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  log(`  ${unique.length} unique captures in index`);

  // Assign flat names to the entries we will actually export (200 responses,
  // skipping warc/revisit records, and skipping the per-page screenshot
  // records -- `urn:thumbnail:` / `urn:view:` -- unless their type was
  // requested via `--with`).
  const exported = unique.filter((e) => {
    if (e.mime === "warc/revisit") return false;
    if (e.status != null && e.status !== 200) return false;
    const urn = SCREENSHOT_URN_RE.exec(e.url);
    if (urn && !withTypes.has(urn[1].toLowerCase())) return false;
    return true;
  });

  const counters = new Map<string, number>();
  const flatName = new Map<string, string>(); // captureKey(url, ts14) -> flat name
  for (const e of exported) {
    flatName.set(
      captureKey(e.url, e.timestamp.slice(0, 14)),
      flatFileName(e.url, e.mime, counters),
    );
  }

  const links = buildFlatLinks(wacz, exported, unique, flatName);

  // The rewriter turns plain URL references into flat file names.
  const pipeline = createExportPipeline();

  fs.mkdirSync(outDir, { recursive: true });

  const rows: IndexRow[] = [];
  let written = 0;
  let skipped = 0;

  for (const e of exported) {
    const name = flatName.get(captureKey(e.url, e.timestamp.slice(0, 14)));
    if (!name) continue;

    let rec: ResolvedRecord | null;
    try {
      // Resolve at this capture's own timestamp: a multi-capture URL has
      // several records, and the default (earliest) would export the wrong
      // version for every later capture.
      rec = wacz.resolveRecord(e.url, e.timestamp);
    } catch (err) {
      // Read failures go to stderr, as they did before the export was split
      // out of its command: they are not progress lines.
      console.error("  ERROR reading " + e.url + ": " + (err as Error).message);
      skipped++;
      continue;
    }
    if (!rec) {
      console.error("  ERROR reading " + e.url + ": no record");
      skipped++;
      continue;
    }

    const ts = rec.record.date || cdxjTsToRfc3339(e.timestamp);

    // Run the body through the static-rewrite-only pipeline: plain URL
    // references (href/src/srcset, JS import, CSS @import) become flat
    // file names. No client shim is injected under file://. Non-text
    // files pass through unchanged.
    const ctx: ReplayContext = {
      url: e.url,
      ts: e.timestamp.slice(0, 14),
      mime: e.mime,
      body: rec.record.body,
      mode: "flat",
      flatMap: links.byKey,
      flatPathMap: links.byPath,
      flatCiMap: links.byKeyCi,
    };
    const body = pipeline.apply(ctx);

    fs.writeFileSync(path.join(outDir, name), body);
    rows.push({ href: name, name, timestamp: ts, url: e.url });
    written++;
  }

  writeUrlCsv(outDir, rows);
  writeIndexHtml(outDir, wacz, flatName, withTypes);
  writeFlatNotFoundPage(outDir);

  return { files: written, skipped, captures: unique.length };
}
