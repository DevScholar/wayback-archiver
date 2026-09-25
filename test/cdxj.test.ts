import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCdxj } from '../src/archive/cdxj.js';

test('parses a single entry', () => {
    const line = 'org,example)/ 20260831074847556 {"url":"http://example.com/","mime":"text/html","offset":0,"length":100,"status":200,"filename":"data.warc.gz","digest":"sha-256:abc"}';
    const [e] = parseCdxj(line);
    assert.equal(e.key, 'org,example)/');
    assert.equal(e.timestamp, '20260831074847556');
    assert.equal(e.url, 'http://example.com/');
    assert.equal(e.mime, 'text/html');
    assert.equal(e.offset, 0);
    assert.equal(e.length, 100);
    assert.equal(e.status, 200);
    assert.equal(e.filename, 'data.warc.gz');
    assert.equal(e.digest, 'sha-256:abc');
});

test('parses multiple lines, skips blank and malformed', () => {
    const text = [
        'org,example)/ 1 {"url":"http://example.com/","offset":0,"length":10}',
        '',
        'not valid json line',
        'org,other)/ 2 {"url":"http://other.com/","offset":10,"length":20}',
    ].join('\n');
    const entries = parseCdxj(text);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].url, 'http://example.com/');
    assert.equal(entries[1].url, 'http://other.com/');
});

test('skips entries missing url or finite offset/length', () => {
    const text = [
        'k1 1 {"url":"","offset":0,"length":10}',
        'k2 2 {"url":"http://x.com/","offset":"bad","length":10}',
        'k3 3 {"url":"http://ok.com/","offset":0,"length":10}',
    ].join('\n');
    const entries = parseCdxj(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].url, 'http://ok.com/');
});
