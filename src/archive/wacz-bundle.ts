/**
 * wacz-bundle.ts
 *
 * Reads a WACZ as an ordered list of WARC byte segments, and writes a new WACZ
 * from a filtered list of them. The `merge` and `dedupe` commands both rewrite
 * an archive's index and page list while copying record bytes verbatim: only
 * offsets and the WARC file name change, so every digest a record carries stays
 * valid and an audit with `verify` still passes.
 *
 * A segment is a contiguous run of bytes in the stored WARC. An indexed record
 * is one segment, and the bytes between indexed records (a `warcinfo` block, a
 * `request` record) are segments with no index entry of their own. Carrying
 * those gaps is what makes a rewrite lossless: a record the CDX index does not
 * list is still copied over, in place.
 */

import * as crypto from "crypto";
import * as zlib from "zlib";
import { ZipReader } from "./zip.js";
import { writeZipFile } from "./zip-writer.js";
import { parseCdxj, type CdxjEntry } from "./cdxj.js";
import { surtKey } from "../lib/url.js";
import { SOFTWARE, resource } from "./wacz-append.js";

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

/** Compressed bytes to inflate when peeking at a record's WARC header. A WARC
 * header block is small, and deflate cannot expand more than about 1 KiB of
 * plaintext per compressed byte, so this bounds the peek to a few MiB even for
 * a pathological record. */
const PEEK_COMPRESSED_BYTES = 2048;

/** Bytes of the inflated prefix to read as the header block. */
const PEEK_PLAIN_BYTES = 8192;

/**
 * Read a record's WARC header block without inflating its whole payload.
 *
 * The header sits at the start of the decompressed member, so inflating a
 * prefix of the compressed member with `Z_SYNC_FLUSH` yields it without
 * decoding the body. A member stored uncompressed (a `.warc` stream, which a
 * WACZ allows when the archive is streamed) is read as plain text. Returns null
 * for a member that is neither.
 */
export function peekWarcHeaders(member: Buffer): Map<string, string> | null {
  if (member.length === 0) return null;
  const slice =
    member.length > PEEK_COMPRESSED_BYTES
      ? member.subarray(0, PEEK_COMPRESSED_BYTES)
      : member;
  let text: string;
  try {
    text = zlib
      .gunzipSync(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .subarray(0, PEEK_PLAIN_BYTES)
      .toString("latin1");
  } catch {
    text = member.subarray(0, PEEK_PLAIN_BYTES).toString("latin1");
  }
  if (!text.startsWith("WARC/")) return null;

  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.set(
      line.slice(0, index).trim().toLowerCase(),
      line.slice(index + 1).trim(),
    );
  }
  return headers;
}

/** The `WARC-Type` a member declares, lowercased, or "" when it has none. */
export function peekWarcType(member: Buffer): string {
  const headers = peekWarcHeaders(member);
  return (headers?.get("warc-type") ?? "").toLowerCase();
}
