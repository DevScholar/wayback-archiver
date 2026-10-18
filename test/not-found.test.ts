import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotFoundPage } from '../src/replay/not-found.js';

// One plain "not saved" page is shared by the replay server and the flat HTML
// export. It must carry no CSS or styling at all, and must escape the URL it
// shows.

test('not-found page fills in the missing URL without a script', () => {
    const page = renderNotFoundPage('http://example.com/a?b=1&c=<x>');
    assert.match(page, /This URL was not saved in the archive/);
    assert.match(page, /http:\/\/example\.com\/a\?b=1&amp;c=&lt;x&gt;/);
    assert.ok(!page.includes('<script'));
});

test('flat-export not-found page reads the ?url= query parameter', () => {
    const page = renderNotFoundPage();
    assert.match(page, /<script type="text\/javascript">/);
    assert.match(page, /location\.search/);
    assert.match(page, /<p id="url"><\/p>/);
});

test('not-found page has no CSS, no style attribute, no link element', () => {
    for (const page of [renderNotFoundPage(), renderNotFoundPage('http://a.example/')]) {
        assert.doesNotMatch(page, /<style/i);
        assert.doesNotMatch(page, /style\s*=/i);
        assert.doesNotMatch(page, /<link/i);
        assert.doesNotMatch(page, /class\s*=/i);
        assert.match(page, /charset=utf-8/i);
    }
});

test('not-found page escapes an apostrophe and double quote', () => {
    const page = renderNotFoundPage(`http://a.example/'"><`);
    assert.match(page, /&#39;&quot;&gt;&lt;/);
});
