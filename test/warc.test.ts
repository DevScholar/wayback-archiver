import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHeaderEnd, parseWarcRecord } from '../src/archive/warc.js';
import { buildWarcRecord } from '../src/archive/warc-writer.js';

test('findHeaderEnd locates CRLF CRLF', () => {
    const buf = Buffer.from('WARC-Type: response\r\nContent-Length: 0\r\n\r\nbody');
    const { index, termLen } = findHeaderEnd(buf);
    assert.equal(termLen, 4);
    assert.equal(buf.subarray(0, index).toString(), 'WARC-Type: response\r\nContent-Length: 0');
});

test('findHeaderEnd falls back to LF LF', () => {
    const buf = Buffer.from('WARC-Type: response\nContent-Length: 0\n\nbody');
    const { index, termLen } = findHeaderEnd(buf);
    assert.equal(termLen, 2);
    assert.equal(buf.subarray(0, index).toString(), 'WARC-Type: response\nContent-Length: 0');
});

test('findHeaderEnd returns -1 when no blank line', () => {
    const buf = Buffer.from('no blank line here');
    assert.equal(findHeaderEnd(buf).index, -1);
});

test('parseWarcRecord round-trips a response built by the writer', () => {
    const body = Buffer.from('<html>hello</html>');
    const built = buildWarcRecord({
        recordId: '<urn:uuid:123>',
        targetUri: 'http://example.com/',
        dateRfc3339: '2026-08-31T07:48:47Z',
        response: {
            status: 200,
            statusText: 'OK',
            headers: [['Content-Type', 'text/html'], ['Content-Length', String(body.length)]],
            body,
        },
    });
    const rec = parseWarcRecord(built);

    assert.equal(rec.warcType, 'response');
    assert.equal(rec.targetUri, 'http://example.com/');
    assert.equal(rec.date, '2026-08-31T07:48:47Z');
    assert.equal(rec.httpStatus, 200);
    assert.equal(rec.httpStatusText, 'OK');
    assert.equal(rec.httpHeaders.get('content-type'), 'text/html');
    assert.deepEqual(rec.body, body);
});

test('parseWarcRecord handles a body ending in CRLFCRLF via trusted Content-Length', () => {
    // A binary payload that itself ends in CRLFCRLF must not be truncated when
    // the WARC Content-Length delimits it precisely.
    const body = Buffer.from([0x01, 0x02, 0x0d, 0x0a, 0x0d, 0x0a]);
    const built = buildWarcRecord({
        recordId: '<urn:uuid:456>',
        targetUri: 'http://example.com/bin',
        dateRfc3339: '2026-08-31T07:48:47Z',
        response: {
            status: 200,
            statusText: 'OK',
            headers: [['Content-Type', 'application/octet-stream']],
            body,
        },
    });
    const rec = parseWarcRecord(built);
    assert.deepEqual(rec.body, body);
});

test('parseWarcRecord strips trailing CRLFCRLF only when Content-Length is absent', () => {
    // Hand-built WARC with no Content-Length: the entity body is delimited by
    // a trailing CRLFCRLF that is not part of the payload.
    const raw = Buffer.from(
        'WARC/1.1\r\n' +
        'WARC-Type: response\r\n' +
        'WARC-Target-URI: http://example.com/\r\n' +
        'WARC-Date: 2026-08-31T07:48:47Z\r\n' +
        '\r\n' +
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/html\r\n' +
        '\r\n' +
        'hello\r\n\r\n',
    );
    const rec = parseWarcRecord(raw);
    assert.equal(rec.httpStatus, 200);
    assert.equal(rec.body.toString(), 'hello');
});
