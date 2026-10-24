/**
 * wacz-index.ts
 *
 * The archive's lookup tables: every capture of a URL, by exact key, by
 * scheme/host/port/path (any query), and case-insensitively, plus the page
 * thumbnails indexed by the capture they show. `Wacz` loads these once and
 * asks them for the capture a replay request should serve.
 */

import type { CdxjEntry } from "./cdxj.js";
import {
  candidateUrls,
  lookupKey,
  lookupPathKey,
  lookupKeyCi,
} from "../lib/url.js";
import { rfc3339ToTs14 } from "../lib/time.js";

/** If `url` is a Wayback replay URL (`https://web.archive.org/web/<ts>/<url>`),
 * return its capture time (14 digits) and inner URL; else null. */
function waybackInner(url: string): { ts14: string; url: string } | null {
  const m =
    /^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(
      url,
    );
  if (!m) return null;
  let inner = m[2];
  try {
    inner = decodeURIComponent(inner);
  } catch {
    /* keep raw */
  }
  return { ts14: m[1].slice(0, 14), url: inner };
}

/** If `url` is a page thumbnail (`urn:thumbnail:<page-url>`), return the page
 * it captures and that capture's time: the Wayback time + inner URL when the
 * thumbnail wraps a replay URL, else the thumbnail record's own timestamp and
 * the bare URL (a direct or already-restored capture). */
function thumbnailTarget(
  url: string,
  ts17: string,
): { ts14: string; url: string } | null {
  const m = /^urn:thumbnail:(.+)$/i.exec(url);
  if (!m) return null;
  return waybackInner(m[1]) ?? { ts14: ts17.slice(0, 14), url: m[1] };
}

/** A page capture's thumbnail key: its capture time plus its lookup key. */
function thumbnailKey(ts14: string, url: string): string {
  return ts14 + " " + lookupKey(url);
}

/** The archive's lookup tables. Each list is sorted by ascending timestamp, so
 * a lookup can pick "the latest capture at or before T" and "the nearest". */
export interface WaczIndex {
  /** lookupKey(url) -> all captures of that URL, in index (ascending ts) order. */
  byKey: Map<string, CdxjEntry[]>;
  /** lookupPathKey(url) -> all captures sharing that scheme/host/port/path, any
   * query. */
  byPath: Map<string, CdxjEntry[]>;
  /** lookupKeyCi(url) -> all captures whose scheme/host/path differ only by
   * case. */
  byKeyCi: Map<string, CdxjEntry[]>;
  /** Page identity (`ts14 + " " + lookupKey(innerUrl)`) -> thumbnail record. */
  thumbnails: Map<string, CdxjEntry>;
}

/** Build the lookup tables for one archive's index entries. */
export function buildWaczIndex(entries: CdxjEntry[]): WaczIndex {
  const byKey = new Map<string, CdxjEntry[]>();
  const byPath = new Map<string, CdxjEntry[]>();
  const byKeyCi = new Map<string, CdxjEntry[]>();
  const thumbnails = new Map<string, CdxjEntry>();

  const add = (
    map: Map<string, CdxjEntry[]>,
    key: string,
    e: CdxjEntry,
  ): void => {
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  };

  for (const e of entries) {
    add(byKey, lookupKey(e.url), e);
    add(byPath, lookupPathKey(e.url), e);
    add(byKeyCi, lookupKeyCi(e.url), e);
  }
  // Sort each list by ascending timestamp so timestamp-aware lookups can pick
  // "the latest capture at or before T" and "the nearest".
  for (const list of byKey.values()) {
    list.sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
  }
  for (const list of byPath.values()) {
    list.sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
  }
  for (const list of byKeyCi.values()) {
    list.sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
  }

  // Page thumbnails (ArchiveWeb.page screenshots) are stored under
  // `urn:thumbnail:<page-url>`; index them by the page they capture so the
  // index page can show one preview per capture.
  for (const e of entries) {
    const t = thumbnailTarget(e.url, e.timestamp);
    if (!t) continue;
    thumbnails.set(thumbnailKey(t.ts14, t.url), e);
  }

  return { byKey, byPath, byKeyCi, thumbnails };
}

/** Find the best index entry for a requested URL, or null. */
export function findCapture(index: WaczIndex, url: string): CdxjEntry | null {
  for (const cand of candidateUrls(url)) {
    const list = index.byKey.get(lookupKey(cand));
    if (list && list.length) return list[0];
  }
  // Query-variant fallback: same scheme/host/port/path, any query. This
  // covers the case where the crawler stored the resource under a
  // different query form than the page references (e.g. an image served
  // at `?w=400` archived only at `?w=1200&dpr=on,2`).
  const plist = index.byPath.get(lookupPathKey(url));
  if (plist && plist.length) return plist[0];

  // Case-insensitive fallback (last resort): the page references a path
  // in a different case than the crawler stored (legacy case-insensitive
  // servers, e.g. old IIS). Exact match already won above, so this only
  // fires on a genuine miss.
  const cilist = index.byKeyCi.get(lookupKeyCi(url));
  if (cilist && cilist.length) return cilist[0];
  return null;
}

/**
 * Resolve a URL against the index, preferring the capture closest to a
 * target timestamp prefix by absolute distance -- the same rule the Wayback
 * Machine uses for replay (a miss may resolve either forward to a later
 * capture or backward to an earlier one, whichever is nearer). Ties are
 * broken toward the earlier capture. `ts` may be a full 17-digit timestamp
 * or any shorter prefix. Falls back to the earliest capture when the URL is
 * not indexed at all.
 */
export function findNearestCapture(
  index: WaczIndex,
  url: string,
  ts: string,
): CdxjEntry | null {
  // A truncated timestamp names the end of the smallest specified unit,
  // so pad with 9s (not 0s) to make the target point the inclusive upper
  // bound of that unit (e.g. "20260831074847" -> "...74847999").
  const target = ts.padEnd(17, "9");

  // Tracks the nearest capture on either side of `target`. A fresh one is
  // built per lookup rather than reset in place, so the `null` reset never
  // narrows the shared object's properties and defeats the guards below.
  type Best = { before: CdxjEntry | null; after: CdxjEntry | null };

  const consider = (best: Best, e: CdxjEntry): void => {
    if (e.timestamp <= target) {
      if (!best.before || e.timestamp > best.before.timestamp) best.before = e;
    } else {
      if (!best.after || e.timestamp < best.after.timestamp) best.after = e;
    }
  };

  const nearestOf = (list: CdxjEntry[]): CdxjEntry | null => {
    const best: Best = { before: null, after: null };
    for (const e of list) consider(best, e);
    const before = best.before;
    const after = best.after;
    if (!before) return after ?? null;
    if (!after) return before;
    const gapBefore = BigInt(target) - BigInt(before.timestamp);
    const gapAfter = BigInt(after.timestamp) - BigInt(target);
    return gapBefore <= gapAfter ? before : after;
  };

  // Exact URL first: pick the nearest capture of this exact URL. An
  // exact hit must never be shadowed by a host/scheme variant (`www.` vs
  // bare, http vs https) whose capture sits closer to the requested
  // timestamp. That shadowing is exactly how a `www.` -> bare redirect
  // loops: the bare target request re-matches the `www.` redirect record
  // through the variant fallback and redirects straight back to bare.
  const exact = index.byKey.get(lookupKey(url));
  if (exact && exact.length) return nearestOf(exact);

  // Query-variant fallback: same scheme/host/port/path, any query.
  const plist = index.byPath.get(lookupPathKey(url));
  if (plist && plist.length) return nearestOf(plist);

  // Host/scheme variants (www. vs bare, http vs https), tried only when
  // the exact URL is not indexed at all.
  for (const cand of candidateUrls(url)) {
    if (cand === url) continue;
    const list = index.byKey.get(lookupKey(cand));
    if (list && list.length) return nearestOf(list);
  }

  // Case-insensitive fallback (last resort): exact + query-variant +
  // host/scheme all missed; try the same resource under a differently
  // cased path.
  const cilist = index.byKeyCi.get(lookupKeyCi(url));
  if (cilist && cilist.length) return nearestOf(cilist);

  return findCapture(index, url);
}

/**
 * Find the thumbnail (page screenshot) for a page capture, or null. `ts` is
 * RFC3339 (pages.jsonl form). A page is identified by its capture time and
 * inner URL: for a Wayback replay URL the capture time is the timestamp
 * embedded in the URL; for a direct or restored capture it is the page's
 * own `ts`. The same pair is used to index each thumbnail, so a page always
 * matches its own screenshot even when the same URL was captured many
 * times.
 */
export function findThumbnail(
  index: WaczIndex,
  url: string,
  ts: string,
): CdxjEntry | null {
  const t = waybackInner(url);
  const ts14 = t ? t.ts14 : rfc3339ToTs14(ts);
  return index.thumbnails.get(thumbnailKey(ts14, t ? t.url : url)) ?? null;
}
