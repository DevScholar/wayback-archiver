/**
 * rewrite-html.ts
 *
 * HTML URL references: `href`/`src`/`action`/`background`/`poster` attributes in
 * all three value syntaxes, `srcset` candidates, CSS `url()` and `@import`
 * inside `<style>` blocks, and a `<meta http-equiv="refresh">` target. The body
 * of every `<script>` block is left alone.
 */

import { toAbsolute, type UrlRewriter } from "./rewrite-common.js";
import {
  rewriteCss,
  rewriteCssImports,
  rewriteCssUrlRefs,
} from "./rewrite-css.js";

/** Decode the HTML entities that realistically show up inside a URL in an
 * attribute value (`&amp;` being the common one); everything else is left
 * untouched. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * Rewrite a srcset value correctly. Per the HTML spec, a candidate's URL is a
 * run of non-whitespace characters, so a comma *inside* a query string (e.g.
 * `?op_usm=1.5,0.65`) is part of the URL -- only a comma at a candidate
 * boundary (followed by whitespace, or at end) separates candidates. A naive
 * split-on-comma corrupts URLs with commas in their query, which is exactly
 * how the hero `srcset` above broke.
 */
function rewriteSrcset(
  value: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  // Split candidates on a comma that is at end-of-string or followed by
  // whitespace (the delimiter the spec's parsing algorithm actually uses).
  const candidates = value.split(/,(?=\s|$)/);
  const out = candidates.map((cand) => {
    // A candidate is `[leading-ws] URL [descriptor]`. URL = first non-ws token.
    const m = cand.match(/^(\s*)(\S+)(.*)$/s);
    if (!m) return cand;
    const abs = toAbsolute(m[2], baseUrl);
    if (abs === null) return cand;
    const r = rewrite(abs);
    if (r === null) return cand;
    return m[1] + r + m[3];
  });
  return out.join(",");
}

function rewriteHtmlText(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  // Attributes whose value is a URL, in all three value syntaxes HTML allows:
  // double-quoted, single-quoted, and unquoted. An unquoted value ends at
  // whitespace or `>` (HTML's unquoted attribute value state). A 2001
  // microsoft.com page writes `<img src=/china/windowsxp/mainleft.jpg>`, and
  // leaving that one unrewritten made the browser ask this server for a path it
  // does not serve, so the archived image came back as a 404. The rewritten URL
  // goes back in the syntax the page used: no quote character for an unquoted
  // value.
  const ATTR_RE =
    /(href|src|action|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
  content = content.replace(
    ATTR_RE,
    (
      match: string,
      attr: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      const ref = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const quote =
        unquoted !== undefined ? "" : doubleQuoted !== undefined ? '"' : "'";

      const abs = toAbsolute(ref, baseUrl);
      if (abs === null) return match;

      const hashIdx = abs.indexOf("#");
      const clean = hashIdx >= 0 ? abs.slice(0, hashIdx) : abs;
      const hash = hashIdx >= 0 ? abs.slice(hashIdx) : "";

      const out = rewrite(clean);
      if (out === null) return match;
      return `${attr}=${quote}${out}${hash}${quote}`;
    },
  );

  // srcset: a comma-separated list of `URL [descriptor]` candidates (e.g.
  // `img.webp 1x, img.png 2x`). Each URL is rewritten in place, descriptors
  // are left untouched. This is what makes <picture> WebP sources -- which the
  // crawler archives under their `?basic=.webp` variant -- resolve locally.
  const SRCSET_RE = /srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  content = content.replace(
    SRCSET_RE,
    (
      match: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      if (unquoted !== undefined) {
        // An unquoted value cannot hold whitespace, so no candidate can carry a
        // descriptor, and every comma ends a candidate (HTML's srcset parser
        // ends a URL at a comma in that form).
        const value = unquoted
          .split(",")
          .map((candidate) => {
            const abs = toAbsolute(candidate, baseUrl);
            if (abs === null) return candidate;
            return rewrite(abs) ?? candidate;
          })
          .join(",");
        return `srcset=${value}`;
      }
      const value = doubleQuoted ?? singleQuoted ?? "";
      const quote = doubleQuoted !== undefined ? '"' : "'";
      return `srcset=${quote}${rewriteSrcset(value, baseUrl, rewrite)}${quote}`;
    },
  );

  // CSS url() references inside <style> blocks.
  content = rewriteCssUrlRefs(content, baseUrl, rewrite);

  // CSS @import inside <style> blocks.
  content = rewriteCssImports(content, baseUrl, rewrite);

  // <meta http-equiv="refresh" content="...; URL=...">: a client-side redirect
  // whose target lives in the `content` attribute, not in href/src. It fires
  // as soon as the head is parsed -- before any runtime shim can touch it -- so
  // it must be rewritten here or the page jumps straight to the live web.
  //
  // Non-standard `<meta>` fields (Open Graph, Twitter Card, schema.org) are
  // deliberately left untouched: they only matter to social-media crawlers
  // and online search engines, so rewriting their URLs buys nothing for a
  // local archive and would mangle markup we don't own.
  const META_RE = /<meta\b[^>]*>/gi;
  content = content.replace(META_RE, (tag) => {
    if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) return tag;
    return tag.replace(
      /(content\s*=\s*)(["'])([\s\S]*?)\2/i,
      (whole, name: string, quote: string, value: string) => {
        // `url=` is the last field of the content value, so the URL is
        // everything after it to the end. Do NOT split on `;`: an HTML
        // entity like `&amp;` ends in `;` and would truncate the URL there.
        const m = /^(.*?\burl\s*=\s*)([\s\S]*)$/is.exec(value);
        if (!m) return whole;
        const abs = toAbsolute(decodeHtmlEntities(m[2].trim()), baseUrl);
        if (abs === null) return whole;
        const out = rewrite(abs);
        if (out === null) return whole;
        // Re-encode `&` so a rewritten query stays a valid attribute value.
        return `${name}${quote}${m[1]}${out.replace(/&/g, "&amp;")}${quote}`;
      },
    );
  });

  return content;
}

/**
 * Rewrite an HTML document, leaving the *body* of every `<script>` block alone.
 *
 * The passes in `rewriteHtmlText` are textual, so without this split they also
 * match text that only looks like an attribute. A 2001 microsoft.com page shows
 * the damage: its inline script contains
 *
 *   document.write('<a href="' + sItemURL + '" target=...>E-Mail This Page</a>')
 *
 * and treating the `href="' + sItemURL + '"` inside that string as an attribute
 * resolves the fragment `' + sItemURL + ` as a URL, so its spaces become `%20`
 * and the page is left with `...href="/web/2001/...'%20+%20...` -- a syntax
 * error that stops the script dead.
 *
 * Leaving script bodies untouched is the safe side of the trade: a URL a script
 * builds at runtime is the runtime shim's job (it patches the DOM APIs that
 * consume that URL), while a corrupted script breaks the whole page. The
 * opening tag is still rewritten, so `<script src="...">` keeps working, and
 * `<style>` bodies still get CSS rewriting.
 */
export function rewriteHtml(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  let out = "";
  let lastIndex = 0;
  const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    out += rewriteHtmlText(
      content.slice(lastIndex, match.index),
      baseUrl,
      rewrite,
    );

    const block = match[0];
    const element = match[1].toLowerCase();
    const openEnd = block.indexOf(">") + 1;
    const closeStart = block.toLowerCase().lastIndexOf("</" + element);
    const openTag = block.slice(0, openEnd);
    const body = block.slice(openEnd, closeStart);
    const closeTag = block.slice(closeStart);

    out += rewriteHtmlText(openTag, baseUrl, rewrite);
    out += element === "style" ? rewriteCss(body, baseUrl, rewrite) : body;
    out += closeTag;

    lastIndex = match.index + block.length;
  }
  out += rewriteHtmlText(content.slice(lastIndex), baseUrl, rewrite);
  return out;
}
