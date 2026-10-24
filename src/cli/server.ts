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
 *
 * The response rules live beside it under `src/replay`: `headers` rebuilds the
 * archived headers, `render` resolves a URL and rewrites its body, and
 * `byte-range` answers a seeking media element.
 */

import * as http from "http";
import * as path from "path";
import * as os from "os";
import cluster from "cluster";
import { Wacz } from "../archive/wacz.js";
import type { CdxjEntry } from "../archive/cdxj.js";
import { renderIndexPage, buildPageRows } from "../replay/index-page.js";
import { rfc3339ToTs14 } from "../lib/time.js";
import { createDefaultPipeline } from "../replay/plugins.js";
import { URL_FIXER_SCRIPT_ROUTE } from "../replay/url-fixer.js";
import { URL_FIXER_SHIM } from "../replay/url-fixer-shim.js";
import { renderNotFoundPage } from "../replay/not-found.js";
import { handleCdxQuery } from "../replay/cdx-api.js";
import { sha1Base32, waybackDigestOf } from "../lib/digest.js";
import { LruCache } from "../lib/lru.js";
import { isNavigationRequest } from "../replay/navigation.js";
import { parseByteRange } from "../replay/byte-range.js";
import {
  createReplayRenderer,
  type RenderedResponse,
} from "../replay/render.js";

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
  const renderReplay = createReplayRenderer(wacz, pipeline);

  // The CDX route filters this list on every request. `wacz.entries` copies the
  // array, and a copy of a few hundred thousand entries per query is pure
  // garbage, so take it once: the archive is immutable for the life of the
  // server, and the entries never change under it.
  const archiveEntries: CdxjEntry[] = wacz.entries;

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

  /**
   * The SHA-1 digest the CDX API prints.
   *
   * An index that already stores the SHA-1 digest costs one string parse and
   * no reads. Otherwise the record is read once and its payload hashed; the
   * result is kept so a repeated query (or a page of rows that share a record)
   * does not decompress it again. A record that cannot be read yields null,
   * which the API prints as an empty digest rather than as a SHA-256 value in a
   * SHA-1 column.
   */
  const cdxSha1Cache = new Map<string, string | null>();
  const resolveEntrySha1 = async (entry: CdxjEntry): Promise<string | null> => {
    const direct = waybackDigestOf(entry.digest);
    if (direct) return direct;

    const cacheKey = `${entry.filename}@${entry.offset}`;
    if (cdxSha1Cache.has(cacheKey)) return cdxSha1Cache.get(cacheKey) ?? null;

    let digest: string | null = null;
    try {
      const record = await wacz.recordForEntryAsync(entry);
      digest = sha1Base32(record.body);
    } catch {
      digest = null;
    }
    cdxSha1Cache.set(cacheKey, digest);
    return digest;
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

    // CDX query API, in the Wayback shape: /cdx/search/cdx, and /cdx as an
    // alias. Answers from the WACZ's own CDXJ index; the `digest` column is a
    // bare Base32 SHA-1, recomputed from the record when the index only holds
    // SHA-256.
    if (
      reqUrl === "/cdx" ||
      reqUrl.startsWith("/cdx?") ||
      reqUrl === "/cdx/search/cdx" ||
      reqUrl.startsWith("/cdx/search/cdx?")
    ) {
      const parsedQuery = new URL(reqUrl, "http://localhost");
      const result = await handleCdxQuery(
        archiveEntries,
        parsedQuery.searchParams,
        {
          resolveSha1: resolveEntrySha1,
        },
      );
      res.writeHead(result.status, {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
      });
      res.end(result.body);
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

      // Byte-range support: a replay body is fully materialized in
      // `rendered.body`, so a range request is satisfied by slicing that
      // buffer at zero cost. The full body stays in
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
