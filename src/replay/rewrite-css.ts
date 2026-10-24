/**
 * rewrite-css.ts
 *
 * CSS URL references: `url(...)` and `@import`, in a stylesheet and in the
 * `<style>` blocks of a page.
 */

import { toAbsolute, type UrlRewriter } from "./rewrite-common.js";

/** Rewrite every `url(...)` reference in `content`. */
export function rewriteCssUrlRefs(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  const URL_RE = /url\(\s*["']?(.*?)["']?\s*\)/gi;
  return content.replace(URL_RE, (match, ref: string) => {
    const abs = toAbsolute(ref, baseUrl);
    if (abs === null) return match;
    const out = rewrite(abs);
    if (out === null) return match;
    return `url(${out})`;
  });
}

/** Rewrite every `@import` reference in `content`. */
export function rewriteCssImports(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  const IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(.+?)["']?\s*\)?\s*;/gi;
  return content.replace(IMPORT_RE, (match, ref: string) => {
    const clean = ref.replace(/['"]/g, "").trim();
    const abs = toAbsolute(clean, baseUrl);
    if (abs === null) return match;
    const out = rewrite(abs);
    if (out === null) return match;
    return `@import "${out}";`;
  });
}

/** Rewrite a stylesheet: both passes, `url(...)` then `@import`. */
export function rewriteCss(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  content = rewriteCssUrlRefs(content, baseUrl, rewrite);
  content = rewriteCssImports(content, baseUrl, rewrite);
  return content;
}
