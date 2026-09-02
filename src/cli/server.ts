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
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { Wacz } from '../archive/wacz';
import { WarcRecord } from '../archive/warc';
import { renderIndexPage, buildPageRows } from '../replay/index-page';
import { rfc3339ToTs14 } from '../lib/time';
import { createDefaultPipeline, ReplayContext } from '../replay/plugins';
import { URL_FIXER_SCRIPT_ROUTE } from '../replay/url-fixer';
import { URL_FIXER_SHIM } from '../replay/url-fixer-shim';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
    wacz: string;
    port: number;
    expose: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { wacz: '', port: 8080, expose: false };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') args.port = parseInt(argv[++i] || '8080', 10);
        else if (a.startsWith('--port=')) args.port = parseInt(a.slice('--port='.length), 10);
        else if (a === '--expose') args.expose = true;
        else if (!a.startsWith('--')) positional.push(a);
    }
    if (positional.length > 0) args.wacz = path.resolve(positional[0]);
    if (!args.wacz) {
        console.error('Usage: npx tsx src/cli/server.ts <archive.wacz> [--port 8080] [--expose]');
        process.exit(1);
    }
    return args;
}

function getLocalExternalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const dev in interfaces) {
        const iface = interfaces[dev]!;
        for (const alias of iface) {
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

// ---------------------------------------------------------------------------
// Serving helpers
// ---------------------------------------------------------------------------

const TEXT_HTML = /text\/html/i;

function sniffCharset(head: Buffer, mime: string): string | undefined {
    if (!TEXT_HTML.test(mime)) return undefined;
    const s = head.subarray(0, 8192).toString('latin1');
    const meta = s.match(/<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9\-_]+)/i);
    return meta ? meta[1] : undefined;
}

/**
 * Framing + hop-by-hop headers (RFC 7230 section 6.1) that Node's HTTP layer owns and
 * that can't be replayed verbatim -- the body has been decompressed and
 * rewritten, so the original `content-length`/`content-encoding` no longer
 * match. Keyed lowercase -> canonical name. When we strip one we emit its
 * original value under `X-Archive-Orig-<Name>` (below), so the archived value
 * stays inspectable.
 */
const STRIP_HEADERS: Record<string, string> = {
    connection: 'Connection',
    'keep-alive': 'Keep-Alive',
    'proxy-authenticate': 'Proxy-Authenticate',
    'proxy-authorization': 'Proxy-Authorization',
    te: 'TE',
    trailer: 'Trailer',
    'transfer-encoding': 'Transfer-Encoding',
    upgrade: 'Upgrade',
    'content-length': 'Content-Length',
    'content-encoding': 'Content-Encoding',
};

/** Prefix for the original value of any header we had to change during replay.
 * This is the shared pywb / archiveweb.page convention (`X-Archive-Orig-*`). */
const ARCHIVE_PREFIX = 'X-Archive-Orig-';

/**
 * Rebuild a replay's response headers, keeping every archived HTTP header
 * except the ones that *must* change:
 *
 *   - framing/hop-by-hop headers (above) are dropped -- the body has been
 *     decompressed and rewritten, so the originals would be wrong. Their
 *     original values are preserved under `X-Archive-Orig-<Name>`.
 *   - `location` is rewritten to a captive `/web/<ts>/<url>` route so a
 *     redirect resolves locally instead of leaking to the live web;
 *   - `set-cookie` is dropped so historical cookies are never injected into
 *     the visitor's browser.
 *
 * `content-type` keeps its archived value (falling back to the CDXJ mime); a
 * charset is appended only when the type is HTML and the archived header lacks
 * one. `content-length` is always recomputed from the rewritten body.
 */
function buildReplayHeaders(
    record: WarcRecord,
    url: string,
    ts: string,
    mime: string,
    body: Buffer,
    status: number,
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of record.httpHeaders) {
        const lower = name.toLowerCase();
        const canonical = STRIP_HEADERS[lower];
        if (canonical) {
            headers[ARCHIVE_PREFIX + canonical] = value;
            continue;
        }
        if (lower === 'set-cookie' || lower === 'location') continue;
        headers[name] = value;
    }

    const loc = record.httpHeaders.get('location');
    if (loc) {
        let target = loc;
        try {
            target = new URL(loc, url).href;
        } catch {
            /* keep the raw value */
        }
        headers['location'] = `/web/${ts}/${target}`;
    }

    let contentType = headers['content-type'] || mime;
    const charset = sniffCharset(body, contentType);
    if (charset && !/charset=/i.test(contentType)) {
        contentType += `; charset=${charset}`;
    } else if (TEXT_HTML.test(contentType) && !/charset=/i.test(contentType)) {
        contentType += '; charset=utf-8';
    }
    headers['content-type'] = contentType;

    // Bodyless responses (204/304/1xx) must not carry a Content-Length
    // (RFC 7230 section 3.3.2); we end those without a body below.
    const bodyless = status === 204 || status === 304 || (status >= 100 && status < 200);
    if (!bodyless) headers['content-length'] = String(body.length);
    return headers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const wacz = new Wacz(args.wacz);
    const pipeline = createDefaultPipeline();

    const host = args.expose ? '0.0.0.0' : '127.0.0.1';

    // The index page lists the archive's *pages* (from pages.jsonl), not every
    // captured resource. Each entry points at a /web/<ts>/<url> replay route.
    const buildIndexPage = (): string => {
        const rows = buildPageRows(wacz.pages, (url, ts) => `/web/${rfc3339ToTs14(ts)}/${url}`);
        return renderIndexPage(wacz.title, rows, ['Page', 'Timestamp', 'Original URL']);
    };

    const server = http.createServer((req, res) => {
        const reqUrl = req.url || '/';

        // The url-fixer runtime shim, served as an external script. Injected
        // into every HTML page by the url-fixer plugin via a <script src> that
        // points here; serving it from a stable, cacheable route (rather than
        // inlining it per page) mirrors how Wayback serves wombat.js.
        if (reqUrl === URL_FIXER_SCRIPT_ROUTE) {
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache',
            });
            res.end(URL_FIXER_SHIM);
            return;
        }

        // Index page -- generated on demand from the archive.
        if (reqUrl === '/' || reqUrl === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildIndexPage());
            return;
        }

        // Replay route: /web/<timestamp>/<url>
        const m = reqUrl.match(/^\/web\/(\d{4,14})\/(.+)$/);
        if (m) {
            const reqTs = m[1];
            let rawUrl = m[2];
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
                rawUrl = 'http://' + rawUrl.replace(/^(https?|ftp)\//, '');
            }

            // Resolve the raw (still percent-encoded) URL first. Decoding the
            // whole URL up front is wrong: a percent-encoded reserved character
            // in a query value (e.g. `%23` = `#` inside a color parameter)
            // becomes a literal `#`, which lookupKey then treats as a fragment
            // separator and strips -- making the lookup miss entries the archive
            // stores with the encoded form. Only fall back to a decoded form
            // when the raw URL genuinely misses (e.g. non-ASCII characters the
            // client percent-encoded).
            let rec = wacz.resolveRecord(rawUrl, reqTs);
            if (!rec) {
                let decoded: string;
                try {
                    decoded = decodeURIComponent(rawUrl);
                } catch {
                    decoded = rawUrl;
                }
                if (decoded !== rawUrl) rec = wacz.resolveRecord(decoded, reqTs);
            }
            if (!rec) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }

            const record = rec.record;
            const mime = record.httpHeaders.get('content-type') || rec.entry.mime || 'application/octet-stream';

            // Run the response through the plugin pipeline: static rewriting
            // plus the url-fixer shim injection. Non-text bodies pass through
            // unchanged because neither plugin matches them.
            const ctx: ReplayContext = {
                url: rec.matchedUrl,
                ts: rec.entry.timestamp.slice(0, 14),
                mime,
                body: record.body,
                mode: 'server',
            };
            const body = pipeline.apply(ctx);

            // Replay the archived status and headers, modifying only the few
            // that would otherwise corrupt rendering or leak to the live web.
            const status = record.httpStatus ?? 200;
            const headers = buildReplayHeaders(record, rec.matchedUrl, ctx.ts, mime, body, status);
            res.writeHead(status, record.httpStatusText || undefined, headers);
            if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
                res.end();
            } else {
                res.end(body);
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    });

    server.listen(args.port, host, () => {
        console.log(`\n=== WACZ Replay Server ===`);
        console.log(`- Local Access: http://localhost:${args.port}`);
        if (args.expose) {
            console.log(`- LAN Access:   http://${getLocalExternalIP()}:${args.port}`);
        }
        console.log(`- Archive:      ${args.wacz} (${wacz.title})`);
        console.log(`- Index:        http://localhost:${args.port}/`);
        console.log('\nReady.');
    });
}

main();
