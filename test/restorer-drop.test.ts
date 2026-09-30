import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'zlib';
import { surtKey } from '../src/lib/url.js';
import { dropStaleCarried } from '../src/cli/wayback-machine-restorer.js';

// dropStaleCarried removes carried Wayback replay records whose snapshot was
// just restored, splicing their bytes out of the stored WARC and remapping the
// remaining records' offsets. This hand-builds an ExistingArchive out of raw
// gzip members and checks the splice/remap end to end.

function member(buf: Buffer): Buffer {
    return zlib.gzipSync(buf);
}

function idx(url: string, ts: string, offset: number, length: number, mime = 'application/octet-stream'): string {
    return `${surtKey(url)} ${ts} ${JSON.stringify({ url, mime, offset, length, status: 200, filename: 'data.warc.gz' })}`;
}

// A fake ExistingArchive: three members laid end to end.
//  member 0: a restored inner URL (kept)
//  member 1: a carried wayback replay URL (stale -> dropped)
//  member 2: another restored inner URL (kept)
function build(): { existing: Parameters<typeof dropStaleCarried>[0]; warcGz: Buffer; lens: number[] } {
    const m0 = member(Buffer.from('record-A'));
    const m1 = member(Buffer.from('record-wayback-stale'));
    const m2 = member(Buffer.from('record-C'));
    const warcGz = Buffer.concat([m0, m1, m2]);
    const o0 = 0;
    const o1 = m0.length;
    const o2 = m0.length + m1.length;

    const indexLines = [
        idx('http://a.example/x', '19980101120000000', o0, m0.length),
        idx('https://web.archive.org/web/19990101120000id_/http://a.example/x', '20260101120000000', o1, m1.length, 'text/html'),
        idx('http://c.example/y', '20000101120000000', o2, m2.length),
    ];
    const pagesText =
        '{"format":"json-pages-1.0","id":"pages","title":"All Pages"}\n' +
        '{"url":"http://a.example/x","ts":"1998-01-01T12:00:00Z","title":"A"}\n' +
        '{"url":"https://web.archive.org/web/19990101120000id_/http://a.example/x","ts":"2026-01-01T12:00:00Z","title":"stale wayback"}\n' +
        '{"url":"http://c.example/y","ts":"2000-01-01T12:00:00Z","title":"C"}\n';

    const existing = {
        title: 't',
        warcGz,
        indexLines,
        pagesText,
        datapackage: {},
    };
    return { existing, warcGz, lens: [m0.length, m1.length, m2.length] };
}

test('dropStaleCarried splices stale member and remaps offsets', () => {
    const { existing } = build();
    // The stale wayback URL is for inner URL a.example/x at ts 19990101120000.
    const restored = new Set(['http://a.example/x\t19990101120000']);
    const out = dropStaleCarried(existing, restored);

    // Kept members are byte-identical to the originals.
    const kept0 = member(Buffer.from('record-A'));
    const kept2 = member(Buffer.from('record-C'));
    assert.deepEqual(out.warcGz, Buffer.concat([kept0, kept2]));

    // Two index lines remain (the stale one is gone).
    assert.equal(out.indexLines.length, 2);

    // Offsets remapped: record-C shifted down by the stale member's length.
    const lines = out.indexLines.map((l) => JSON.parse(l.split(' ').slice(2).join(' ')));
    const a = lines.find((j) => j.url === 'http://a.example/x')!;
    const c = lines.find((j) => j.url === 'http://c.example/y')!;
    assert.equal(a.offset, 0);
    assert.equal(c.offset, kept0.length); // 0 + len(record-A)
    assert.equal(c.length, kept2.length);
});

test('dropStaleCarried removes stale page entry but keeps others', () => {
    const { existing } = build();
    const restored = new Set(['http://a.example/x\t19990101120000']);
    const out = dropStaleCarried(existing, restored);

    const pages = out.pagesText
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    const urls = pages.map((p) => p.url).filter((u) => typeof u === 'string');
    assert.ok(urls.includes('http://a.example/x'));
    assert.ok(urls.includes('http://c.example/y'));
    assert.ok(!urls.some((u) => u.includes('web.archive.org')));
});

test('dropStaleCarried is a no-op when nothing is stale', () => {
    const { existing, warcGz } = build();
    const out = dropStaleCarried(existing, new Set(['http://unrelated.example\t19990101120000']));
    assert.deepEqual(out.warcGz, warcGz);
    assert.equal(out.indexLines.length, 3);
    assert.equal(out.pagesText, existing.pagesText);
});
