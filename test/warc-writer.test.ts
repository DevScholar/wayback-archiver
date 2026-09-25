import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildWarcRecord,
    buildWarcRequestRecord,
    buildWarcinfoRecord,
    payloadDigest,
} from '../src/archive/warc-writer.js';
import { parseWarcRecord } from '../src/archive/warc.js';

test('payloadDigest uses sha-256 dash form', () => {
    const d = payloadDigest(Buffer.from('abc'));
    assert.ok(d.startsWith('sha-256:'));
    assert.equal(d.length, 'sha-256:'.length + 64);
});

test('buildWarcRecord writes both block and payload digests', () => {
    const body = Buffer.from('payload');
    const rec = buildWarcRecord({
        recordId: '<urn:uuid:1>',
        targetUri: 'http://example.com/',
        dateRfc3339: '2026-08-31T07:48:47Z',
        response: { status: 200, statusText: 'OK', headers: [], body },
    });
    const text = rec.toString('utf8');
    assert.ok(text.includes('WARC-Payload-Digest: sha256:'));
    assert.ok(text.includes('WARC-Block-Digest: sha256:'));
    assert.ok(text.includes('Content-Type: application/http; msgtype=response'));
});

test('buildWarcRecord omits identified payload type when absent', () => {
    const rec = buildWarcRecord({
        recordId: '<urn:uuid:1>',
        targetUri: 'http://example.com/',
        dateRfc3339: '2026-08-31T07:48:47Z',
        response: { status: 200, statusText: 'OK', headers: [], body: Buffer.from('x') },
    });
    assert.ok(!rec.toString('utf8').includes('WARC-Identified-Payload-Type'));
});

test('buildWarcRequestRecord records method and path, has no payload digest', () => {
    const rec = buildWarcRequestRecord({
        recordId: '<urn:uuid:2>',
        targetUri: 'http://example.com/a',
        dateRfc3339: '2026-08-31T07:48:47Z',
        concurrentTo: '<urn:uuid:1>',
        request: { method: 'GET', path: '/a?b=1', headers: [['Host', 'example.com']] },
    });
    const text = rec.toString('utf8');
    assert.ok(text.includes('WARC-Type: request'));
    assert.ok(text.includes('GET /a?b=1 HTTP/1.1'));
    assert.ok(text.includes('WARC-Concurrent-To: <urn:uuid:1>'));
    assert.ok(!text.includes('WARC-Payload-Digest'));
});

test('buildWarcinfoRecord has no target URI, carries software field', () => {
    const rec = buildWarcinfoRecord({
        recordId: '<urn:uuid:3>',
        dateRfc3339: '2026-08-31T07:48:47Z',
        warcFilename: 'x.wacz#/archive/data.warc.gz',
        software: 'WaybackArchiver/1.0.0',
        isPartOf: 'My Archive',
    });
    const text = rec.toString('utf8');
    assert.ok(text.includes('WARC-Type: warcinfo'));
    assert.ok(text.includes('software: WaybackArchiver/1.0.0'));
    assert.ok(text.includes('isPartOf: My Archive'));
    assert.ok(!text.includes('WARC-Target-URI'));
});

test('buildWarcRecord omits optional identified payload type', () => {
    const body = Buffer.from('x');
    const rec = buildWarcRecord({
        recordId: '<urn:uuid:1>',
        targetUri: 'http://example.com/',
        dateRfc3339: '2026-08-31T07:48:47Z',
        response: { status: 200, statusText: 'OK', headers: [], body },
        identifiedPayloadType: 'text/html; charset=windows-1252',
    });
    const text = rec.toString('utf8');
    assert.ok(text.includes('WARC-Identified-Payload-Type: text/html; charset=windows-1252'));
    // and the parser surfaces it back through the WARC headers map
    const parsed = parseWarcRecord(rec);
    assert.equal(parsed.headers.get('warc-identified-payload-type'), 'text/html; charset=windows-1252');
});
