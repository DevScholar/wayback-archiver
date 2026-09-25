import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeZipFile } from '../src/archive/zip-writer.js';
import { ZipReader } from '../src/archive/zip.js';

function tmpFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacz-test-'));
    return path.join(dir, 'test.wacz');
}

test('writeZipFile round-trips store and deflate entries through ZipReader', () => {
    const file = tmpFile();
    const deflateData = Buffer.from(JSON.stringify({ title: 'My Archive' }));
    const storeData = Buffer.from('stored payload bytes');
    writeZipFile(file, [
        { name: 'datapackage.json', data: deflateData, method: 'deflate' },
        { name: 'archive/data.warc.gz', data: storeData, method: 'store' },
    ]);

    const z = ZipReader.open(file);
    assert.deepEqual(z.names().sort(), ['archive/data.warc.gz', 'datapackage.json']);
    assert.deepEqual(z.readEntry('datapackage.json'), deflateData);
    assert.deepEqual(z.readEntry('archive/data.warc.gz'), storeData);
    z.close();
});

test('storedRange reads a byte range of a STORE entry without decompression', () => {
    const file = tmpFile();
    const data = Buffer.from('0123456789abcdef');
    writeZipFile(file, [{ name: 'archive/data.warc.gz', data, method: 'store' }]);

    const z = ZipReader.open(file);
    assert.equal(z.storedRange('archive/data.warc.gz', 4, 6).toString(), '456789');
    z.close();
});

test('storedRange rejects a non-STORE entry', () => {
    const file = tmpFile();
    writeZipFile(file, [{ name: 'x.txt', data: Buffer.from('hello'), method: 'deflate' }]);
    const z = ZipReader.open(file);
    assert.throws(() => z.storedRange('x.txt', 0, 5), /requires a STORE entry/);
    z.close();
});

test('ZipReader throws on a non-ZIP file', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'this is not a zip file');
    assert.throws(() => ZipReader.open(file), /End Of Central Directory/);
});

test('readEntry throws for a missing entry', () => {
    const file = tmpFile();
    writeZipFile(file, [{ name: 'a.txt', data: Buffer.from('a') }]);
    const z = ZipReader.open(file);
    assert.throws(() => z.readEntry('missing.txt'), /Entry not found/);
    z.close();
});

test('storedRangeAsync reads off the event loop', async () => {
    const file = tmpFile();
    const data = Buffer.from('abcdefghij');
    writeZipFile(file, [{ name: 'archive/data.warc.gz', data, method: 'store' }]);
    const z = ZipReader.open(file);
    const buf = await z.storedRangeAsync('archive/data.warc.gz', 2, 5);
    assert.equal(buf.toString(), 'cdefg');
    z.close();
});
