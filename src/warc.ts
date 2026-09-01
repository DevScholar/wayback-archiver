/**
 * warc.ts
 *
 * Parses a single decompressed WARC record into its headers and HTTP payload.
 * A WARC record looks like:
 *
 *   WARC/1.1\r\n
 *   WARC-Type: response\r\n
 *   ...\r\n
 *   Content-Length: N\r\n
 *   \r\n
 *   HTTP/1.1 200 OK\r\n
 *   <http headers>\r\n
 *   \r\n
 *   <body bytes>
 */

export interface WarcRecord {
    warcType: string;
    /** WARC headers, keyed by lowercased name. */
    headers: Map<string, string>;
    targetUri: string | null;
    /** RFC3339 timestamp from WARC-Date, if present. */
    date: string | null;
    contentType: string | null;
    /** HTTP status line code (200, 404, …), or null if not an HTTP message. */
    httpStatus: number | null;
    /** HTTP status reason phrase ("OK", "Not Found", …), or '' if absent. */
    httpStatusText: string;
    /** HTTP response headers, keyed by lowercased name. */
    httpHeaders: Map<string, string>;
    /** HTTP response body bytes. */
    body: Buffer;
}

/** Locate the blank line that ends a header block. Returns the offset of the
 * terminator and its length (4 for CRLF CRLF, 2 for LF LF), so the caller can
 * skip it completely — the block body starts right after it. */
function findHeaderEnd(buf: Buffer): { index: number; termLen: number } {
    // CRLF CRLF (the standard case)
    for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
            return { index: i, termLen: 4 };
        }
    }
    // LF LF fallback
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return { index: i, termLen: 2 };
    }
    return { index: -1, termLen: 0 };
}

function parseHeaders(text: string, startLine: number): Map<string, string> {
    const map = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    for (let i = startLine; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx <= 0) continue;
        map.set(lines[i].slice(0, idx).trim().toLowerCase(), lines[i].slice(idx + 1).trim());
    }
    return map;
}

export function parseWarcRecord(raw: Buffer): WarcRecord {
    const sep = findHeaderEnd(raw);
    const headerText = raw.subarray(0, sep.index >= 0 ? sep.index : 0).toString('utf8');

    const headers = parseHeaders(headerText, 1);
    const warcType = headers.get('warc-type') || 'unknown';
    const contentType = headers.get('content-type') || null;
    const targetUri = headers.get('warc-target-uri') || null;
    const date = headers.get('warc-date') || null;

    let block = sep.index >= 0 ? raw.subarray(sep.index + sep.termLen) : Buffer.alloc(0);

    // The WARC `Content-Length` header is the exact octet length of the record
    // block — for a `response` record, the HTTP message (status line + HTTP
    // headers + blank line + body). Prefer it over heuristics: it delimits the
    // body precisely, including binary payloads that happen to end in CRLFCRLF.
    const clHeader = headers.get('content-length');
    const contentLen = clHeader !== undefined ? Number(clHeader) : NaN;
    const trusted = Number.isFinite(contentLen) && contentLen >= 0 && contentLen <= block.length;
    if (trusted) block = block.subarray(0, contentLen);

    let httpStatus: number | null = null;
    let httpStatusText = '';
    let httpHeaders = new Map<string, string>();
    let body = block;

    // Only parse the block as HTTP when it actually starts with a status line.
    // Non-HTTP blocks (e.g. urn:thumbnail placeholders, metadata records) have
    // no status line and must pass through untouched.
    const httpSep = findHeaderEnd(block);
    if (httpSep.index >= 0 && block.subarray(0, 5).toString('latin1') === 'HTTP/') {
        const httpHead = block.subarray(0, httpSep.index).toString('utf8');
        const statusMatch = httpHead.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?/);
        if (statusMatch) {
            httpStatus = parseInt(statusMatch[1], 10);
            httpStatusText = (statusMatch[2] || '').trim();
        }
        httpHeaders = parseHeaders(httpHead, 1);
        body = block.subarray(httpSep.index + httpSep.termLen);
    }

    // Fallback only, when the WARC record lacked a usable Content-Length:
    // wabac.js / archiveweb.page delimit the HTTP entity body with a trailing
    // CRLFCRLF that is not part of the payload (per WARC 1.1, a response
    // record's payload is its entity-body — RFC 2616 — which is exactly the
    // content-length bytes and matches warc-payload-digest). Strip it so binary
    // resources (images, fonts, …) decode cleanly.
    if (!trusted && httpStatus !== null && body.length >= 4 &&
        body[body.length - 4] === 0x0d && body[body.length - 3] === 0x0a &&
        body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 4);
    }

    return { warcType, headers, targetUri, date, contentType, httpStatus, httpStatusText, httpHeaders, body };
}
