/**
 * input.ts
 *
 * Reading the input WACZ: its index entries, its page entries, and the records
 * of every Wayback replay URL, so a snapshot whose bytes are already captured
 * can be restored without a network request.
 */

import * as zlib from "zlib";
import { ZipReader } from "../archive/zip.js";
import { parseWarcRecord, type WarcRecord } from "../archive/warc.js";
import { parseCdxj, type CdxjEntry } from "../archive/cdxj.js";
import { rfc3339ToTs14 } from "../lib/time.js";
import { parseWaybackUrl } from "../lib/wayback.js";
import { isHtmlMime } from "../archive/wacz-append.js";
import { buildIdentifiedTypeMap } from "./records.js";
import { primaryRecord } from "./local-reuse.js";
import type { CarriedRecord } from "./carry.js";

/** The input archive, as far as a restore needs it. */
export interface InputArchive {
  /** Every CDXJ entry of the input, in index order. */
  entries: CdxjEntry[];
  /** Every captured record of a replay URL, in index order: a `revisit` names
   * the record that carries the bytes, and only the whole list can resolve it. */
  recordsByReplayUrl: Map<string, WarcRecord[]>;
  /** Wayback's charset guess per snapshot, or the crawler's own identified
   * type as the fallback. */
  identifiedTypeBySnapshot: Map<string, string>;
  /** Page titles keyed by inner URL, for a restored page's new entry. */
  titleByInnerUrl: Map<string, string>;
  /** Page titles keyed by exact URL, for a carried record. */
  titleByUrl: Map<string, string>;
  /**
   * Copy one CDXJ entry's original gzip member bytes verbatim, as a record the
   * output carries unchanged. Null when the member cannot be read.
   */
  carryFromEntry(entry: CdxjEntry): CarriedRecord | null;
}

/**
 * Read a WACZ for restoring. Returns null when the file has no CDX index, which
 * is how a non-WACZ input is reported.
 *
 * Original page entries are indexed by URL plus capture time (a URL captured
 * twice has one entry per capture) and by URL alone as a fallback. Carried
 * records copy their entry unchanged; restored pages need a new entry under the
 * inner URL.
 */
export function readInputArchive(inputFile: string): InputArchive | null {
  const zip = ZipReader.open(inputFile);
  const names = zip.names();

  const indexName =
    names.find((n) => n.endsWith(".cdx") && !n.endsWith(".cdx.gz")) ||
    names.find((n) => n.endsWith(".cdx"));
  if (!indexName) return null;

  const entries = parseCdxj(zip.readEntry(indexName).toString("utf8"));

  const pageByUrlTs = new Map<string, Record<string, unknown>>();
  const pageByUrl = new Map<string, Record<string, unknown>>();
  const titleByInnerUrl = new Map<string, string>();
  const titleByUrl = new Map<string, string>();
  try {
    const origPages = zip.readEntry("pages/pages.jsonl").toString("utf8");
    for (const line of origPages.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj.url !== "string") continue;
      if (typeof obj.ts === "string") {
        pageByUrlTs.set(obj.url + "\t" + rfc3339ToTs14(obj.ts), obj);
      }
      pageByUrl.set(obj.url, obj);
      if (typeof obj.title !== "string") continue;
      titleByUrl.set(obj.url, obj.title);
      const wb = parseWaybackUrl(obj.url);
      if (wb) titleByInnerUrl.set(wb.innerUrl, obj.title);
    }
  } catch {
    /* optional */
  }

  // Read the input WARC's records so `im_` images can be reused locally. The
  // CDXJ `filename` is a basename ("data.warc.gz"); resolve it to the full
  // ZIP path.
  //
  // Every record of a replay URL is kept, not one: ArchiveWeb.page writes a
  // `response` for a resource and a `revisit` for each later capture of it, so
  // keeping the last record of a URL would trade the body for an empty revisit.
  //
  // Only replay routes are indexed, because only they can be followed: a
  // revisit can name an unrelated URL (the crawler's own injected script, say),
  // and resolving that to some other record would store the wrong bytes under
  // this snapshot's name.
  const warcEntries = new Map<string, string>();
  for (const n of names) {
    const base = n.split("/").pop();
    if (base && (base.endsWith(".warc") || base.endsWith(".warc.gz"))) {
      warcEntries.set(base, n);
    }
  }
  const recordsByReplayUrl = new Map<string, WarcRecord[]>();
  for (const e of entries) {
    if (!parseWaybackUrl(e.url)) continue;
    try {
      const zipName = warcEntries.get(e.filename) || e.filename;
      const raw = zip.storedRange(zipName, e.offset, e.length);
      const inflated = zlib.gunzipSync(raw);
      const record = parseWarcRecord(inflated);
      const list = recordsByReplayUrl.get(e.url);
      if (list) list.push(record);
      else recordsByReplayUrl.set(e.url, [record]);
    } catch {
      /* leave unread; a missed `im_` falls back to the network path */
    }
  }
  // The payload record of each replay URL, for the metadata pass below: a
  // revisit carries no headers worth reading.
  const primaryRecordByUrl = new Map<string, WarcRecord>();
  for (const [url, records] of recordsByReplayUrl) {
    primaryRecordByUrl.set(url, primaryRecord(records));
  }

  // Wayback's charset guess for each snapshot, or ArchiveWeb.page's identified
  // type as the fallback. Keeping it as the record's
  // WARC-Identified-Payload-Type is what lets a page whose 1990s server
  // declared no charset (the common case) replay with the encoding its stored
  // bytes actually use.
  const identifiedTypeBySnapshot = buildIdentifiedTypeMap(
    entries,
    primaryRecordByUrl,
  );

  // Build a carried-over record from a CDXJ entry by copying its original
  // gzip member bytes verbatim. Used for non-replay records directly, and as
  // the fallback when a replay target cannot be re-fetched: rather than
  // dropping the resource, its original replayed bytes are left untouched in
  // the output so a later run can retry the restore against a complete archive.
  const carryFromEntry = (e: CdxjEntry): CarriedRecord | null => {
    const zipName = warcEntries.get(e.filename) || e.filename;
    let raw: Buffer;
    try {
      raw = zip.storedRange(zipName, e.offset, e.length);
    } catch {
      return null;
    }
    return {
      url: e.url,
      key: e.key,
      ts: e.timestamp,
      json: e.json,
      rawMember: raw,
      isHtml: isHtmlMime(e.mime),
      title: titleByUrl.get(e.url),
      page:
        pageByUrlTs.get(e.url + "\t" + e.timestamp.slice(0, 14)) ??
        pageByUrl.get(e.url),
    };
  };

  return {
    entries,
    recordsByReplayUrl,
    identifiedTypeBySnapshot,
    titleByInnerUrl,
    titleByUrl,
    carryFromEntry,
  };
}
