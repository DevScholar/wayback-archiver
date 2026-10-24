/**
 * wacz-bundle.ts
 *
 * Reads a WACZ as an ordered list of WARC byte segments. The `merge` and
 * `dedupe` commands both rewrite an archive's index and page list while copying
 * record bytes verbatim: only offsets and the WARC file name change, so every
 * digest a record carries stays valid and an audit with `verify` still passes.
 *
 * A segment is a contiguous run of bytes in the stored WARC. An indexed record
 * is one segment, and the bytes between indexed records (a `warcinfo` block, a
 * `request` record) are segments with no index entry of their own. Carrying
 * those gaps is what makes a rewrite lossless: a record the CDX index does not
 * list is still copied over, in place.
 *
 * Writing the rewritten archive is in `wacz-write`, and reading a member's WARC
 * header without inflating its payload in `warc-peek`.
 */

import { ZipReader } from "./zip.js";
import { parseCdxj, type CdxjEntry } from "./cdxj.js";
import { surtKey } from "../lib/url.js";

/** Where a rewritten archive keeps its one WARC stream. */
export const WARC_ZIP_PATH = "archive/data.warc.gz";
/** The CDXJ `filename` value naming that stream: a basename, which the reader
 * resolves to the ZIP path above. */
export const WARC_BASENAME = "data.warc.gz";
export const INDEX_ZIP_PATH = "indexes/index.cdx";
export const PAGES_ZIP_PATH = "pages/pages.jsonl";

/** A contiguous run of WARC bytes, with the index entries that point at it. */
export interface BundleSegment {
  /** Bytes copied into the output WARC verbatim. */
  raw: Buffer;
  /** The CDXJ entries indexing this segment. Empty for the un-indexed bytes
   * between two records. */
  entries: CdxjEntry[];
}

/** A WACZ opened for rewriting. */
export interface LoadedWacz {
  path: string;
  title: string;
  datapackage: Record<string, unknown>;
  /** Index entries whose record bytes a rewrite can carry, in WARC stream
   * order. */
  entries: CdxjEntry[];
  /** The segments behind those entries, in WARC stream order. */
  segments: BundleSegment[];
  /** Each entry -> the segment holding its gzip member. */
  byEntry: Map<CdxjEntry, BundleSegment>;
  /** Lines of `pages.jsonl` that describe no page (the format header). */
  pageHeaders: Record<string, unknown>[];
  /** Lines of `pages.jsonl` that each name one page capture. */
  pages: Record<string, unknown>[];
  /** Index entries whose WARC member could not be located, so they cannot be
   * carried over. Reported rather than silently dropped. */
  unresolved: CdxjEntry[];
  /** Index entries whose byte range overlaps a record already placed. */
  overlapping: CdxjEntry[];
}

/** Resolve an entry's CDXJ `filename` to the ZIP entry holding its WARC. */
function warcPathFor(
  entry: CdxjEntry,
  byBasename: Map<string, string>,
  warcNames: string[],
): string | null {
  const wanted = entry.filename.trim();
  if (wanted) {
    const direct = byBasename.get(wanted);
    if (direct) return direct;
    const base = wanted.split("/").pop();
    if (base) {
      const byBase = byBasename.get(base);
      if (byBase) return byBase;
    }
  }
  // A one-WARC archive is the norm, so an entry with a missing or stale
  // `filename` still has an unambiguous home.
  if (warcNames.length === 1) return warcNames[0];
  return null;
}

/** Split one WARC stream into segments: every indexed member, plus the
 * un-indexed bytes before, between, and after them. */
function segmentStream(
  stream: Buffer,
  entries: CdxjEntry[],
): {
  segments: BundleSegment[];
  byEntry: Map<CdxjEntry, BundleSegment>;
  overlapping: CdxjEntry[];
} {
  // Several index entries can point at one member (a record listed under two
  // URLs, say), so group by byte range before sorting.
  const rangeKey = (e: CdxjEntry): string => `${e.offset}:${e.length}`;
  const ranges = new Map<
    string,
    { offset: number; length: number; entries: CdxjEntry[] }
  >();
  for (const e of entries) {
    const key = rangeKey(e);
    const range = ranges.get(key);
    if (range) range.entries.push(e);
    else
      ranges.set(key, {
        offset: e.offset,
        length: e.length,
        entries: [e],
      });
  }

  const ordered = [...ranges.values()].sort((a, b) => a.offset - b.offset);
  const segments: BundleSegment[] = [];
  const byEntry = new Map<CdxjEntry, BundleSegment>();
  const overlapping: CdxjEntry[] = [];
  let cursor = 0;

  for (const range of ordered) {
    const end = range.offset + range.length;
    if (
      range.length <= 0 ||
      range.offset < cursor ||
      end > stream.length ||
      range.offset < 0
    ) {
      overlapping.push(...range.entries);
      continue;
    }
    if (range.offset > cursor) {
      segments.push({
        raw: stream.subarray(cursor, range.offset),
        entries: [],
      });
    }
    const segment: BundleSegment = {
      raw: stream.subarray(range.offset, end),
      entries: range.entries,
    };
    segments.push(segment);
    for (const e of range.entries) byEntry.set(e, segment);
    cursor = end;
  }
  if (cursor < stream.length) {
    segments.push({ raw: stream.subarray(cursor), entries: [] });
  }
  return { segments, byEntry, overlapping };
}

/** Open a WACZ and lay its WARC bytes out as segments. */
export function loadWacz(filePath: string): LoadedWacz {
  const zip = ZipReader.open(filePath);
  try {
    const names = zip.names();

    let datapackage: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        zip.readEntry("datapackage.json").toString("utf8"),
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        datapackage = parsed as Record<string, unknown>;
      }
    } catch {
      /* datapackage.json is optional in practice */
    }
    const title =
      typeof datapackage.title === "string" ? datapackage.title : "";

    const indexName =
      names.find((n) => n.endsWith(".cdx") && !n.endsWith(".cdx.gz")) ??
      names.find((n) => n.endsWith(".cdx"));
    if (!indexName) {
      throw new Error(`${filePath} is not a WACZ (no CDX index)`);
    }
    const parsedEntries = parseCdxj(zip.readEntry(indexName).toString("utf8"));

    // WARC files, in ZIP order, keyed by basename for CDX `filename` lookup.
    const warcNames: string[] = [];
    const warcByBasename = new Map<string, string>();
    for (const name of names) {
      const base = name.split("/").pop();
      if (!base || !(base.endsWith(".warc") || base.endsWith(".warc.gz"))) {
        continue;
      }
      warcNames.push(name);
      if (!warcByBasename.has(base)) warcByBasename.set(base, name);
    }

    // Group entries by the stream they live in, so each stream is segmented
    // exactly once.
    const byStream = new Map<string, CdxjEntry[]>();
    const unresolved: CdxjEntry[] = [];
    for (const entry of parsedEntries) {
      const path = warcPathFor(entry, warcByBasename, warcNames);
      if (!path) {
        unresolved.push(entry);
        continue;
      }
      const list = byStream.get(path);
      if (list) list.push(entry);
      else byStream.set(path, [entry]);
    }

    const entries: CdxjEntry[] = [];
    const segments: BundleSegment[] = [];
    const byEntry = new Map<CdxjEntry, BundleSegment>();
    const overlapping: CdxjEntry[] = [];
    for (const name of warcNames) {
      const stream = zip.readEntry(name);
      if (stream.length === 0) continue;
      const list = byStream.get(name) ?? [];
      const placed = segmentStream(stream, list);
      segments.push(...placed.segments);
      overlapping.push(...placed.overlapping);
      for (const [entry, segment] of placed.byEntry) {
        byEntry.set(entry, segment);
        entries.push(entry);
      }
    }

    const pageHeaders: Record<string, unknown>[] = [];
    const pages: Record<string, unknown>[] = [];
    try {
      const text = zip.readEntry(PAGES_ZIP_PATH).toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof obj.url === "string") pages.push(obj);
        else pageHeaders.push(obj);
      }
    } catch {
      /* pages.jsonl is optional */
    }

    return {
      path: filePath,
      title,
      datapackage,
      entries,
      segments,
      byEntry,
      pageHeaders,
      pages,
      unresolved,
      overlapping,
    };
  } finally {
    zip.close();
  }
}

/** Sort two captures the way the CDX index is ordered: SURT key, then
 * timestamp, then URL, so output is deterministic. */
export function compareEntries(a: CdxjEntry, b: CdxjEntry): number {
  const aKey = a.key || surtKey(a.url);
  const bKey = b.key || surtKey(b.url);
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  return 0;
}
