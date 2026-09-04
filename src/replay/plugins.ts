/**
 * plugins.ts
 *
 * The replay response pipeline. A plugin intercepts a response body as it is
 * about to leave the server (or be written by the export tool), optionally
 * transforms it, and releases it. Plugins are composed in order:
 *
 *   1. static-rewrite -- byte-level URL rewriting of HTML/CSS/JS text.
 *   2. url-fixer      -- injects the client-side runtime shim into HTML pages.
 *
 * This is the seam the user described: "intercept the page the tool wants to
 * write, inject the script, then release it". Both the replay server and the
 * export-to-html tool drive the same pipeline, differing only in `mode`
 * (server rewrites to /web/ routes; flat rewrites to exported file names).
 */

import { rewriteContent, detectContentKind, UrlRewriter } from './rewrite.js';
import { lookupKey, lookupPathKey, lookupKeyCi } from '../lib/url.js';
import { createUrlFixerPlugin } from './url-fixer.js';

export interface ReplayContext {
    /** Original URL of this resource -- the base for resolving relative refs. */
    url: string;
    /** 14-digit timestamp (YYYYMMDDHHMMSS) used to build /web/<ts>/ routes. */
    ts: string;
    /** The resource's content type (may include parameters). */
    mime: string;
    /** The raw body bytes. */
    body: Buffer;
    /** Replay mode: 'server' (captive /web/ routes) or 'flat' (exported files). */
    mode: 'server' | 'flat';
    /** Flat mode only: lookupKey(url) -> exported file name. */
    flatMap?: Map<string, string>;
    /** Flat mode only: lookupPathKey(url) -> exported file name (query ignored). */
    flatPathMap?: Map<string, string>;
    /** Flat mode only: lookupKeyCi(url) -> exported file name (case-insensitive). */
    flatCiMap?: Map<string, string>;
}

export interface ResponsePlugin {
    name: string;
    matches(ctx: ReplayContext): boolean;
    transform(ctx: ReplayContext): Buffer;
}

export class PluginPipeline {
    constructor(private plugins: ResponsePlugin[]) {}

    apply(ctx: ReplayContext): Buffer {
        let body = ctx.body;
        for (const plugin of this.plugins) {
            const c: ReplayContext = { ...ctx, body };
            if (plugin.matches(c)) body = plugin.transform(c);
        }
        return body;
    }
}

// ---------------------------------------------------------------------------
// Plugin 1: static byte-level rewriting
// ---------------------------------------------------------------------------

/** File name the flat exporter writes for its "not saved" page. */
export const FLAT_NOT_FOUND_FILE = '404.html';

/** Build a flat-mode link to the local "not saved" page for an unsaved URL.
 * The original URL is passed (percent-encoded) so the page can show it. */
function flatNotFoundLink(url: string): string {
    const hashIdx = url.indexOf('#');
    const clean = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    return `${FLAT_NOT_FOUND_FILE}?url=${encodeURIComponent(clean)}`;
}

export function createStaticRewritePlugin(): ResponsePlugin {
    return {
        name: 'static-rewrite',
        matches: (ctx) => detectContentKind(ctx.mime) !== null,
        transform: (ctx) => {
            const kind = detectContentKind(ctx.mime)!;
            const rewriter: UrlRewriter = (abs) => {
                if (ctx.mode === 'flat') {
                    // Exact match first (lookupKey covers scheme/www/`?&` variants).
                    const exact = ctx.flatMap ? ctx.flatMap.get(lookupKey(abs)) : undefined;
                    if (exact) return exact;
                    // Query-variant fallback: same scheme/host/port/path, any
                    // query. Covers cache-busting params (theme.css?v=1 vs v=2)
                    // where the crawler stored one variant and the page
                    // references another.
                    const byPath = ctx.flatPathMap ? ctx.flatPathMap.get(lookupPathKey(abs)) : undefined;
                    if (byPath) return byPath;
                    // Case-insensitive fallback (last resort): the page
                    // references a path in a different case than the crawler
                    // stored (legacy case-insensitive servers, e.g. old IIS).
                    const byCi = ctx.flatCiMap ? ctx.flatCiMap.get(lookupKeyCi(abs)) : undefined;
                    if (byCi) return byCi;
                    // Not saved: point at the local 404 page, carrying the
                    // original URL so it can be shown. Captive -- nothing leaks
                    // to the live web.
                    return flatNotFoundLink(abs);
                }
                // Server mode is captive: rewrite *every* absolute URL to a
                // local /web/ route. Archived URLs resolve; the rest 404 locally
                // rather than leaking to the live web.
                return `/web/${ctx.ts}/${abs}`;
            };
            const text = ctx.body.toString('latin1');
            return Buffer.from(rewriteContent(text, ctx.url, rewriter, kind), 'latin1');
        },
    };
}

// ---------------------------------------------------------------------------
// Default pipeline
// ---------------------------------------------------------------------------

export function createDefaultPipeline(): PluginPipeline {
    return new PluginPipeline([createStaticRewritePlugin(), createUrlFixerPlugin()]);
}

/**
 * The export-to-html pipeline: static byte-level rewriting only.
 *
 * The url-fixer runtime shim is deliberately omitted here. Under `file://`
 * there is no server, and modern dynamic JavaScript cannot be replayed
 * reliably without one, so we rewrite only the plainly-visible URL references
 * (href/src/srcset attributes, JS import declarations, CSS import/@import) to
 * their flat file names. That is enough for old, mostly-static pages.
 */
export function createExportPipeline(): PluginPipeline {
    return new PluginPipeline([createStaticRewritePlugin()]);
}
