/**
 * headers.ts
 *
 * The headers a replay answers with. An archived header is not replayed as it
 * stands: the ones that describe the payload pass through, and every other one
 * is reported as an original value under the prefix the Wayback Machine uses,
 * so an archived `Content-Security-Policy` or `Set-Cookie` cannot act on the
 * visitor's browser.
 */

import type { WarcRecord } from "../archive/warc.js";
import type { CdxjEntry } from "../archive/cdxj.js";
import { cdxjTsToRfc1123 } from "../lib/time.js";

const TEXT_HTML = /text\/html/i;

/**
 * Pick a charset for an HTML body that does not declare one. In order: a UTF-8
 * BOM, a `<meta>` charset, then the bytes themselves -- valid UTF-8 is served as
 * UTF-8, and anything else falls back to Windows-1252, the usual encoding of
 * 1990s Western pages (and a superset of Latin-1). This is a best effort for
 * archives that did not record `WARC-Identified-Payload-Type`; when they did,
 * that value wins before this is called.
 */
export function sniffCharset(body: Buffer, mime: string): string | undefined {
  if (!TEXT_HTML.test(mime)) return undefined;
  if (
    body.length >= 3 &&
    body[0] === 0xef &&
    body[1] === 0xbb &&
    body[2] === 0xbf
  )
    return "utf-8";
  const s = body.subarray(0, 8192).toString("latin1");
  const meta = s.match(/<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9\-_]+)/i);
  if (meta) return meta[1];
  return isValidUtf8(body) ? "utf-8" : "windows-1252";
}

/** True when the bytes decode as UTF-8 without a replacement character. */
function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * The charset the crawler identified for this payload, from the WARC-level
 * `WARC-Identified-Payload-Type` header (e.g. `text/html; charset=windows-1252`),
 * or undefined. This is the browser's sniff of the *actual stored bytes*, so it
 * is the most faithful declaration available when the historical HTTP
 * `Content-Type` (and the page's own `<meta>`) never declared one -- the common
 * case for 1990s servers, whose bodies carry raw Windows-1252 bytes (an em-dash
 * as 0x97) with no encoding metadata at all.
 */
function identifiedCharset(record: WarcRecord): string | undefined {
  const ipt = record.headers.get("warc-identified-payload-type");
  if (!ipt) return undefined;
  const m = /[;\s]charset\s*=\s*"?([a-zA-Z0-9._-]+)"?/i.exec(ipt);
  return m ? m[1] : undefined;
}

/**
 * Archived headers replayed as they stand.
 *
 * Only the headers that describe the payload itself pass through, because the
 * browser needs them to render the bytes. Every other archived header describes
 * an origin that is no longer being contacted, so replaying it would either
 * mislead the visitor's browser or steer it according to rules that belong to a
 * server on another machine: `cache-control`/`expires`/`etag` would cache a
 * replay the way that server wanted, `strict-transport-security` and
 * `permissions-policy` would impose its security policy here, `set-cookie`
 * would write its session cookie into the visitor's browser, `server` would
 * claim the wrong machine, and a `content-security-policy` would block every
 * local asset, including the injected url-fixer shim.
 *
 * The Wayback Machine draws the same line: a replay of a 1996 page answers with
 * its own `server`, `date` and `memento-datetime`, sends `content-type` from the
 * capture, and reports every original header as `x-archive-orig-<name>`. We
 * follow that rule, with `X-Archive-Orig-<Name>` kept for the whole set (pywb,
 * the engine behind archiveweb.page, uses this spelling).
 */
const PASSTHROUGH_HEADERS = new Set(["content-type"]);

/** Header names whose canonical spelling is not "capitalize every word". */
const HEADER_ACRONYMS: Record<string, string> = {
  "content-md5": "Content-MD5",
  etag: "ETag",
  p3p: "P3P",
  te: "TE",
  "www-authenticate": "WWW-Authenticate",
  "x-ua-compatible": "X-UA-Compatible",
  "x-xss-protection": "X-XSS-Protection",
};

/** Canonical spelling of an archived header name. The WARC parser stores header
 * names lowercased, and `Content-Security-Policy` reads better than
 * `content-security-policy` in a header the user inspects. */
export function canonicalHeaderName(lower: string): string {
  const acronym = HEADER_ACRONYMS[lower];
  if (acronym) return acronym;
  return lower
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

/** Prefix for the original value of a header that is not replayed as it stands.
 * This is the pywb / archiveweb.page convention. */
const ARCHIVE_PREFIX = "X-Archive-Orig-";

/**
 * Archived headers whose original value the Wayback Machine reports under the
 * short prefix. Its replay answers with `X-Orig-Content-Encoding`, not
 * `X-Archive-Orig-Content-Encoding`, so a client written against Wayback finds
 * the encoding where it expects it. We follow the spelling, because this server
 * is meant to be dropped in where a Wayback replay URL was used.
 */
const SHORT_PREFIX_HEADERS: Record<string, string> = {
  "content-encoding": "X-Orig-Content-Encoding",
};

/**
 * Reporting prefixes that mean "an original header, kept aside". An archive
 * captured *through* a replay carries these names already, so replaying one adds
 * no second prefix: `x-archive-orig-server` stays `X-Archive-Orig-Server`
 * instead of turning into `X-Archive-Orig-X-Archive-Orig-Server`.
 */
const REPORT_PREFIXES = ["x-archive-orig-", "x-orig-"];

/** Encode one character as the UTF-8 percent escapes a URL would use. */
function percentEncode(character: string): string {
  let out = "";
  for (const byte of Buffer.from(character, "utf8")) {
    out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** A control character in a header value makes Node's HTTP layer throw, and a
 * crawl can store whatever the origin sent, so normalize what we copy across.
 * Tab is the one control character a header value may keep (RFC 9110 section
 * 5.5). A character above U+00FF throws too, because a header value is bytes
 * and Node refuses a code point that is not one. */
function safeHeaderValue(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " ")
    .replace(/[^\u0000-\u00ff]/g, percentEncode);
}

/**
 * A URL as it may appear inside an HTTP header value.
 *
 * `Link: <url>; rel="original"` and `Location: /web/<ts>/<url>` both name the
 * original address, and a crawl keeps that address the way the site wrote it. A
 * Chinese page's URL holds the characters themselves --
 * `.../decisionpoint.asp?lcid=2052&MSCOMTB=MS_Microsoft 指南` is what this
 * archive stores -- so passing it through made Node reject the response and
 * killed the whole replay server. Percent-encoding restores printable ASCII and
 * also encodes the space that would otherwise end a `Link` reference. A `%` is
 * left alone, so an address that is already encoded is not encoded twice.
 */
function headerUrl(url: string): string {
  return url.replace(/[^\x21-\x7e]|[<>"]/g, percentEncode);
}

/**
 * Rebuild a replay's response headers.
 *
 * An archived header is not replayed as it stands: `content-type` describes the
 * payload and passes through (see `PASSTHROUGH_HEADERS`), `content-encoding`
 * becomes `X-Orig-Content-Encoding`, and the rest becomes
 * `X-Archive-Orig-<Name>`. A header that already carries one of those reporting
 * names, which happens when the archive was captured through a replay, keeps its
 * name. The live response carries only what this server can honestly say:
 *
 *   - `content-type` from the capture, with a charset declared when the capture
 *     never declared one;
 *   - `content-length` and `accept-ranges` for the body we actually send;
 *   - `location`, rewritten to a captive `/web/<ts>/<url>` route so a redirect
 *     resolves locally instead of leaking to the live web;
 *   - `memento-datetime`, `link` and `x-archive-src`, the metadata the Wayback
 *     Machine reports about the capture being served.
 *
 * Bodyless responses (204/304/1xx) carry no `content-length` (RFC 7230 section
 * 3.3.2), matching how the caller ends them.
 */
export function buildReplayHeaders(
  record: WarcRecord,
  entry: CdxjEntry,
  url: string,
  ts: string,
  mime: string,
  body: Buffer,
  status: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of record.httpHeaders) {
    const lower = name.toLowerCase();
    const safeValue = safeHeaderValue(value);
    if (PASSTHROUGH_HEADERS.has(lower)) {
      headers[lower] = safeValue;
      continue;
    }
    const shortName = SHORT_PREFIX_HEADERS[lower];
    if (shortName) {
      headers[shortName] = safeValue;
      continue;
    }
    if (REPORT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      headers[canonicalHeaderName(lower)] = safeValue;
      continue;
    }
    headers[ARCHIVE_PREFIX + canonicalHeaderName(lower)] = safeValue;
  }

  // The archived `location` is reported like any other original header; the live
  // one points at the replay route so the redirect stays local.
  const loc = record.httpHeaders.get("location");
  if (loc) {
    let target = loc;
    try {
      target = new URL(loc, url).href;
    } catch {
      /* keep the raw value */
    }
    headers["location"] = `/web/${ts}/${headerUrl(target)}`;
  }

  let contentType = headers["content-type"] || mime;
  // Resolve the charset to declare. The historical server's own `Content-Type`
  // charset (already in `contentType`) wins; otherwise prefer the crawler's
  // `WARC-Identified-Payload-Type` (matches the stored bytes), then a `<meta>`
  // charset, then the bytes themselves (UTF-8 when valid, else Windows-1252).
  // Declaring the charset -- not transcoding -- keeps the stored bytes
  // verbatim while telling the browser how to decode them.
  if (!/charset=/i.test(contentType)) {
    const charset =
      identifiedCharset(record) ?? sniffCharset(body, contentType);
    if (charset) {
      contentType += `; charset=${charset}`;
    } else if (TEXT_HTML.test(contentType)) {
      contentType += "; charset=utf-8";
    }
  }
  headers["content-type"] = contentType;

  // Bodyless responses (204/304/1xx) must not carry a Content-Length
  // (RFC 7230 section 3.3.2); we end those without a body below.
  const bodyless =
    status === 204 || status === 304 || (status >= 100 && status < 200);
  if (!bodyless) {
    headers["content-length"] = String(body.length);
    // Advertise range support so the browser may seek into a replay body
    // (most usefully an archived video) with byte-range requests.
    headers["accept-ranges"] = "bytes";
  }

  // What the Wayback Machine tells a client about the capture it is serving:
  // when it was taken, which capture it is, and where the bytes came from.
  headers["memento-datetime"] = cdxjTsToRfc1123(entry.timestamp);
  headers["link"] = `<${headerUrl(url)}>; rel="original"`;
  if (entry.filename) headers["x-archive-src"] = entry.filename;
  return headers;
}
