/**
 * naming.ts
 *
 * The flat file names the exporter gives archived resources.
 *
 * Every extracted file is named `<prefix>~<n><ext>` where `<prefix>` is the
 * first five characters of the original file name (the URL's basename),
 * lowercased, and `<n>` is a counter that disambiguates files sharing a prefix.
 * The extension is taken from the URL when present, otherwise derived from the
 * content type (text/html -> .html, image/jpeg -> .jpg, ...), otherwise omitted
 * -- matching examples like `about~1.html`, `infor~2.asp`, `cdx~1`.
 */

import { lookupKey } from "../lib/url.js";

/** Map a content-type (or CDXJ mime) to a file extension, or '' if unknown. */
export function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("text/html")) return ".html";
  if (m.includes("image/jpeg")) return ".jpg";
  if (m.includes("image/png")) return ".png";
  if (m.includes("image/gif")) return ".gif";
  if (m.includes("image/svg")) return ".svg";
  if (m.includes("text/css")) return ".css";
  if (m.includes("javascript")) return ".js";
  if (m.includes("application/json")) return ".json";
  if (m.includes("text/plain")) return ".txt";
  if (m.includes("image/bmp")) return ".bmp";
  if (m.includes("image/x-icon") || m.includes("image/vnd.microsoft.icon"))
    return ".ico";
  return "";
}

/** Strip characters that are illegal in filenames on Windows/Linux. */
export function sanitizeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

/**
 * Server-side / SSI page extensions that produce HTML bodies but are not
 * recognized as HTML by a browser reading straight from disk. Under `file://`
 * the browser infers MIME from the file extension alone, so leaving these as
 * `.asp`/`.shtml`/… makes the browser render the raw markup (or offer to
 * download it) instead of displaying the page. When such a resource is
 * actually HTML, its flat file is renamed to `.html`.
 */
const HTML_SCRIPT_EXTS = new Set([
  ".asp",
  ".aspx",
  ".php",
  ".cfm",
  ".cgi",
  ".jsp",
  ".shtml",
]);

/**
 * Top-level domains that show up as the tail of a bare hostname when a URL is
 * just a domain root — e.g. `http://www.microsoft.com/` seen through a Wayback
 * replay URL gives basename `www.microsoft.com`. `splitName` then splits at the
 * last dot and treats `.com`/`.org`/… as if they were file extensions, but a
 * browser under `file://` has no MIME for them and offers to download the page
 * instead of rendering it. Like the SSI extensions above, a TLD "extension" on
 * an HTML resource is rewritten to `.html`.
 */
const DOMAIN_TLDS = new Set([
  ".com",
  ".org",
  ".net",
  ".edu",
  ".gov",
  ".mil",
  ".int",
  ".io",
  ".co",
  ".tv",
  ".me",
  ".cc",
  ".info",
  ".biz",
  ".name",
  ".mobi",
  ".asia",
  ".uk",
  ".us",
  ".ca",
  ".au",
  ".nz",
  ".de",
  ".fr",
  ".it",
  ".es",
  ".nl",
  ".se",
  ".no",
  ".dk",
  ".fi",
  ".at",
  ".be",
  ".ch",
  ".pl",
  ".cz",
  ".sk",
  ".hu",
  ".gr",
  ".pt",
  ".ru",
  ".cn",
  ".jp",
  ".kr",
  ".tw",
  ".hk",
  ".sg",
  ".in",
  ".br",
  ".mx",
  ".za",
  ".ar",
  ".cl",
  ".tr",
  ".il",
  ".ie",
  ".is",
]);

/** Rewrite extensions that are not real file types, but only when the resource
 * is known:
 *
 *   - A bare-hostname TLD (`.com`, `.org`, …) is never a real file extension:
 *     under `file://` the browser has no MIME for it and offers to download the
 *     resource instead of rendering it. Fall back to the content-type's own
 *     extension — a page becomes `.html`, a `urn:view:` screenshot becomes
 *     `.png`, and so on.
 *   - A server-side script extension (`.php`, `.asp`, …) on an HTML body must
 *     become `.html`; the same suffix on a JSON or image response keeps its own
 *     identity. */
export function normalizeExt(ext: string, mime: string): string {
  const fromMime = extFromMime(mime);
  if (DOMAIN_TLDS.has(ext)) return fromMime || ext;
  if (HTML_SCRIPT_EXTS.has(ext) && fromMime === ".html") return ".html";
  return ext;
}

export interface NameParts {
  stem: string;
  urlExt: string;
}

export function urlBasename(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = "";
  }
  let base = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  base = base.slice(base.lastIndexOf("/") + 1);
  if (base === "") base = "index";
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep raw */
  }
  return sanitizeName(base);
}

export function splitName(url: string): NameParts {
  const base = urlBasename(url);
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    return { stem: base.slice(0, dot), urlExt: base.slice(dot).toLowerCase() };
  }
  return { stem: base, urlExt: "" };
}

/**
 * Identity of a single capture: normalized URL + 14-digit timestamp. Two
 * captures of the same URL at different times are distinct pages and must each
 * be exported (a multi-capture archive lists every version). The 14-digit
 * timestamp is the shared unit here: pages.jsonl carries second precision and
 * the restorer stamps whole seconds, so it uniquely identifies a capture.
 */
export function captureKey(url: string, ts14: string): string {
  return lookupKey(url) + " " + ts14;
}

/**
 * The flat file name of one capture, from a URL's stem and extension. The
 * prefix is lowercased *after* slicing: some non-ASCII letters change byte
 * length when lowercased (U+00DF, U+0130), so slicing first keeps the prefix a
 * true "first five characters, lowercased". Lowercasing also makes the stem
 * consistent with the already-lowercased extension, and prevents case
 * collisions (FOO.png vs foo.png) on case-insensitive filesystems.
 */
export function flatFileName(
  url: string,
  mime: string,
  counters: Map<string, number>,
): string {
  const { stem, urlExt } = splitName(url);
  const prefix = sanitizeName(stem.slice(0, 5)).toLowerCase();
  const ext = normalizeExt(urlExt || extFromMime(mime), mime);
  const groupKey = prefix + "|" + ext;
  const n = (counters.get(groupKey) || 0) + 1;
  counters.set(groupKey, n);
  return `${prefix}~${n}${ext}`;
}
