import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffCharset } from '../src/cli/server.js';

// The replay server declares a charset for archived HTML that does not carry
// one. The bytes are always served verbatim; only the declaration changes.

test('a <meta> charset wins over the byte heuristic', () => {
    const body = Buffer.from('<html><head><meta charset="windows-1250"></head></html>', 'latin1');
    assert.equal(sniffCharset(body, 'text/html'), 'windows-1250');
});

test('an http-equiv Content-Type meta charset is read too', () => {
    const body = Buffer.from(
        '<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2"></head></html>',
        'latin1',
    );
    assert.equal(sniffCharset(body, 'text/html'), 'iso-8859-2');
});

test('a UTF-8 BOM is declared as UTF-8', () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html><meta charset="windows-1250">')]);
    assert.equal(sniffCharset(body, 'text/html'), 'utf-8');
});

test('legacy single-byte bytes fall back to Windows-1252', () => {
    // 0xAE is the registered-trademark sign in Windows-1252 and is not valid
    // UTF-8, which is the 1996 msn.com case.
    const body = Buffer.concat([Buffer.from('<html><body>Microsoft'), Buffer.from([0xae]), Buffer.from('</body></html>')]);
    assert.equal(sniffCharset(body, 'text/html'), 'windows-1252');
});

test('valid UTF-8 without a meta is declared as UTF-8', () => {
    const body = Buffer.from('<html><body>café</body></html>', 'utf8');
    assert.equal(sniffCharset(body, 'text/html'), 'utf-8');
});

test('plain ASCII without a meta is valid UTF-8', () => {
    assert.equal(sniffCharset(Buffer.from('<html><body>hello</body></html>'), 'text/html'), 'utf-8');
});

test('non-HTML bodies get no charset from this helper', () => {
    assert.equal(sniffCharset(Buffer.from('GIF89a'), 'image/gif'), undefined);
});
