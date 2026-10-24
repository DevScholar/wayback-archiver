/**
 * rewrite-common.ts
 *
 * What every rewriting dialect shares: the caller's callback from an absolute
 * URL to its replacement, and the resolution of a reference against the
 * resource's own URL.
 */

export type UrlRewriter = (absUrl: string) => string | null;

export type ContentKind = "html" | "css" | "js";

const SKIP_SCHEME = /^(javascript|data|mailto|blob|about):/i;

/** Resolve any URL reference (absolute, root-relative, or relative) to an
 * absolute URL, using the resource's own URL as the base. Returns null when
 * the reference cannot or should not be rewritten. */
export function toAbsolute(ref: string, baseUrl: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (r.startsWith("#") || SKIP_SCHEME.test(r)) return null;

  if (r.startsWith("//")) {
    const b = new URL(baseUrl);
    return b.protocol + r;
  }

  try {
    return new URL(r, baseUrl).href;
  } catch {
    return null;
  }
}
