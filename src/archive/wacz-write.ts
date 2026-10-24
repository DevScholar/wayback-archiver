/**
 * wacz-write.ts
 *
 * Writing a rewritten WACZ from a filtered list of WARC segments. Only offsets
 * and the WARC file name change, so every digest a record carries stays valid
 * and an audit with `verify` still passes.
 */

import * as crypto from "crypto";
import { writeZipFile } from "./zip-writer.js";
import type { CdxjEntry } from "./cdxj.js";
import { surtKey } from "../lib/url.js";
import { SOFTWARE, resource } from "./wacz-append.js";
import {
  WARC_ZIP_PATH,
  WARC_BASENAME,
  INDEX_ZIP_PATH,
  PAGES_ZIP_PATH,
  compareEntries,
  type BundleSegment,
} from "./wacz-bundle.js";

/** One CDXJ line, pointing at a record's new byte range. Every other field of
 * the original line is preserved, so a non-standard field a source tool wrote
 * survives the rewrite. */
function indexLineFor(
  entry: CdxjEntry,
  offset: number,
  length: number,
): string {
  const json: Record<string, unknown> = {
    ...entry.json,
    offset,
    length,
    filename: WARC_BASENAME,
  };
  return `${entry.key || surtKey(entry.url)} ${entry.timestamp} ${JSON.stringify(json)}`;
}

export interface WriteBundleOptions {
  outputFile: string;
  title: string;
  /** Segments to write, in stream order. Segments with no entry are the
   * un-indexed bytes and are always written. */
  segments: BundleSegment[];
  pageHeaders?: Record<string, unknown>[];
  pages?: Record<string, unknown>[];
  /** Metadata carried from a source archive. `title`, `modified` and
   * `resources` are always rewritten; `created` and any other field a source
   * set are kept. */
  datapackage?: Record<string, unknown>;
  /** Written to `datapackage.json`'s `software` field. */
  software?: string;
}

export interface WriteBundleResult {
  records: number;
  pages: number;
  warcBytes: number;
}

/** Write one WACZ holding `segments`: `archive/data.warc.gz`,
 * `indexes/index.cdx`, `pages/pages.jsonl`, `datapackage.json`, and
 * `datapackage-digest.json`. */
export function writeBundle(opts: WriteBundleOptions): WriteBundleResult {
  const nowIso = new Date().toISOString();

  const parts: Buffer[] = [];
  const placed: { entry: CdxjEntry; offset: number; length: number }[] = [];
  let offset = 0;
  for (const segment of opts.segments) {
    if (segment.raw.length === 0) continue;
    for (const entry of segment.entries) {
      placed.push({ entry, offset, length: segment.raw.length });
    }
    parts.push(segment.raw);
    offset += segment.raw.length;
  }
  const warcGz = Buffer.concat(parts);
  placed.sort((a, b) => compareEntries(a.entry, b.entry));
  const indexLines = placed.map((p) =>
    indexLineFor(p.entry, p.offset, p.length),
  );
  const cdx = Buffer.from(
    indexLines.length > 0 ? indexLines.join("\n") + "\n" : "",
    "utf-8",
  );

  const pageLines: string[] = [];
  for (const header of opts.pageHeaders ?? []) {
    pageLines.push(JSON.stringify(header));
  }
  const pageList = opts.pages ?? [];
  for (const page of pageList) pageLines.push(JSON.stringify(page));
  const pages = Buffer.from(
    pageLines.length > 0 ? pageLines.join("\n") + "\n" : "",
    "utf-8",
  );

  const dp: Record<string, unknown> = { ...(opts.datapackage ?? {}) };
  dp.profile = typeof dp.profile === "string" ? dp.profile : "data-package";
  dp.wacz_version =
    typeof dp.wacz_version === "string" ? dp.wacz_version : "1.1.1";
  dp.software = opts.software ?? SOFTWARE;
  dp.created = typeof dp.created === "string" ? dp.created : nowIso;
  dp.title = opts.title;
  dp.modified = nowIso;
  dp.resources = [
    resource("pages.jsonl", PAGES_ZIP_PATH, pages),
    resource(WARC_BASENAME, WARC_ZIP_PATH, warcGz),
    resource("index.cdx", INDEX_ZIP_PATH, cdx),
  ];
  const datapackageBuf = Buffer.from(
    JSON.stringify(dp, null, 2) + "\n",
    "utf-8",
  );
  const digestJson = {
    path: "datapackage.json",
    hash:
      "sha256:" +
      crypto.createHash("sha256").update(datapackageBuf).digest("hex"),
  };

  writeZipFile(opts.outputFile, [
    { name: "datapackage.json", data: datapackageBuf, method: "deflate" },
    {
      name: "datapackage-digest.json",
      data: Buffer.from(JSON.stringify(digestJson, null, 2) + "\n", "utf-8"),
      method: "deflate",
    },
    { name: PAGES_ZIP_PATH, data: pages, method: "deflate" },
    { name: WARC_ZIP_PATH, data: warcGz, method: "store" },
    { name: INDEX_ZIP_PATH, data: cdx, method: "store" },
  ]);

  return {
    records: placed.length,
    pages: pageList.length,
    warcBytes: warcGz.length,
  };
}
