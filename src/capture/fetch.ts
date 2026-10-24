/**
 * fetch.ts
 *
 * Fetching one URL and following its redirects, recording every hop so the
 * archive keeps the redirect notices themselves as historical material.
 */

import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { clientHeaders, collectHeaders, sleep } from "../lib/http.js";

// 429 (Too Many Requests) handling: retry with a fixed delay between attempts.
const MAX_429_RETRIES = 3; // extra attempts beyond the first
const RETRY_DELAY_MS = 500; // 0.5s between each retried link

export interface FetchedHop {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Buffer;
}

export interface FetchResult {
  /** One entry per redirect hop plus the final response, in request order. */
  hops: FetchedHop[];
  /** Shared RFC3339 capture time for the whole chain. */
  dateRfc3339: string;
}

/**
 * Follow redirects (up to 8 hops) and record every hop, not just the final
 * response. A 3xx is archived as its own (empty-body) response under its own
 * URL -- the redirect itself is historical material, exactly as the restorer
 * treats redirect notices -- and the final 200/error is the last hop. All hops
 * share one capture timestamp. 429 responses are retried a few times with a
 * fixed delay before giving up.
 */
export function fetchUrl(
  url: string,
  userAgent: string,
  accept: string,
  acceptLanguage: string,
): Promise<FetchResult> {
  const dateRfc3339 = new Date().toISOString();
  const hops: FetchedHop[] = [];
  return new Promise((resolve, reject) => {
    const attempt = (
      current: string,
      redirects: number,
      retryCount: number,
    ): void => {
      if (redirects > 8) {
        reject(new Error("too many redirects"));
        return;
      }
      const lib = current.startsWith("https:") ? https : http;
      const req = lib.get(
        current,
        { headers: clientHeaders(userAgent, accept, acceptLanguage) },
        (res) => {
          const status = res.statusCode || 0;
          const statusText = res.statusMessage || "";
          const loc = res.headers.location;

          // 429 Too Many Requests -> back off 0.5s and retry (bounded).
          if (status === 429) {
            res.resume();
            if (retryCount < MAX_429_RETRIES) {
              sleep(RETRY_DELAY_MS).then(() =>
                attempt(current, redirects, retryCount + 1),
              );
            } else {
              reject(
                new Error(
                  `HTTP 429 (gave up after ${MAX_429_RETRIES} retries)`,
                ),
              );
            }
            return;
          }

          // Redirect: archive this hop (empty body) under its own URL, then
          // follow `location`. The 3xx + location is kept, not swallowed.
          if (status >= 300 && status < 400 && loc) {
            res.resume();
            hops.push({
              url: current,
              status,
              statusText,
              headers: collectHeaders(res.headers),
              body: Buffer.alloc(0),
            });
            let next: string;
            try {
              next = new URL(loc, current).href;
            } catch {
              next = loc;
            }
            if (!/^https?:\/\//i.test(next)) {
              reject(new Error(`bad redirect location: ${loc}`));
              return;
            }
            attempt(next, redirects + 1, retryCount);
            return;
          }

          // Transparently decompress so the archived record carries the
          // decoded payload (matching how the crawler stores it). When we
          // decompress, the original `content-encoding` and the
          // pre-decompression `content-length` no longer describe the
          // body, so drop both -- otherwise the record would claim to be
          // gzip while holding decoded bytes, and a third-party replayer
          // would try to gunzip it again.
          const encoding = String(
            res.headers["content-encoding"] || "",
          ).toLowerCase();
          const decompress =
            encoding.includes("gzip") || encoding.includes("deflate");

          const headers = collectHeaders(res.headers).filter(([k]) => {
            const lower = k.toLowerCase();
            return !(
              decompress &&
              (lower === "content-encoding" || lower === "content-length")
            );
          });

          let stream: NodeJS.ReadableStream = res;
          if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
          else if (encoding.includes("deflate"))
            stream = res.pipe(zlib.createInflate());

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", (e) => reject(e));
          stream.on("end", () => {
            hops.push({
              url: current,
              status,
              statusText,
              headers,
              body: Buffer.concat(chunks),
            });
            resolve({ hops, dateRfc3339 });
          });
        },
      );
      req.on("error", (e) => reject(e));
      req.setTimeout(120000, () => {
        req.destroy(new Error("timeout"));
      });
    };
    attempt(url, 0, 0);
  });
}
