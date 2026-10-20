#!/usr/bin/env node
/**
 * server.ts
 *
 * Serves a WACZ archive for replay in the browser. The index page is generated
 * on demand from the archive's index at every request, and archived content is
 * served through /web/<timestamp>/<url> routes with links rewritten to stay
 * local.
 *
 * Usage:
 *   npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose]
 *                                     [--max-connections 64] [--workers N]
 *
 * `--workers N` forks N worker processes (N=0, the default, runs a single
 * process). Each worker serves the same archive on the shared port, so
 * replay stays responsive while a worker is blocked decompressing a large
 * capture. The sync fallback path (`id_`, redirects) still blocks its own
 * worker's event loop, which is exactly what the extra workers absorb.
 */

import * as http from "http";
import * as path from "path";
import * as os from "os";
import cluster from "cluster";
import { Wacz } from "../archive/wacz.js";
import { WarcRecord } from "../archive/warc.js";
import type { CdxjEntry } from "../archive/cdxj.js";
import { renderIndexPage, buildPageRows } from "../replay/index-page.js";
import { rfc3339ToTs14, cdxjTsToRfc1123 } from "../lib/time.js";
import { createDefaultPipeline, ReplayContext } from "../replay/plugins.js";
import { detectContentKind } from "../replay/rewrite.js";
import { URL_FIXER_SCRIPT_ROUTE } from "../replay/url-fixer.js";
import { URL_FIXER_SHIM } from "../replay/url-fixer-shim.js";
import { renderNotFoundPage } from "../replay/not-found.js";
import { LruCache } from "../lib/lru.js";

/** Decode the inner URL of a `/web/<ts>[mod_]/<url>` path for the "not saved"
 * page. A malformed escape is shown as the raw text instead of throwing. */
function replayInnerUrl(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  wacz: string;
  port: number;
  expose: boolean;
  maxConnections: number;
  workers: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    wacz: "",
    port: 8080,
    expose: false,
    maxConnections: 64,
    workers: 0,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = parseInt(argv[++i] || "8080", 10);
    else if (a.startsWith("--port="))
      args.port = parseInt(a.slice("--port=".length), 10);
    else if (a === "--expose") args.expose = true;
    else if (a === "--max-connections")
      args.maxConnections = parseInt(argv[++i] || "64", 10);
    else if (a.startsWith("--max-connections="))
      args.maxConnections = parseInt(a.slice("--max-connections=".length), 10);
    else if (a === "--workers") args.workers = parseInt(argv[++i] || "0", 10);
    else if (a.startsWith("--workers="))
      args.workers = parseInt(a.slice("--workers=".length), 10);
    else if (!a.startsWith("--")) positional.push(a);
  }
  if (positional.length > 0) args.wacz = path.resolve(positional[0]);
  if (!args.wacz) {
    console.error(
      "Usage: npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose] [--max-connections 64] [--workers N]",
    );
    process.exit(1);
  }
  return args;
}

function getLocalExternalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const dev in interfaces) {
    const iface = interfaces[dev]!;
    for (const alias of iface) {
      if (
        alias.family === "IPv4" &&
        alias.address !== "127.0.0.1" &&
        !alias.internal
      ) {
        return alias.address;
      }
    }
  }
  return "0.0.0.0";
}

// ---------------------------------------------------------------------------
// Serving helpers
// ---------------------------------------------------------------------------

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

/** A control character in a header value makes Node's HTTP layer throw, and a
 * crawl can store whatever the origin sent, so normalize what we copy across.
 * Tab is the one control character a header value may keep (RFC 9110 section
 * 5.5). */
function safeHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " ");
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
 * Whether a request asks for a page to be navigated to, rather than for a
 * resource that page uses.
 *
 * Only a navigation may be redirected to a different timestamp: the address bar
 * shows that URL to the visitor, so it should name the capture being served. A
 * subresource URL is an identity instead. Giving one file two URLs makes a
 * script load twice, and for an ES module that means two module instances, so
 * its top-level code runs twice and a repeated `customElements.define(...)`
 * throws. Keeping every subresource at the timestamp the page already uses
 * keeps one URL per file.
 *
 * The Fetch Metadata headers answer this exactly: a navigation is the only
 * request whose destination is a document ("document", or "iframe" for a frame)
 * and whose mode is "navigate". Browsers that send neither (or a command-line
 * client that sends no such header) get the body directly, which is harmless
 * because they have no address bar to keep faithful.
 */
export function isNavigationRequest(req: http.IncomingMessage): boolean {
  const destination = req.headers["sec-fetch-dest"];
  const mode = req.headers["sec-fetch-mode"];
  if (typeof destination === "string" || typeof mode === "string") {
    return (
      destination === "document" ||
      destination === "iframe" ||
      mode === "navigate"
    );
  }
  return false;
}

/** An inclusive byte range `[start, end]`, resolved and clamped against a
 * known total length. */
interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single `Range: bytes=...` header against a body of `total` bytes.
 *
 * Returns:
 *   - a clamped, inclusive `{ start, end }` when the range is satisfiable;
 *   - `null` when there is no range header (serve the whole body);
 *   - `'invalid'` when the range is malformed or unsatisfiable (416).
 *
 * Only a single range is handled (`bytes=0-`, `bytes=500-999`, `bytes=-2048`).
 * A multi-range request (`bytes=0-99,200-299`) is treated as invalid rather
 * than answered with a multipart/byteranges body, which browsers never send
 * for `<video>` seeking anyway.
 */
function parseByteRange(
  header: string | undefined,
  total: number,
): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const startStr = m[1];
  const endStr = m[2];

  if (startStr === "") {
    // Suffix range: the final N bytes (`bytes=-N`).
    if (endStr === "" || total === 0) return "invalid";
    const suffixLen = parseInt(endStr, 10);
    if (suffixLen <= 0) return "invalid";
    return { start: Math.max(0, total - suffixLen), end: total - 1 };
  }

  const start = parseInt(startStr, 10);
  if (endStr === "") {
    // Open-ended range: from `start` to the end (`bytes=N-`).
    if (start >= total) return "invalid";
    return { start, end: total - 1 };
  }

  const end = parseInt(endStr, 10);
  if (start > end || start >= total) return "invalid";
  return { start, end: Math.min(end, total - 1) };
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
    headers["location"] = `/web/${ts}/${target}`;
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
  headers["link"] = `<${url}>; rel="original"`;
  if (entry.filename) headers["x-archive-src"] = entry.filename;
  return headers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // With `--workers N`, run as a cluster: each worker process opens its own
  // WACZ (the file is read-only, so concurrent processes reading it are
  // safe) and serves the shared port. A worker blocked decompressing a large
  // capture stops its own requests, not the others'. This branch runs before
  // the archive is opened, so the primary never holds a useless descriptor.
  if (cluster.isPrimary && args.workers > 1) {
    const n = Math.max(1, Math.min(args.workers, 256));
    for (let i = 0; i < n; i++) cluster.fork();
    cluster.on("exit", (worker) => {
      cluster.fork();
    });
    const shutdownAll = (): void => {
      for (const id of Object.keys(cluster.workers || {})) {
        cluster.workers?.[id]?.kill();
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdownAll);
    process.on("SIGTERM", shutdownAll);
    return;
  }

  const wacz = new Wacz(args.wacz);
  const pipeline = createDefaultPipeline();

  const host = args.expose ? "0.0.0.0" : "127.0.0.1";

  // The index page lists the archive's *pages* (from pages.jsonl), not every
  // captured resource. Each entry points at a /web/<ts>/<url> replay route.
  const buildIndexPage = (): string => {
    const rows = buildPageRows(
      wacz.pages,
      (url, ts) => `/web/${rfc3339ToTs14(ts)}/${url}`,
      (url, ts) => {
        const thumb = wacz.thumbnailFor(url, ts);
        return thumb
          ? `/web/${thumb.timestamp.slice(0, 14)}/${thumb.url}`
          : null;
      },
    );
    return renderIndexPage(wacz.title, rows, [
      "Page",
      "Timestamp",
      "Original URL",
    ]);
  };

  /** The fully-computed response for a replay request, ready to write. */
  interface RenderedResponse {
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    body: Buffer;
  }

  /**
   * The rendered-response cache, keyed by the request path (`/web/<ts>/<url>`),
   * prefixed with `nav:` or `sub:` so a navigation's time-shift 302 and a
   * subresource's body never collide.
   * The archive is immutable while it is being served, and the pipeline is
   * stateless, so a given path always renders to the same bytes -- caching the
   * final response (not just the decompressed record) skips the read + gunzip +
   * link-rewrite + header rebuild for every repeat request of a hot resource.
   * The index page is deliberately NOT cached: its footer carries the current
   * time, and it never reads a record, so there is nothing expensive to skip.
   */
  const replayCache = new LruCache<RenderedResponse>({
    maxEntries: 1024,
    maxBytes: 256 * 1024 * 1024,
    // A rendered response larger than 8 MiB is served directly, not cached:
    // caching one big binary would evict the small HTML/CSS/JS responses
    // that make a page's repeated navigation instant.
    maxEntryBytes: 8 * 1024 * 1024,
    sizeOf: (r) => r.body.length,
  });

  /** Compute the response for a `/web/<ts>/<url>` request, or null for a 404.
   * Moved out of the request handler so it can be cached whole. */
  const renderReplay = async (
    reqUrl: string,
    navigation: boolean,
  ): Promise<RenderedResponse | null> => {
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
    //
    // `ts` is the timestamp of the *request*, not of the capture that the
    // request resolved to. Naming each rewritten link after the capture's own
    // timestamp would let one link point at /web/2001.../ and the next at
    // /web/2003.../, so a single resource collected at several times would be
    // fetched (and, for scripts, executed) once per timestamp. Using the
    // request's timestamp keeps every link inside one page load on the same
    // prefix, which is what makes a module-heavy page load each module once.
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

  // Bound how many connections are open at once. A slow (or idle, keep-alive)
  // client holds a socket open without doing useful work, and each open socket
  // pins a file descriptor plus its buffers. Capping the open-connection count
  // bounds what a pile of slow clients can pin, and hands everyone beyond the
  // cap a clean 503 to retry against instead of silently degrading.
  let activeConnections = 0;
  const connectionCloseListener = (): void => {
    activeConnections--;
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url || "/";

    if (activeConnections > args.maxConnections) {
      res.writeHead(503, {
        "Content-Type": "text/plain",
        "Retry-After": "1",
        Connection: "close",
      });
      res.end("503 Service Unavailable -- too many concurrent connections.");
      return;
    }

    // The url-fixer runtime shim, served as an external script. Injected
    // into every HTML page by the url-fixer plugin via a <script src> that
    // points here; serving it from a stable, cacheable route (rather than
    // inlining it per page) mirrors how Wayback serves wombat.js.
    if (reqUrl === URL_FIXER_SCRIPT_ROUTE) {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(URL_FIXER_SHIM);
      return;
    }

    // Index page -- generated on demand from the archive.
    if (reqUrl === "/" || reqUrl === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildIndexPage());
      return;
    }

    // Replay route: /web/<timestamp>[mod_]/<url>. The rendered body is a pure
    // function of the request path (the archive is immutable and the pipeline
    // is stateless), so it is computed once and cached whole -- repeat requests
    // for a hot resource skip the read + gunzip + rewrite.
    //
    // Whether the request is a page navigation is part of the cache key,
    // because that is the only thing that changes the response for one path:
    // a navigation may answer with a time-shift 302 while a subresource with
    // the same path gets the body.
    const m = reqUrl.match(/^\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i);
    if (m) {
      const navigation = isNavigationRequest(req);
      const cacheKey = navigation ? `nav:${reqUrl}` : `sub:${reqUrl}`;
      let rendered: RenderedResponse | null = replayCache.get(cacheKey) ?? null;
      if (!rendered) {
        rendered = await renderReplay(reqUrl, navigation);
        if (!rendered) {
          // No record for this replay route: show the same plain
          // "not saved" page the flat export writes, with the
          // original address filled in. No CSS, no styling.
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderNotFoundPage(replayInnerUrl(m[3])));
          return;
        }
        replayCache.set(cacheKey, rendered);
      }

      // Byte-range support (RFC 7233). A replay body is fully materialized
      // in `rendered.body` before it is written, so a range request can be
      // satisfied by slicing that buffer at zero cost. This is what lets a
      // browser drag a `<video>` scrubber on an archived video: the media
      // element probes with `Range: bytes=0-` first, then re-requests the
      // exact byte spans it needs as the user seeks. The full body stays in
      // `rendered.headers['content-length']`; a partial answer overrides it
      // and adds `content-range`.
      if (rendered.status === 200) {
        const range = parseByteRange(req.headers.range, rendered.body.length);
        if (range === "invalid") {
          res.writeHead(416, {
            "Content-Range": `bytes */${rendered.body.length}`,
            "Content-Type": "text/plain",
          });
          res.end("416 Range Not Satisfiable");
          return;
        }
        if (range) {
          const chunk = rendered.body.subarray(range.start, range.end + 1);
          const headers: Record<string, string> = { ...rendered.headers };
          delete headers["content-length"];
          headers["content-range"] =
            `bytes ${range.start}-${range.end}/${rendered.body.length}`;
          headers["content-length"] = String(chunk.length);
          res.writeHead(206, headers);
          res.end(chunk);
          return;
        }
      }

      res.writeHead(
        rendered.status,
        rendered.statusText || undefined,
        rendered.headers,
      );
      if (
        rendered.status === 204 ||
        rendered.status === 304 ||
        (rendered.status >= 100 && rendered.status < 200)
      ) {
        res.end();
      } else {
        res.end(rendered.body);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderNotFoundPage(reqUrl));
  });

  // A request handler that never yields means one slow client can hold a
  // socket open indefinitely. Bound the per-socket windows so a dead or
  // malicious client can't pin the event loop: the time to receive request
  // headers, the time to receive the whole request, and the keep-alive idle
  // window before an idle socket is closed.
  server.headersTimeout = 60_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  // Count open connections so `--max-connections` can bound them. The
  // 'connection' event fires once per accepted TCP socket; 'close' fires when
  // it is fully torn down (including keep-alive idle timeouts), so the counter
  // tracks exactly the sockets a slow client can pin.
  server.on("connection", (socket) => {
    activeConnections++;
    socket.on("close", connectionCloseListener);
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then release the archive's file descriptor. A hard timer forces
  // the exit if a client holds a connection open past the drain window.
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received -- shutting down.`);
    server.close(() => {
      wacz.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(args.port, host, () => {
    const workerTag = cluster.isWorker ? ` [worker ${cluster.worker?.id}]` : "";
    console.log(`\n=== WACZ Replay Server${workerTag} ===`);
    console.log(`- Local Access: http://localhost:${args.port}`);
    if (args.expose) {
      console.log(
        `- LAN Access:   http://${getLocalExternalIP()}:${args.port}`,
      );
    }
    console.log(`- Archive:      ${args.wacz} (${wacz.title})`);
    console.log(`- Index:        http://localhost:${args.port}/`);
    console.log("\nReady.");
  });
}

// Run only when executed directly (not when imported by a test).
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  main();
}
