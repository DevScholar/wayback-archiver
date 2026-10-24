/**
 * title.ts
 *
 * Pulling a page title out of an archived HTML body, for the index page.
 */

/** Decode the handful of entities that routinely appear inside `<title>`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

/** Case-insensitive byte offset of `needle` (ASCII only) in `buf`, or -1. */
function indexOfAscii(buf: Buffer, needle: string): number {
  const lower = needle.toLowerCase();
  const latin = buf.toString("latin1").toLowerCase();
  return latin.indexOf(lower);
}

/**
 * Extract a page title from an HTML body: scan from the start up to the closing
 * `</head>` tag for the first `<title>...</title>` pair. Bounding the scan at
 * `</head>` (rather than a fixed window) covers pages whose `<head>` is full of
 * meta tags pushing the title thousands of bytes in. Returns undefined when
 * there is none. Only meaningful for HTML payloads, so callers gate it behind
 * `isHtmlMime`.
 */
export function extractTitle(body: Buffer): string | undefined {
  // Find the end of the head section; fall back to a bounded prefix when the
  // document has no explicit </head>. Latin-1 maps bytes 1:1, so the byte
  // offset is also the char offset we slice on.
  const headEnd = indexOfAscii(body, "</head");
  const head = (
    headEnd > 0 ? body.subarray(0, headEnd) : body.subarray(0, 65536)
  ).toString("utf8");
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!m) return undefined;
  const title = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return title || undefined;
}
