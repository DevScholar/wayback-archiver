import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteContent, detectContentKind } from '../src/replay/rewrite.js';

const rewrite = (abs: string) => `/web/2026/${abs}`;

test('rewriteContent rewrites HTML href/src/srcset', () => {
    const html = '<a href="/a.html">A</a><img src="/img.png"><img srcset="/a.png 1x, /b.png 2x">';
    const out = rewriteContent(html, 'http://example.com/', rewrite, 'html');
    assert.ok(out.includes('href="/web/2026/http://example.com/a.html"'));
    assert.ok(out.includes('src="/web/2026/http://example.com/img.png"'));
    assert.ok(out.includes('/web/2026/http://example.com/a.png 1x'));
    assert.ok(out.includes('/web/2026/http://example.com/b.png 2x'));
});

test('rewriteContent preserves fragment in href', () => {
    const html = '<a href="/a.html#sec">A</a>';
    const out = rewriteContent(html, 'http://example.com/', rewrite, 'html');
    assert.ok(out.includes('/web/2026/http://example.com/a.html#sec'));
});

test('rewriteContent skips javascript/data/mailto URLs', () => {
    const html = '<a href="javascript:void(0)">x</a><img src="data:image/png;base64,AAA">';
    const out = rewriteContent(html, 'http://example.com/', rewrite, 'html');
    assert.ok(out.includes('href="javascript:void(0)"'));
    assert.ok(out.includes('src="data:image/png;base64,AAA"'));
});

test('rewriteContent rewrites CSS url() and @import', () => {
    const css = 'body { background: url("/bg.png"); }\n@import "/extra.css";';
    const out = rewriteContent(css, 'http://example.com/', rewrite, 'css');
    assert.ok(out.includes('url(/web/2026/http://example.com/bg.png)'));
    assert.ok(out.includes('@import "/web/2026/http://example.com/extra.css";'));
});

test('rewriteContent rewrites JS import specifiers but not bare names', () => {
    const js = 'import x from "./a.js"; import("./b.js"); const s = "from nowhere";';
    const out = rewriteContent(js, 'http://example.com/', rewrite, 'js');
    assert.ok(out.includes('from "/web/2026/http://example.com/a.js"'));
    assert.ok(out.includes('import("/web/2026/http://example.com/b.js")'));
    // bare string "from" untouched
    assert.ok(out.includes('"from nowhere"'));
});

test('rewriteContent handles comma in srcset query string', () => {
    const html = '<img srcset="/img?op_usm=1.5,0.65 1x, /img2.png 2x">';
    const out = rewriteContent(html, 'http://example.com/', rewrite, 'html');
    // the comma inside the query must not split the candidate
    assert.ok(out.includes('/web/2026/http://example.com/img?op_usm=1.5,0.65 1x'));
    assert.ok(out.includes('/web/2026/http://example.com/img2.png 2x'));
});

test('detectContentKind classifies by mime not extension', () => {
    assert.equal(detectContentKind('text/html'), 'html');
    assert.equal(detectContentKind('text/css; charset=utf-8'), 'css');
    assert.equal(detectContentKind('application/javascript'), 'js');
    assert.equal(detectContentKind('image/png'), null);
    assert.equal(detectContentKind(''), null);
});
