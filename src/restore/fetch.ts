/**
 * fetch.ts
 *
 * One `id_` fetch of the restorer: follow its redirect chain, recording every
 * hop, and report a rate limit to the caller instead of retrying it here.
 */

import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { parseWaybackUrl, isPlaybackRedirect } from "../lib/wayback.js";
import { clientHeaders, collectHeaders } from "../lib/http.js";

export interface FetchedHop {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Buffer;
}

/** The outcome of one fetch attempt, before any 429 retry is applied. */
export type FetchOutcome =
  | { kind: "ok"; hops: FetchedHop[] }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

/**
 * Decide which URL to fetch next after a redirect.
 *
 * The restorer must never leave the archive: following a historical `Location`
 * to the live web would archive 2026 content under an old URL. So when the
 * redirect was served by a Wayback route, a non-Wayback target is fetched
 * through Wayback at the same capture time (`/web/<ts>id_/<target>`), which
 * yields that capture's archived copy.
 *
 * A playback redirect (the timestamp shift Wayback writes itself, detected by
 * its `X-Archive-Redirect-Reason` header) names another replay route, either
 * absolute or relative to the Wayback host, and is followed unchanged. Without
 * that header an absolute replay URL is recognised from its form; a relative
 * `/web/...` path is also treated as playback, since it cannot be a location on
 * the captured site.
 */
export function resolveRedirectUrl(
  location: string,
  currentUrl: string,
  playbackRedirect = false,
): string | null {
  let resolved: string;
  const current = parseWaybackUrl(currentUrl);

  if (!current) {
    try {
      resolved = new URL(location, currentUrl).href;
    } catch {
      return null;
    }
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  }

  if (playbackRedirect || isPlaybackRedirect(location, currentUrl)) {
    try {
      resolved = new URL(location, currentUrl).href;
    } catch {
      return null;
    }
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  }

  // Resolve a historical Location against the URL the capture is of, not
  // against the Wayback route that served it.
  try {
    resolved = new URL(location, current.innerUrl).href;
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(resolved)) return null;
  return `https://web.archive.org/web/${current.ts14}id_/${resolved}`;
}

/**
 * Fetch a URL, following redirects (up to 8 hops) and recording every hop, not
 * just the final response. A 3xx is kept as its own (empty-body) hop under its
 * own URL; the final 200/error is the last hop. A 429 is *not* retried here --
 * it is reported as `rate-limited` so the caller can move it onto the slow
 * queue. Bodies are decompressed transparently so the stored record carries the
 * decoded payload.
 */
export function fetchOnce(
  url: string,
  userAgent: string,
  accept: string,
  acceptLanguage: string,
  offline = false,
): Promise<FetchOutcome> {
  // `--offline` short-circuits the fetch: no socket is opened, so archive.org
  // can be "unreachable" without waiting out a real connection timeout. Every
  // target then fails instantly and is carried over as-is, leaving the archive
  // unchanged.
  if (offline)
    return Promise.resolve({
      kind: "error",
      message: "offline (no network access)",
    });
  return new Promise((resolve) => {
    const hops: FetchedHop[] = [];
    const attempt = (current: string, redirects: number): void => {
      if (redirects > 8) {
        resolve({ kind: "error", message: "too many redirects" });
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

          if (status === 429) {
            res.resume();
            resolve({ kind: "rate-limited" });
            return;
          }

          if (status >= 300 && status < 400 && loc) {
            res.resume();
            hops.push({
              url: current,
              status,
              statusText,
              headers: collectHeaders(res.headers),
              body: Buffer.alloc(0),
            });
            const playbackRedirect =
              res.headers["x-archive-redirect-reason"] !== undefined;
            const next = resolveRedirectUrl(loc, current, playbackRedirect);
            if (!next) {
              resolve({
                kind: "error",
                message: `bad redirect location: ${loc}`,
              });
              return;
            }
            attempt(next, redirects + 1);
            return;
          }

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
          stream.on("error", (e) =>
            resolve({ kind: "error", message: e.message }),
          );
          stream.on("end", () => {
            hops.push({
              url: current,
              status,
              statusText,
              headers,
              body: Buffer.concat(chunks),
            });
            resolve({ kind: "ok", hops });
          });
        },
      );
      req.on("error", (e) => resolve({ kind: "error", message: e.message }));
      req.setTimeout(120000, () => {
        req.destroy(new Error("timeout"));
      });
    };
    attempt(url, 0);
  });
}
