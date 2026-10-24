/**
 * carry.ts
 *
 * Records the restorer does not re-fetch: non-replay content, archive.org's own
 * pages, and snapshots that could not be restored are copied over byte for
 * byte. This module also splices records out of an existing output archive when
 * a snapshot has just been restored (so its stale replayed copy no longer
 * coexists with its restored form) or when only historical material is wanted.
 */

import { parseCdxj, type CdxjEntry } from "../archive/cdxj.js";
import { parseWaybackUrl } from "../lib/wayback.js";
import type { ExistingArchive } from "../archive/wacz-append.js";
import { snapshotKey } from "./records.js";

/**
 * A non-replay record carried over verbatim. Rather than being re-fetched or
 * re-serialized, the original gzip member bytes are copied unchanged into the
 * output stream and re-indexed at their new offset, preserving every original
 * CDXJ field except offset/length.
 */
export interface CarriedRecord {
  /** The record's URL, unchanged. */
  url: string;
  /** The original SURT sort key from the CDXJ line. */
  key: string;
  /** The original 17-digit CDXJ timestamp. */
  ts: string;
  /** The original CDXJ JSON object (offset/length updated at write time). */
  json: Record<string, unknown>;
  /** The original gzip member bytes, verbatim. */
  rawMember: Buffer;
  /** Whether the CDXJ mime is HTML, deciding whether it is listed as a page. */
  isHtml: boolean;
  /** Page title from the input pages.jsonl, when present. */
  title?: string;
  /** The input's own pages.jsonl entry for this URL, copied unchanged. */
  page?: Record<string, unknown>;
}

/** An existing archive with some indexed records spliced out. */
export interface DroppedArchive {
  warcGz: Buffer;
  indexLines: string[];
  pagesText: string;
}

/**
 * Splice the given CDXJ entries out of an existing archive: their gzip members
 * are removed from the WARC stream, every kept entry's offset is remapped, and
 * their pages.jsonl entries are removed. The un-indexed warcinfo/request
 * members are untouched, exactly as they were.
 */
function dropEntries(
  existing: ExistingArchive,
  droppedEntries: CdxjEntry[],
): DroppedArchive {
  const dropped = [...droppedEntries].sort((a, b) => a.offset - b.offset);
  if (dropped.length === 0) {
    return {
      warcGz: existing.warcGz,
      indexLines: existing.indexLines,
      pagesText: existing.pagesText,
    };
  }

  const entries = parseCdxj(existing.indexLines.join("\n"));
  const droppedOffsets = new Set(dropped.map((e) => e.offset));
  const kept = entries.filter((e) => !droppedOffsets.has(e.offset));

  // Splice dropped byte ranges out of the stored WARC, and remap every kept
  // entry's offset by the total length removed before it.
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const d of dropped) {
    if (d.offset > cursor)
      parts.push(existing.warcGz.subarray(cursor, d.offset));
    cursor = d.offset + d.length;
  }
  if (cursor < existing.warcGz.length)
    parts.push(existing.warcGz.subarray(cursor));
  const warcGz = Buffer.concat(parts);

  const droppedRanges = dropped.map((d) => ({
    start: d.offset,
    len: d.length,
  }));
  const newIndexLines: string[] = [];
  for (const e of kept) {
    let rem = 0;
    for (const r of droppedRanges) {
      if (r.start + r.len <= e.offset) rem += r.len;
    }
    const newOffset = e.offset - rem;
    newIndexLines.push(
      `${e.key} ${e.timestamp} ${JSON.stringify({ ...e.json, offset: newOffset, length: e.length })}`,
    );
  }
  newIndexLines.sort();

  // Remove the page entries of every dropped record. Their CDX mime can be
  // `warc/revisit`, so match by URL rather than by mime.
  let pagesText = existing.pagesText;
  const droppedUrls = new Set(dropped.map((e) => e.url));
  if (droppedUrls.size > 0 && pagesText) {
    const lines = pagesText.split(/\r?\n/).filter((line) => {
      const t = line.trim();
      if (!t) return false;
      try {
        const o = JSON.parse(t);
        return typeof o.url !== "string" || !droppedUrls.has(o.url);
      } catch {
        return true;
      }
    });
    pagesText = lines.join("\n") + "\n";
  }

  return { warcGz, indexLines: newIndexLines, pagesText };
}

/**
 * Rebuild an existing archive's WARC/index/pages with a set of carried Wayback
 * records removed: those whose snapshot was just successfully restored, so the
 * stale replayed copy no longer coexists with its restored inner-URL form (B2).
 * Members are spliced out of `existing.warcGz` by their byte ranges; the
 * un-indexed warcinfo/request members are untouched. Returns the cleaned
 * `warcGz`, index lines (with remapped offsets), and pages text.
 */
export function dropStaleCarried(
  existing: ExistingArchive,
  restoredSnapKeys: Set<string>,
): DroppedArchive {
  const entries = parseCdxj(existing.indexLines.join("\n"));

  // A carried Wayback replay URL whose snapshot was restored this run is stale.
  const isStale = (e: CdxjEntry): boolean => {
    const wb = parseWaybackUrl(e.url);
    if (!wb) return false;
    return restoredSnapKeys.has(snapshotKey(wb.innerUrl, wb.ts14));
  };

  return dropEntries(existing, entries.filter(isStale));
}

/**
 * Remove every carried Wayback replay record, i.e. the unrestored snapshots,
 * while keeping restored records and all non-replay content. This is the
 * `--drop-unrestored` output: a historical-only archive with no 2026 replay
 * URLs left in it.
 */
export function dropUnrestoredReplay(
  existing: ExistingArchive,
): DroppedArchive {
  const entries = parseCdxj(existing.indexLines.join("\n"));
  return dropEntries(
    existing,
    entries.filter((e) => parseWaybackUrl(e.url) !== null),
  );
}
