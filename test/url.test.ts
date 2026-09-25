import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseUrl,
    assembleUrl,
    lookupKey,
    surtKey,
    lookupPathKey,
    lookupKeyCi,
    lookupVariants,
    candidateUrls,
} from '../src/lib/url.js';

test('surtKey reverses host and strips scheme', () => {
    assert.equal(surtKey('https://www.example.org/index.html'), 'org,example,www)/index.html');
    assert.equal(surtKey('https://noscript.net/theme.css?v=1'), 'net,noscript)/theme.css?v=1');
});

test('surtKey appends non-default port before reversal', () => {
    assert.equal(surtKey('http://example.org:8080/a'), 'org,example:8080)/a');
});

test('surtKey lowercases host via URL parsing', () => {
    assert.equal(surtKey('http://WWW.Example.ORG/x'), 'org,example,www)/x');
});

test('lookupKey lowercases scheme+host, keeps path/query case, drops fragment', () => {
    assert.equal(
        lookupKey('http://WWW.Example.com/Path?X=1#frag'),
        'http://www.example.com/Path?X=1',
    );
});

test('lookupPathKey drops query and fragment', () => {
    assert.equal(lookupPathKey('http://example.com/a/b?q=1#f'), 'http://example.com/a/b');
});

test('lookupKeyCi lowercases path but not query', () => {
    assert.equal(lookupKeyCi('http://Example.com/Foo.JPG?X=1'), 'http://example.com/foo.jpg?X=1');
});

test('lookupVariants yields www and scheme alternates in order', () => {
    assert.deepEqual(lookupVariants('http://example.com/path'), [
        'http://example.com/path',
        'http://www.example.com/path',
        'https://example.com/path',
        'https://www.example.com/path',
    ]);
});

test('lookupVariants strips leading www toward bare host', () => {
    assert.deepEqual(lookupVariants('https://www.example.com/'), [
        'https://www.example.com/',
        'https://example.com/',
        'http://www.example.com/',
        'http://example.com/',
    ]);
});

test('lookupVariants toggles a leading query ampersand', () => {
    const v = lookupVariants('http://example.com/?&x=1');
    assert.ok(v.includes('http://example.com/?x=1'));
});

test('candidateUrls expands directory default documents', () => {
    const cands = candidateUrls('http://example.com/');
    assert.ok(cands.includes('http://example.com/index.html'));
    assert.ok(cands.includes('http://example.com/index.htm'));
    assert.ok(cands.includes('http://example.com/default.asp'));
});

test('candidateUrls appends .html/.htm to extensionless paths', () => {
    const cands = candidateUrls('http://example.com/about');
    assert.ok(cands.includes('http://example.com/about.html'));
    assert.ok(cands.includes('http://example.com/about.htm'));
});

test('parseUrl returns null for unparseable input', () => {
    assert.equal(parseUrl('not a url'), null);
});

test('assembleUrl round-trips through parseUrl', () => {
    const p = parseUrl('https://example.com:8443/a/b?x=1')!;
    assert.equal(assembleUrl(p), 'https://example.com:8443/a/b?x=1');
});
