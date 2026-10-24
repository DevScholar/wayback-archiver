/**
 * plan.ts
 *
 * Deciding which captures a de-duplication keeps. Pure: no file is written, so
 * `--dry-run` and the writer read the same plan.
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
 */

import type { CdxjEntry } from "../archive/cdxj.js";
import { peekWarcHeaders } from "../archive/warc-peek.js";
import type { LoadedWacz } from "../archive/wacz-bundle.js";
import { rfc3339ToTs14 } from "../lib/time.js";

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
