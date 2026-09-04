/**
 * warc-writer.ts
 *
 * Serializes a fetched HTTP response into a WARC 1.1 `response` record,
 * byte-compatible with what warcio.js / archiveweb.page write:
 *
 *   WARC/1.1\r\n
 *   WARC-Record-ID: <urn:uuid:...>\r\n
 *   WARC-Target-URI: <url>\r\n
 *   WARC-Date: <RFC3339>\r\n
 *   WARC-Type: response\r\n
 *   Content-Type: application/http; msgtype=response\r\n
 *   WARC-Payload-Digest: sha256:<hex>\r\n
 *   WARC-Block-Digest: sha256:<hex>\r\n
 *   Content-Length: N\r\n
 *   \r\n
 *   HTTP/1.1 <status> <reason>\r\n
 *   <http headers>\r\n
 *   \r\n
 *   <body bytes>
 *   \r\n\r\n
 *
 * `Content-Length` is the HTTP message length (status line + headers + blank
 * line + body), NOT the WARC header block, and NOT the trailing CRLFCRLF that
 * archiveweb.page uses to delimit the entity body. The reader in warc.ts strips
 * that trailing CRLFCRLF; writing it here keeps our output interoperable.
 */

import * as crypto from 'crypto';

export interface HttpResponse {
    status: number;
    statusText: string;
    /** Header name/value pairs, case preserved, as received from the server. */
    headers: [string, string][];
    body: Buffer;
}

/** Serialize one response as a full (uncompressed) WARC record. */
export function buildWarcRecord(opts: {
    recordId: string;
    targetUri: string;
    dateRfc3339: string;
    response: HttpResponse;
    /**
     * The crawler's best guess at the payload's MIME type and charset (the WARC
     * `WARC-Identified-Payload-Type` header, e.g. `text/html; charset=windows-1252`),
     * when known. Distinct from the HTTP `Content-Type`: that header records what
     * the server actually sent, while this one records how the payload bytes
     * should be decoded -- essential for legacy bodies (e.g. Windows-1252) whose
     * server never declared a charset. Omit to write no such header.
     */
    identifiedPayloadType?: string;
}): Buffer {
    const { recordId, targetUri, dateRfc3339, response } = opts;

    const statusLine =
        `HTTP/1.1 ${response.status}` + (response.statusText ? ` ${response.statusText}` : '');
    const httpHead =
        statusLine +
        '\r\n' +
        response.headers.map(([n, v]) => `${n}: ${v}\r\n`).join('') +
        '\r\n';

    const httpMessage = Buffer.concat([Buffer.from(httpHead, 'latin1'), response.body]);

    const payloadDigest = crypto.createHash('sha256').update(response.body).digest('hex');
    const blockDigest = crypto.createHash('sha256').update(httpMessage).digest('hex');

    const identifiedType = opts.identifiedPayloadType
        ? `WARC-Identified-Payload-Type: ${opts.identifiedPayloadType}\r\n`
        : '';

    const warcHead =
        'WARC/1.1\r\n' +
        `WARC-Record-ID: ${recordId}\r\n` +
        `WARC-Target-URI: ${targetUri}\r\n` +
        `WARC-Date: ${dateRfc3339}\r\n` +
        'WARC-Type: response\r\n' +
        identifiedType +
        'Content-Type: application/http; msgtype=response\r\n' +
        `WARC-Payload-Digest: sha256:${payloadDigest}\r\n` +
        `WARC-Block-Digest: sha256:${blockDigest}\r\n` +
        `Content-Length: ${httpMessage.length}\r\n`;

    return Buffer.concat([
        Buffer.from(warcHead, 'latin1'),
        Buffer.from('\r\n', 'latin1'),
        httpMessage,
        Buffer.from('\r\n\r\n', 'latin1'),
    ]);
}

/** CDXJ `digest` field: `sha-256:<hex of the HTTP payload>` (note the dash). */
export function payloadDigest(body: Buffer): string {
    return 'sha-256:' + crypto.createHash('sha256').update(body).digest('hex');
}
