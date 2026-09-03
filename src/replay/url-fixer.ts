/**
 * url-fixer.ts
 *
 * The url-fixer plugin. It matches HTML responses and injects, immediately
 * after the <head> tag (or at the top of the document), two things:
 *
 *   1. an inline `<script>` holding the per-page configuration
 *      (`window.__urlFixerConfig`), and
 *   2. a `<script src="/__url-fixer.js">` that loads the url-fixer runtime
 *      shim as an *external* script served by the replay server (see
 *      url-fixer-shim.ts) -- mirroring how the Wayback Machine injects
 *      wombat.js rather than inlining it.
 *
 * The injection is wrapped in `<!-- BEGIN/END URL FIXER INSERT -->` comment
 * markers and puts each tag on its own line, the same way Wayback bounds its
 * own toolbar insertion. The shim must run before any page script so its
 * URL-producing-API patches are in place before the page makes its first
 * request.
 *
 * In flat mode the plugin is not used (see createExportPipeline); the config
 * map would be inlined there, but there is no server to serve the external
 * shim under file://.
 */

import type { ResponsePlugin } from './plugins.js';

/** Route the replay server serves the url-fixer runtime shim from. Kept in one
 * place so the plugin's `<script src>` and the server's route stay in sync. */
export const URL_FIXER_SCRIPT_ROUTE = '/__url-fixer.js';

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

            // One tag per line, bounded by comment markers, mirroring Wayback's
            // toolbar-insert convention.
            const injection = [
                '<!-- BEGIN URL FIXER INSERT -->',
                `<script>window.__urlFixerConfig=${JSON.stringify(config)};</script>`,
                `<script src="${URL_FIXER_SCRIPT_ROUTE}"></script>`,
                '<!-- END URL FIXER INSERT -->',
            ].join('\n');

            const html = ctx.body.toString('latin1');
            const head = /<head[^>]*>/i.exec(html);
            let out: string;
            if (head) {
                const idx = head.index + head[0].length;
                out = html.slice(0, idx) + '\n' + injection + html.slice(idx);
            } else {
                out = injection + '\n' + html;
            }
            return Buffer.from(out, 'latin1');
        },
    };
}
