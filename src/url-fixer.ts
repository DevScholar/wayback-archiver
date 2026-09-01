/**
 * url-fixer.ts
 *
 * The url-fixer plugin. It matches HTML responses and injects, immediately
 * after the <head> tag (or at the top of the document), two inline scripts:
 *
 *   1. the shim configuration (window.__urlFixerConfig), and
 *   2. the url-fixer runtime shim itself (see url-fixer-shim.ts).
 *
 * The shim must run before any page script so its URL-producing-API patches
 * are in place before the page makes its first request. In flat mode the
 * config also carries the URL -> file-name map, inlined so it works under
 * file:// where fetch is unavailable.
 */

import type { ResponsePlugin } from './plugins';
import { URL_FIXER_SHIM } from './url-fixer-shim';

export function createUrlFixerPlugin(): ResponsePlugin {
    return {
        name: 'url-fixer',
        matches: (ctx) => /text\/html/i.test(ctx.mime),
        transform: (ctx) => {
            const config: Record<string, unknown> = {
                mode: ctx.mode,
                pageUrl: ctx.url,
                ts: ctx.ts,
            };
            if (ctx.mode === 'flat' && ctx.flatMap) {
                const map: Record<string, string> = {};
                for (const [k, v] of ctx.flatMap) map[k] = v;
                config.flatMap = map;
            }

            const cfgScript = `<script>window.__urlFixerConfig=${JSON.stringify(config)};</script>`;
            const shimScript = `<script>${URL_FIXER_SHIM}</script>`;
            const injection = cfgScript + shimScript;

            const html = ctx.body.toString('latin1');
            const head = /<head[^>]*>/i.exec(html);
            let out: string;
            if (head) {
                const idx = head.index + head[0].length;
                out = html.slice(0, idx) + injection + html.slice(idx);
            } else {
                out = injection + html;
            }
            return Buffer.from(out, 'latin1');
        },
    };
}
