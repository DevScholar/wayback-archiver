import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ZipReader } from '../src/archive/zip.js';

// A real >4GB archive is impractical to allocate in a unit test, so this
// hand-crafts a small ZIP64 archive: a single STORE entry whose sizes are
// saturated to 0xFFFFFFFF with their real values in the ZIP64 extra field, and
// a ZIP64 EOCD + locator carrying the (small) real central-directory
// size/offset/count. The reader must resolve both the sizes and the EOCD
// through the ZIP64 structures.

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function tmpFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacz-zip64-'));
    return path.join(dir, 'test.wacz');
}

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
}

test('ZipReader resolves sizes and EOCD through ZIP64 structures', () => {
    const payload = Buffer.from('zip64 payload bytes');
    const name = 'archive/data.warc.gz';
    const nameBuf = Buffer.from(name, 'utf8');

    // ZIP64 extra field (ID 0x0001) for the LOCAL header: uncompressed size +
    // compressed size only (the local extra never carries the header offset).
    const localZip64Extra = Buffer.alloc(4 + 16);
    localZip64Extra.writeUInt16LE(0x0001, 0);
    localZip64Extra.writeUInt16LE(16, 2);
    localZip64Extra.writeBigUInt64LE(BigInt(payload.length), 4);
    localZip64Extra.writeBigUInt64LE(BigInt(payload.length), 12);

    // Local header with saturated sizes.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt32LE(crc32(payload), 14);
    local.writeUInt32LE(0xffffffff, 18); // compressed size saturated
    local.writeUInt32LE(0xffffffff, 22); // uncompressed size saturated
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localZip64Extra.length, 28);

    // ZIP64 extra field for the CENTRAL header: uncompressed + compressed sizes
    // + local-header offset (all three saturated slots).
    const cenZip64Extra = Buffer.alloc(4 + 24);
    cenZip64Extra.writeUInt16LE(0x0001, 0);
    cenZip64Extra.writeUInt16LE(24, 2);
    cenZip64Extra.writeBigUInt64LE(BigInt(payload.length), 4); // uncompressed
    cenZip64Extra.writeBigUInt64LE(BigInt(payload.length), 12); // compressed
    cenZip64Extra.writeBigUInt64LE(0n, 20); // local header offset (first entry = 0)

    // Central header: saturated sizes + saturated local-header offset.
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(45, 4);
    cen.writeUInt16LE(45, 6);
    cen.writeUInt16LE(0, 10); // STORE
    cen.writeUInt32LE(crc32(payload), 16);
    cen.writeUInt32LE(0xffffffff, 20); // compressed saturated
    cen.writeUInt32LE(0xffffffff, 24); // uncompressed saturated
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(cenZip64Extra.length, 30);
    cen.writeUInt32LE(0xffffffff, 42); // local header offset saturated

    const cd = Buffer.concat([cen, nameBuf, cenZip64Extra]);
    const cdOffset = local.length + nameBuf.length + localZip64Extra.length + payload.length;
    const cdLength = cd.length;

    // ZIP64 EOCD record (56 bytes) with real count/size/offset.
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(cdLength), 40);
    z64.writeBigUInt64LE(BigInt(cdOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdLength), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);

    const file = tmpFile();
    fs.writeFileSync(file, Buffer.concat([local, nameBuf, localZip64Extra, payload, cd, z64, locator, eocd]));

    const z = ZipReader.open(file);
    assert.deepEqual(z.names(), [name]);
    assert.deepEqual(z.readEntry(name), payload);
    assert.deepEqual(z.storedRange(name, 0, payload.length), payload);
    z.close();
});
