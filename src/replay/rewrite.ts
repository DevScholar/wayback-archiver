/**
 * rewrite.ts
 *
 * Rewrites URL references inside text resources so they point at local content
 * instead of the live web. Three dialects are handled, selected by `kind`:
 *
 *   html -- HTML attributes (href/src/action/background), CSS url() and @import
 *          found inside <style> blocks, and any inline markup.
 *   css  -- CSS url() and @import.
 *   js   -- ES module specifiers: `import 'x'`, `import("x")`, and
 *          `import/export ... from "x"`. These are the URLs a browser's module
 *          loader resolves *before* any page JavaScript runs, so the runtime
 *          shim cannot rewrite them -- they must be rewritten here, in the
 *          source, at serve time.
 *
 * The caller supplies a single `rewrite` callback: absolute URL -> new string
 * or null (null leaves the reference untouched). This keeps the byte-level
 * rewriting independent of the two consumers (the replay server's /web/ route
 * and the export-to-html tool's flat-file naming).
 *
 * Each dialect lives in its own module (`rewrite-html`, `rewrite-css`,
 * `rewrite-js`); this file selects one and classifies a response.
 */

import { rewriteHtml } from "./rewrite-html.js";
import { rewriteCss } from "./rewrite-css.js";
import { rewriteJs } from "./rewrite-js.js";
import type { ContentKind, UrlRewriter } from "./rewrite-common.js";

export type { ContentKind, UrlRewriter } from "./rewrite-common.js";

export function rewriteContent(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
  kind: ContentKind,
): string {
  if (kind === "js") return rewriteJs(content, baseUrl, rewrite);
  if (kind === "css") return rewriteCss(content, baseUrl, rewrite);
  return rewriteHtml(content, baseUrl, rewrite);
}

/** Classify a resource as html/css/js for rewriting, or null if it is not
 * text we should rewrite (binary, JSON, plain text, ...).
 *
 * The decision rests on the archive's own content-type -- the mime already
 * resolved at ingest (the restorer falls back to the record's HTTP
 * content-type, then the CDXJ mime). The URL's extension is deliberately not
 * consulted: a `.php`/`.asp`/`.jsp`/`.cgi` path was server-rendered to HTML
 * *before* it was archived, so the extension describes the template, not the
 * bytes. The mime is what the response actually was. */
export function detectContentKind(mime: string): ContentKind | null {
  const m = (mime || "").toLowerCase();
  if (/html/.test(m)) return "html";
  if (/css/.test(m)) return "css";
  if (/javascript|ecmascript/.test(m)) return "js";
  return null;
}
