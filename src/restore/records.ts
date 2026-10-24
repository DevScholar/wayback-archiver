/**
 * records.ts
 *
 * Turning a successful `id_` fetch (or a locally resolved record) into the
 * records the output archive stores: the payload under its inner URL, stamped
 * with its historical capture time, with Wayback's chrome stripped from the
 * headers.
 */

import * as crypto from "crypto";
import type { CdxjEntry } from "../archive/cdxj.js";
import { cdxjTsToRfc3339 } from "../lib/time.js";
import {
  parseWaybackUrl,
  restoreWaybackHeaders,
  isPlaybackRedirect,
  isWaybackErrorPage,
  type WaybackTarget,
} from "../lib/wayback.js";
import { buildRequestRecord } from "../lib/http.js";
import { isHtmlMime } from "../archive/wacz-append.js";
import type { WarcRecord } from "../archive/warc.js";
import type { FetchedHop } from "./fetch.js";

export interface KeptRecord {
  innerUrl: string;
  ts17: string;
  mime: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Buffer;
  /** The WARC-Record-ID assigned to this response record. */
  recordId: string;
  /** The crawler's `WARC-Identified-Payload-Type` (e.g.
   * `text/html; charset=windows-1250`), carried from the input capture. It is
   * how a page whose 1990s server declared no charset still replays with the
   * encoding its stored bytes actually use. */
  identifiedPayloadType?: string;
  /**
   * The `request` record documenting how this capture was fetched (the `id_`
   * identity route, under which client identity), written immediately before
   * the response member. Present only on the first stored hop of a fetch,
   * mirroring the downloader's one-request-per-URL convention.
   */
  requestRecord?: Buffer;
}

/** The records one successful `id_` chain contributes to the output. */
export interface RestoredRecords {
  records: KeptRecord[];
  pages: Record<string, unknown>[];
  /** True when the chain produced a record for the requested snapshot itself. */
  wroteTarget: boolean;
  /** Status of the last record written, for progress logging. */
  lastStatus: number;
  /** Capture timestamp (14 digits) of the last record written, for logging. */
  lastTs14: string;
  /** Playback redirects passed over: retrieval scaffolding, never archived. */
  skippedPlaybackRedirects: number;
  /** Wayback error pages passed over: the 2026 frontend, never archived. */
  skippedErrorPages: number;
  /** Hops whose snapshot was already in the output (a redirect to a capture
   * another chain restored), so this chain wrote nothing new for them. */
  skippedAlreadyStored: number;
  /** Capture timestamp of the first already-stored hop, for logging. */
  alreadyStoredTs14?: string;
}

/** Key identifying one archived snapshot: inner URL plus capture timestamp. A
 * URL captured at several times is several resources; two routes of one capture
 * (bare, `im_`, ...) are one. */
export function snapshotKey(innerUrl: string, ts14: string): string {
  return innerUrl + "\t" + ts14;
}

/** True for a redirect Wayback wrote itself (a timestamp shift to the nearest
 * capture), which must be followed but never archived: the old server never
 * sent it, and its `location` is another playback URL.
 *
 * A real archived redirect, by contrast, is served with historical
 * `X-Archive-Orig-*` headers (and its rewritten `location` unwrapped back to
 * the historical target), so it is always kept. Wayback marks its own redirects
 * with `X-Archive-Redirect-Reason`; the `location` test is the fallback for a
 * response whose historical headers and reason header are both absent. */
function isPlaybackHop(hop: FetchedHop): boolean {
  if (hop.status < 300 || hop.status >= 400) return false;
  const names = hop.headers.map(([name]) => name.toLowerCase());
  if (names.some((name) => name.startsWith("x-archive-orig-"))) return false;
  if (names.includes("x-archive-redirect-reason")) return true;
  const location = hop.headers.find(
    ([name]) => name.toLowerCase() === "location",
  )?.[1];
  return location !== undefined && isPlaybackRedirect(location, hop.url);
}

/** MIME types that carry a character encoding and can use a charset guess. */
function isTextualType(type: string): boolean {
  return /^(text\/|application\/(?:xhtml\+xml|xml|javascript|ecmascript|json))/i.test(
    type,
  );
}

/**
 * Wayback's own guess for a response, as a `WARC-Identified-Payload-Type`
 * value: `X-Archive-Guessed-Content-Type` plus `X-Archive-Guessed-Charset`.
 * Only textual types get a charset; a charset on an image is meaningless.
 */
function guessedTypeFromHeaders(
  headers: [string, string][],
): string | undefined {
  const get = (name: string): string | undefined =>
    headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];
  const charset = get("x-archive-guessed-charset");
  if (!charset) return undefined;
  const type = get("x-archive-guessed-content-type") ?? get("content-type");
  if (!type || !isTextualType(type)) return undefined;
  return `${type}; charset=${charset}`;
}

/**
 * The charset metadata to carry as `WARC-Identified-Payload-Type`.
 *
 * Wayback's official `X-Archive-Guessed-Charset` wins over ArchiveWeb.page's
 * own `WARC-Identified-Payload-Type`; the latter is only the fallback. This
 * keeps the replay encoding from depending on the client that made the input
 * capture.
 */
function identifiedTypeFromHeaders(
  headers: [string, string][],
  identified?: string,
): string | undefined {
  return guessedTypeFromHeaders(headers) ?? identified;
}

/**
 * The chosen `WARC-Identified-Payload-Type` per snapshot, from the input
 * capture. A snapshot can appear under several routes (bare, `im_`, `id_`); a
 * route with Wayback's guess wins even when another route recorded the
 * ArchiveWeb.page type first.
 */
export function buildIdentifiedTypeMap(
  entries: CdxjEntry[],
  recordByUrl: Map<string, WarcRecord>,
): Map<string, string> {
  const bySnapshot = new Map<string, string>();
  for (const e of entries) {
    const wb = parseWaybackUrl(e.url);
    if (!wb) continue;
    const rec = recordByUrl.get(e.url);
    if (!rec) continue;
    const key = snapshotKey(wb.innerUrl, wb.ts14);
    const guess = guessedTypeFromHeaders([...rec.httpHeaders.entries()]);
    if (guess) {
      bySnapshot.set(key, guess);
      continue;
    }
    const identified = rec.headers.get("warc-identified-payload-type");
    if (identified && !bySnapshot.has(key)) bySnapshot.set(key, identified);
  }
  return bySnapshot;
}

/**
 * Turn one successful `id_` fetch (its redirect chain) into output records.
 *
 * Every kept hop is stored under its own inner URL. Its timestamp is the
 * capture time the hop's URL names: a followed redirect to a Wayback playback
 * URL carries the capture timestamp Wayback chose for it, so the bytes keep
 * their real capture time instead of being relabelled with the timestamp that
 * redirected to them.
 *
 * Two kinds of hop are retrieval scaffolding of the 2026 replay frontend, not
 * historical material, and are never written:
 *
 *   - a playback redirect (a timestamp shift to the nearest capture);
 *   - Wayback's own error page.
 *
 * `storedKeys` de-duplicates by inner URL AND capture timestamp. Sharing it
 * across a run keeps a redirect target that is also its own target from being
 * written twice, without merging distinct historical captures of one URL.
 */
export function buildRestoredRecords(opts: {
  target: WaybackTarget;
  hops: FetchedHop[];
  storedKeys: Set<string>;
  titleByInnerUrl: Map<string, string>;
  userAgent: string;
  accept: string;
  acceptLanguage: string;
  /** The crawler's charset guess per snapshot, from the input capture. */
  identifiedTypeBySnapshot?: Map<string, string>;
}): RestoredRecords {
  const {
    target,
    hops,
    storedKeys,
    titleByInnerUrl,
    userAgent,
    accept,
    acceptLanguage,
  } = opts;
  const identifiedTypeBySnapshot =
    opts.identifiedTypeBySnapshot ?? new Map<string, string>();
  const records: KeptRecord[] = [];
  const pages: Record<string, unknown>[] = [];
  let lastStatus = 0;
  let lastTs14 = target.ts14;
  let skippedPlaybackRedirects = 0;
  let skippedErrorPages = 0;
  let skippedAlreadyStored = 0;
  let alreadyStoredTs14: string | undefined;

  for (const hop of hops) {
    if (isPlaybackHop(hop)) {
      skippedPlaybackRedirects++;
      continue;
    }
    if (isWaybackErrorPage(hop.status, hop.headers, hop.body)) {
      skippedErrorPages++;
      continue;
    }

    const hopWayback = parseWaybackUrl(hop.url);
    const hopInner = hopWayback?.innerUrl ?? hop.url;
    const ts14 = hopWayback?.ts14 ?? target.ts14;
    const storeKey = snapshotKey(hopInner, ts14);
    if (storedKeys.has(storeKey)) {
      if (skippedAlreadyStored === 0) alreadyStoredTs14 = ts14;
      skippedAlreadyStored++;
      continue;
    }
    storedKeys.add(storeKey);

    const ts17 = (ts14 + "000").slice(0, 17);
    const dateRfc3339 = cdxjTsToRfc3339(ts17);
    const rawCtype = (
      hop.headers.find(
        ([name]) => name.toLowerCase() === "content-type",
      )?.[1] || ""
    )
      .split(";")[0]
      .trim();
    const headers = restoreWaybackHeaders(
      hop.headers,
      rawCtype || "application/octet-stream",
      hop.body,
    );
    const mime =
      (
        headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ||
        rawCtype ||
        "application/octet-stream"
      )
        .split(";")[0]
        .trim() || "application/octet-stream";
    const recordId = `<urn:uuid:${crypto.randomUUID()}>`;
    const identifiedPayloadType =
      identifiedTypeFromHeaders(hop.headers) ??
      identifiedTypeBySnapshot.get(storeKey);

    records.push({
      innerUrl: hopInner,
      ts17,
      mime,
      status: hop.status,
      statusText: hop.statusText,
      headers,
      body: hop.body,
      recordId,
      identifiedPayloadType,
      requestRecord:
        records.length === 0
          ? buildRequestRecord(
              target.idUrl,
              recordId,
              dateRfc3339,
              userAgent,
              accept,
              acceptLanguage,
            )
          : undefined,
    });
    lastStatus = hop.status;
    lastTs14 = ts14;

    if (isHtmlMime(mime)) {
      pages.push({
        url: hopInner,
        ts: cdxjTsToRfc3339(ts17),
        title: titleByInnerUrl.get(hopInner) || hopInner,
      });
    }
  }

  return {
    records,
    pages,
    wroteTarget: storedKeys.has(snapshotKey(target.innerUrl, target.ts14)),
    lastStatus,
    lastTs14,
    skippedPlaybackRedirects,
    skippedErrorPages,
    skippedAlreadyStored,
    alreadyStoredTs14,
  };
}

/** True when Wayback would have rewritten a body of this content type. These
 * are the text formats that go through the rewriter (HTML, CSS, JavaScript, and
 * the XML/SVG text types); every other type is served verbatim. Used to guard
 * local reuse: an `im_`/`oe_` route that actually returned one of these (e.g. a
 * 404 HTML error page served for a missing image) was rewritten, so its local
 * body is NOT the identity bytes and must be re-fetched. */
export function isRewritableMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m.includes("html") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("ecmascript") ||
    m.includes("css")
  );
}

/** Turn a locally-resolved WARC record into a restored record, mirroring the
 * network path's header restoration and timestamping. The URL and capture time
 * come from the replay route the chain ended on, not necessarily the requested
 * snapshot: a recorded playback redirect means the bytes belong to another
 * capture, and they are stored under that capture's own time. */
export function recordFromLocal(
  innerUrl: string,
  ts14: string,
  record: WarcRecord,
): KeptRecord {
  const headersArr: [string, string][] = [...record.httpHeaders.entries()];
  const rawCtype = (record.httpHeaders.get("content-type") || "")
    .split(";")[0]
    .trim();
  const headers = restoreWaybackHeaders(
    headersArr,
    rawCtype || "application/octet-stream",
    record.body,
  );
  const mime =
    (
      headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ||
      rawCtype ||
      "application/octet-stream"
    )
      .split(";")[0]
      .trim() || "application/octet-stream";
  return {
    innerUrl,
    ts17: (ts14 + "000").slice(0, 17),
    mime,
    status: record.httpStatus ?? 200,
    statusText: record.httpStatusText || "",
    headers,
    body: record.body,
    recordId: `<urn:uuid:${crypto.randomUUID()}>`,
    identifiedPayloadType:
      record.headers.get("warc-identified-payload-type") || undefined,
  };
}
