import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lib/lru.js';

test('get/set basic round-trip', () => {
    const c = new LruCache<string>({ maxEntries: 10, maxBytes: 1000 });
    c.set('a', 'A');
    assert.equal(c.get('a'), 'A');
    assert.equal(c.get('missing'), undefined);
});

test('evicts oldest when exceeding maxEntries', () => {
    const c = new LruCache<string>({ maxEntries: 2, maxBytes: 1000 });
    c.set('a', 'A');
    c.set('b', 'B');
    c.set('c', 'C');
    assert.equal(c.get('a'), undefined);
    assert.equal(c.get('b'), 'B');
    assert.equal(c.get('c'), 'C');
});

test('get refreshes recency', () => {
    const c = new LruCache<string>({ maxEntries: 2, maxBytes: 1000 });
    c.set('a', 'A');
    c.set('b', 'B');
    c.get('a'); // a is now most recent
    c.set('c', 'C');
    assert.equal(c.get('a'), 'A'); // a survived
    assert.equal(c.get('b'), undefined); // b evicted
});

test('evicts by byte budget', () => {
    const c = new LruCache<Buffer>({
        maxEntries: 100,
        maxBytes: 10,
        sizeOf: (b) => b.length,
    });
    c.set('a', Buffer.alloc(6));
    c.set('b', Buffer.alloc(6));
    // 12 > 10, so 'a' evicted
    assert.equal(c.get('a'), undefined);
    assert.equal(c.get('b')!.length, 6);
});

test('refuses entries larger than the per-entry cap', () => {
    const c = new LruCache<Buffer>({
        maxEntries: 10,
        maxBytes: 100,
        maxEntryBytes: 5,
        sizeOf: (b) => b.length,
    });
    c.set('big', Buffer.alloc(20));
    assert.equal(c.get('big'), undefined);
    assert.equal(c.size, 0);
});
