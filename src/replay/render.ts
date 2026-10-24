/**
 * render.ts
 *
 * Rendering one replay response: resolve the requested URL against the archive,
 * answer a navigation that landed on a different timestamp with a redirect,
 * then rewrite a text body and rebuild its headers. The result is a pure
 * function of the request path -- the archive is immutable and the pipeline is
 * stateless -- so the server can cache it whole.
 */

import type { Wacz } from "../archive/wacz.js";
import type { PluginPipeline, ReplayContext } from "./plugins.js";
import { detectContentKind } from "./rewrite.js";
import { buildReplayHeaders } from "./headers.js";

/** The fully-computed response for a replay request, ready to write. */
export interface RenderedResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Whether a replay body needs the plugin pipeline run over it. Text content
 * (HTML/CSS/JS) does; binary content, identity (`id_`) requests, and redirects
 * (3xx, which carry no page to rewrite) do not -- their stored bytes are served
 * verbatim. This mirrors the condition the pipeline plugin `matches` checks,
 * kept here so the server can decide between streaming (verbatim) and buffered
 * rewrite (transform) without duplicating the mime classification.
 */
function shouldRewrite(
  mime: string,
  status: number,
  identity: boolean,
): boolean {
  if (identity) return false;
  if (status >= 300 && status < 400) return false;
  return detectContentKind(mime) !== null;
}

/**
 * Build the function that computes the response for a `/web/<ts>/<url>` request,
 * or null when the archive has no record for it.
 *
 * The timestamp used for rewritten links is the timestamp of the *request*, not
 * of the capture that the request resolved to. Naming each rewritten link after
 * the capture's own timestamp would let one link point at /web/2001.../ and the
 * next at /web/2003.../, so a single resource collected at several times would
 * be fetched (and, for scripts, executed) once per timestamp. Using the
 * request's timestamp keeps every link inside one page load on the same prefix,
 * which is what makes a module-heavy page load each module once.
 */
export function createReplayRenderer(
  wacz: Wacz,
  pipeline: PluginPipeline,
): (reqUrl: string, navigation: boolean) => Promise<RenderedResponse | null> {
  return async function renderReplay(
    reqUrl: string,
    navigation: boolean,
  ): Promise<RenderedResponse | null> {
    const m = reqUrl.match(/^\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i);
    if (!m) return null;

    const reqTs = m[1];
    const modifier = m[2] ? m[2].toLowerCase() : "";
    const identity = modifier === "id_";
    let rawUrl = m[3];
    // `urn:` URLs (page thumbnails: `urn:thumbnail:<page-url>`) already
    // carry a scheme but not the `://` form the check below assumes; a
    // bare hostname still needs `http://`. Leave `urn:` untouched.
    if (
      !/^urn:/i.test(rawUrl) &&
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)
    ) {
      rawUrl = "http://" + rawUrl.replace(/^(https?|ftp)\//, "");
    }

    // Resolve the raw (still percent-encoded) URL first. Decoding the
    // whole URL up front is wrong: a percent-encoded reserved character
    // in a query value (e.g. `%23` = `#` inside a color parameter)
    // becomes a literal `#`, which lookupKey then treats as a fragment
    // separator and strips -- making the lookup miss entries the archive
    // stores with the encoded form. Only fall back to a decoded form
    // when the raw URL genuinely misses (e.g. non-ASCII characters the
    // client percent-encoded).
    let rec = await wacz.resolveRecordAsync(rawUrl, reqTs);
    if (!rec) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawUrl);
      } catch {
        decoded = rawUrl;
      }
      if (decoded !== rawUrl)
        rec = await wacz.resolveRecordAsync(decoded, reqTs);
    }
    if (!rec) return null;

    // The requested timestamp may not be a real capture: the archive
    // resolves to the *nearest* capture at or around the requested time.
    // For a page navigation -- where the address bar shows the timestamp --
    // redirect to the capture's faithful timestamp, the same way the Wayback
    // Machine 302s a time-shifted request to the capture's actual time, so
    // the address bar never claims one time while serving another.
    //
    // Subresources (scripts, styles, images, fetches) are NOT redirected.
    // Their URL is an identity, not something the visitor reads: a second URL
    // for the same file is a second copy. For an ES module that copy is a
    // second module instance, so its top-level code runs twice -- and a
    // second `customElements.define(...)` throws, which kills a JavaScript
    // app before it renders anything. Keeping one URL per resource also lets
    // the rewrite prefix below stay fixed for the whole page load.
    const actualTs = rec.entry.timestamp.slice(0, 14);
    if (navigation && actualTs !== reqTs) {
      // Preserve the modifier across the time-shift redirect so an
      // `id_` request stays in identity mode after it lands on the
      // capture's faithful timestamp.
      return {
        status: 302,
        headers: { Location: `/web/${actualTs}${m[2] || ""}/${rawUrl}` },
        body: Buffer.from("Redirecting to the capture at " + actualTs),
      };
    }

    const record = rec.record;
    const mime =
      record.httpHeaders.get("content-type") ||
      rec.entry.mime ||
      "application/octet-stream";

    // Replay the archived status, modifying only the few headers that
    // would otherwise corrupt rendering or leak to the live web.
    const status = record.httpStatus ?? 200;

    // Run the response through the plugin pipeline: static rewriting
    // plus the url-fixer shim injection. Non-text bodies pass through
    // unchanged because neither plugin matches them. Redirects are
    // skipped too: a 3xx has no page to rewrite or shim, and injecting
    // the url-fixer script into its empty body would turn a bare 302
    // into one that carries a script and a misleading content-length.
    const ctx: ReplayContext = {
      url: rec.matchedUrl,
      ts: reqTs,
      mime,
      body: record.body,
      mode: "server",
    };
    // The body is rewritten only when the mime is text (and the request is
    // not identity mode / a redirect). Everything else is served verbatim,
    // so a large binary never has to be copied through a rewrite buffer.
    const rewrite = shouldRewrite(mime, status, identity);
    const body = rewrite ? pipeline.apply(ctx) : record.body;

    const headers = buildReplayHeaders(
      record,
      rec.entry,
      rec.matchedUrl,
      ctx.ts,
      mime,
      body,
      status,
    );
    return {
      status,
      statusText: record.httpStatusText || undefined,
      headers,
      body,
    };
  };
}
