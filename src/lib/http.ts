/**
 * http.ts
 *
 * HTTP fetch helpers shared by the downloader and the Wayback restorer. Both
 * fetch remote resources through Node's `http`/`https` modules with a browser
 * client identity and record the headers actually sent/received, so the
 * defaults and the header-collection routine live here in one place.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { buildWarcRequestRecord } from '../archive/warc-writer.js';

export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';
export const DEFAULT_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8';
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** Client-identity headers sent on every fetch (and recorded in the request
 * record). Each is overridable; the defaults together read as an Edge 150
 * browser. */
export function clientHeaders(userAgent: string, accept: string, acceptLanguage: string): http.OutgoingHttpHeaders {
    return {
        'User-Agent': userAgent,
        'Accept': accept,
        'Accept-Language': acceptLanguage,
    };
}

/** Collect an incoming response's headers as name/value pairs, verbatim. */
export function collectHeaders(h: http.IncomingHttpHeaders): [string, string][] {
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined) continue;
        out.push([k, Array.isArray(v) ? v.join(', ') : v]);
    }
    return out;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the WARC `request` record that documents a URL the crawler/restorer
 * fetched. It records exactly how the resource was asked for: the request line
 * against the URL, plus the `Host` Node derived from that URL and the
 * client-identity headers in `clientHeaders(...)`. `concurrentToId` names the
 * response record this request produced, linking the pair bidirectionally via
 * `WARC-Concurrent-To`.
 */
export function buildRequestRecord(
    url: string,
    concurrentToId: string,
    dateRfc3339: string,
    userAgent: string,
    accept: string,
    acceptLanguage: string,
): Buffer {
    const u = new URL(url);
    const headers: [string, string][] = [['Host', u.host]];
    for (const [k, v] of Object.entries(clientHeaders(userAgent, accept, acceptLanguage))) {
        if (v === undefined) continue;
        headers.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    }
    return buildWarcRequestRecord({
        recordId: `<urn:uuid:${crypto.randomUUID()}>`,
        targetUri: url,
        dateRfc3339,
        concurrentTo: concurrentToId,
        request: {
            method: 'GET',
            path: u.pathname + u.search,
            headers,
        },
    });
}
