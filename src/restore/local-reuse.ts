/**
 * local-reuse.ts
 *
 * Resolving a snapshot from the bytes the input archive already holds.
 *
 * Wayback does not rewrite images: an `im_` replay route serves the image's
 * archived bytes unchanged, so the `im_` body already captured in the input
 * WACZ *is* the `id_` identity bytes. Reusing it locally saves one network
 * request per image with zero fidelity loss -- unlike `cs_`/`js_`/bare routes,
 * whose replayed bodies are rewritten and must be re-fetched.
 */

import { isPlaybackRedirect } from "../lib/wayback.js";
import type { WarcRecord } from "../archive/warc.js";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** True for a record that redirects to another URL. */
export function isRedirectRecord(record: WarcRecord): boolean {
  return record.httpStatus !== null && REDIRECT_STATUS.has(record.httpStatus);
}

/**
 * True when a locally captured redirect is Wayback's own playback redirect.
 *
 * Wayback answers a timestamp it has no capture for with a redirect to the
 * nearest capture, and marks that redirect with `X-Archive-Redirect-Reason`. A
 * redirect the site really sent is replayed with historical `X-Archive-Orig-*`
 * headers instead, and its `location` was rewritten into a replay route, so its
 * bytes are not identity bytes: only the `id_` route restores it. That one must
 * not be followed locally.
 */
function isLocalPlaybackRedirect(record: WarcRecord, baseUrl: string): boolean {
  if (!isRedirectRecord(record)) return false;
  const names = [...record.httpHeaders.keys()];
  if (names.some((name) => name.startsWith("x-archive-orig-"))) return false;
  if (names.includes("x-archive-redirect-reason")) return true;
  const location = record.httpHeaders.get("location");
  return location !== undefined && isPlaybackRedirect(location, baseUrl);
}

/**
 * The record among several captures of one replay URL that carries the payload.
 *
 * ArchiveWeb.page writes one `response` for a resource and then a `revisit` for
 * every later capture of it, so the same replay URL can appear many times in the
 * index. The response holds the bytes and the historical headers; a revisit
 * holds neither. Reading only the last record of a URL therefore lost the body.
 * Preference: a non-redirect with a body, then a redirect (whose `location` is
 * followed), then whatever is there.
 */
export function primaryRecord(candidates: WarcRecord[]): WarcRecord {
  const payload = candidates.find(
    (record) => record.body.length > 0 && !isRedirectRecord(record),
  );
  if (payload) return payload;
  return candidates.find(isRedirectRecord) ?? candidates[0];
}

/**
 * Pick the record of `candidates` a revisit names, or the payload record when
 * no date is known.
 *
 * A revisit carries no bytes and points at the record that does, through
 * `WARC-Refers-To-Target-URI` and `WARC-Refers-To-Date`. ArchiveWeb.page writes
 * the URL of the revisit itself as the target URI, so the date is the only
 * thing that distinguishes the response from the revisits that followed it.
 * Dates are compared exactly first, then by the instant they name, because the
 * two spellings can differ (`.051Z` against `.051Z` is the common case, but a
 * missing fraction is legal too).
 */
function pickLocalRecord(
  candidates: WarcRecord[],
  preferredDate?: string,
): WarcRecord | undefined {
  if (candidates.length === 0) return undefined;
  if (preferredDate) {
    const exact = candidates.find((record) => record.date === preferredDate);
    if (exact) return exact;
    const wanted = Date.parse(preferredDate);
    if (!Number.isNaN(wanted)) {
      const sameInstant = candidates.find(
        (record) => record.date !== null && Date.parse(record.date) === wanted,
      );
      if (sameInstant) return sameInstant;
    }
  }
  return primaryRecord(candidates);
}

/**
 * Follow a Wayback replay URL's redirect chain and WARC `revisit` references
 * within the locally-captured records, returning the final content-bearing
 * record. Mirrors the downloader's hop-following, but reads from the input
 * WACZ instead of the network.
 *
 * `recordsByUrl` holds every capture of a replay URL, not one. A revisit whose
 * target URI is its own URL is resolved through `WARC-Refers-To-Date` to the
 * response it names, which is how a snapshot recorded as a revisit still
 * yields its bytes.
 *
 * Exported for the reuse tests, which hand it records directly.
 */
export function resolveLocalChain(
  startUrl: string,
  recordsByUrl: Map<string, WarcRecord[]>,
): { record: WarcRecord | null; finalUrl: string; stopReason?: string } {
  let cur = startUrl;
  let preferredDate: string | undefined;
  for (let hop = 0; hop < 12; hop++) {
    const candidates = recordsByUrl.get(cur);
    if (!candidates || candidates.length === 0)
      return {
        record: null,
        finalUrl: cur,
        stopReason: "no local record for " + cur,
      };

    const rec = pickLocalRecord(candidates, preferredDate)!;

    if (isRedirectRecord(rec)) {
      if (!isLocalPlaybackRedirect(rec, cur)) {
        return {
          record: rec,
          finalUrl: cur,
          stopReason:
            "a redirect the site sent; its location was rewritten, so only the identity route restores it",
        };
      }
      const loc = rec.httpHeaders.get("location");
      if (loc) {
        let next: string;
        try {
          next = new URL(loc, cur).href;
        } catch {
          next = loc;
        }
        if (next !== cur) {
          cur = next;
          preferredDate = undefined;
          continue;
        }
      }
    }

    if (rec.warcType === "revisit" || rec.body.length === 0) {
      const refersTo = rec.headers.get("warc-refers-to-target-uri");
      if (refersTo) {
        const refersDate = rec.headers.get("warc-refers-to-date") ?? undefined;
        const referred =
          refersTo === cur
            ? pickLocalRecord(candidates, refersDate)
            : pickLocalRecord(recordsByUrl.get(refersTo) ?? [], refersDate);
        if (referred !== rec) {
          cur = refersTo;
          preferredDate = refersDate;
          continue;
        }
      }
    }

    return { record: rec, finalUrl: cur };
  }
  return {
    record: null,
    finalUrl: cur,
    stopReason: "chain did not settle within 12 hops",
  };
}

/** Modifiers whose replayed bytes are already the identity bytes. Wayback only
 * rewrites HTML/CSS/JS bodies; every other content type is served verbatim, so
 * `im_` (images), `oe_` (embedded objects: `.dcr`, `.exe`, `.wav`, plugin data),
 * and `id_` (identity) all carry the original bytes unchanged. */
export const REUSABLE_MODIFIERS = new Set(["im_", "oe_", "id_"]);
