/**
 * zip-writer.ts
 *
 * A minimal ZIP writer -- the counterpart to zip.ts. It emits STORE and DEFLATE
 * entries into a standard ZIP container so the downloader can produce a WACZ
 * file. `archive/*` and `indexes/*.cdx` are written STORE (so they can be read
 * by random byte range, per the WACZ spec), and the small JSON metadata files
 * use DEFLATE.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

const LOC_SIG = 0x04034b50; // local file header
const CEN_SIG = 0x02014b50; // central directory file header
const EOCD_SIG = 0x06054b50; // end of central directory
const ZIP64_EOCD_SIG = 0x06064b50; // ZIP64 end of central directory record
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50; // ZIP64 EOCD locator
const ZIP64_EXTRA_ID = 0x0001; // ZIP64 extended information extra field

// ZIP64 saturation sentinel: a 32-bit field at this value carries its real
// value in the ZIP64 extra field (sizes/offset) or the ZIP64 EOCD (counts,
// central-dir size/offset).
const ZIP32_MAX = 0xffffffff;

// "version needed to extract" for ZIP64 (4.5 per PKWARE APPNOTE).
const VERSION_ZIP64 = 45;
const VERSION_BASE = 20;

/**
 * Build a ZIP64 extra field (ID 0x0001) carrying the given 64-bit values, in
 * the fixed order uncompressed, compressed, local-header offset. Only the
 * fields whose standard 32-bit slot is saturated are included, so `fields`
 * holds exactly the saturated values.
 */
function buildZip64Extra(fields: { uncompressed?: number; compressed?: number; offset?: number }): Buffer {
    const parts: Buffer[] = [];
    if (fields.uncompressed !== undefined) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(fields.uncompressed));
        parts.push(b);
    }
    if (fields.compressed !== undefined) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(fields.compressed));
        parts.push(b);
    }
    if (fields.offset !== undefined) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(fields.offset));
        parts.push(b);
    }
    const data = Buffer.concat(parts);
    const header = Buffer.alloc(4);
    header.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    header.writeUInt16LE(data.length, 2);
    return Buffer.concat([header, data]);
}

// DOS date for the header timestamps: 1980-01-01 (the ZIP epoch minimum).
// The reader ignores these, and pinning them keeps output deterministic.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

export interface ZipWriteEntry {
    /** Path within the ZIP (forward slashes), e.g. "archive/data.warc.gz". */
    name: string;
    data: Buffer;
    /** Compression method. Defaults to deflate; pass 'store' for WARC/index. */
    method?: 'store' | 'deflate';
}

/** Write `entries` into a ZIP file at `filePath`. Emits ZIP64 structures
 * automatically when any entry size or the archive's layout exceeds the 32-bit
 * ZIP limits, so a large STORE entry (a multi-gigabyte `data.warc.gz`) is
 * written correctly rather than silently overflowing its size/offset fields. */
export function writeZipFile(filePath: string, entries: ZipWriteEntry[]): void {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const e of entries) {
        const method = e.method === 'store' ? 0 : 8;
        const crc = crc32(e.data);
        const comp = method === 0 ? e.data : zlib.deflateRawSync(e.data);
        const nameBuf = Buffer.from(e.name, 'utf8');

        const sizeZip64 = e.data.length >= ZIP32_MAX || comp.length >= ZIP32_MAX;
        const localOffset = offset;
        const offsetZip64 = localOffset >= ZIP32_MAX;
        const version = sizeZip64 || offsetZip64 ? VERSION_ZIP64 : VERSION_BASE;

        // Local header ZIP64 extra field: carries uncompressed + compressed
        // sizes only, present when either size saturates its 32-bit slot.
        const localExtra = sizeZip64
            ? buildZip64Extra({ uncompressed: e.data.length, compressed: comp.length })
            : Buffer.alloc(0);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOC_SIG, 0);
        local.writeUInt16LE(version, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(sizeZip64 ? ZIP32_MAX : comp.length, 18);
        local.writeUInt32LE(sizeZip64 ? ZIP32_MAX : e.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(localExtra.length, 28); // extra length

        // Central directory ZIP64 extra field: carries uncompressed + compressed
        // sizes (when saturated) and the local-header offset (when saturated).
        const cenExtra = sizeZip64 || offsetZip64
            ? buildZip64Extra({
                  ...(sizeZip64 ? { uncompressed: e.data.length, compressed: comp.length } : {}),
                  ...(offsetZip64 ? { offset: localOffset } : {}),
              })
            : Buffer.alloc(0);

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(CEN_SIG, 0);
        cen.writeUInt16LE(version, 4); // version made by
        cen.writeUInt16LE(version, 6); // version needed
        cen.writeUInt16LE(0, 8); // flags
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(DOS_TIME, 12);
        cen.writeUInt16LE(DOS_DATE, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(sizeZip64 ? ZIP32_MAX : comp.length, 20);
        cen.writeUInt32LE(sizeZip64 ? ZIP32_MAX : e.data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(cenExtra.length, 30); // extra length
        cen.writeUInt16LE(0, 32); // comment length
        cen.writeUInt16LE(0, 34); // disk number start
        cen.writeUInt16LE(0, 36); // internal attrs
        cen.writeUInt32LE(0, 38); // external attrs
        cen.writeUInt32LE(offsetZip64 ? ZIP32_MAX : localOffset, 42); // local header offset

        chunks.push(local, nameBuf, localExtra, comp);
        central.push(cen, nameBuf, cenExtra);
        offset += 30 + nameBuf.length + localExtra.length + comp.length;
    }

    const cdOffset = offset;
    const cd = Buffer.concat(central);
    const cdLength = cd.length;
    const zip64Eocd = entries.length >= 0xffff || cdLength >= ZIP32_MAX || cdOffset >= ZIP32_MAX;

    let eocd: Buffer;
    if (zip64Eocd) {
        // ZIP64 EOCD record (56 bytes), locator (20 bytes), then the classic
        // EOCD whose count/size/offset fields are saturated. The classic EOCD
        // stays the final record so ZIP32 readers still locate it.
        const z64 = Buffer.alloc(56);
        z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
        z64.writeBigUInt64LE(44n, 4); // size of record, excluding sig + this field
        z64.writeUInt16LE(VERSION_ZIP64, 12); // version made by
        z64.writeUInt16LE(VERSION_ZIP64, 14); // version needed
        z64.writeUInt32LE(0, 16); // disk number
        z64.writeUInt32LE(0, 20); // cd start disk
        z64.writeBigUInt64LE(BigInt(entries.length), 24); // entries on this disk
        z64.writeBigUInt64LE(BigInt(entries.length), 32); // total entries
        z64.writeBigUInt64LE(BigInt(cdLength), 40); // central dir size
        z64.writeBigUInt64LE(BigInt(cdOffset), 48); // central dir offset

        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0);
        locator.writeUInt32LE(0, 4); // disk with ZIP64 EOCD
        locator.writeBigUInt64LE(BigInt(cdOffset + cdLength), 8); // offset of ZIP64 EOCD
        locator.writeUInt32LE(1, 16); // total disks

        eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(EOCD_SIG, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(0xffff, 8);
        eocd.writeUInt16LE(0xffff, 10);
        eocd.writeUInt32LE(ZIP32_MAX, 12);
        eocd.writeUInt32LE(ZIP32_MAX, 16);
        eocd.writeUInt16LE(0, 20);

        fs.writeFileSync(filePath, Buffer.concat([...chunks, cd, z64, locator, eocd]));
        return;
    }

    eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with central dir
    eocd.writeUInt16LE(entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(entries.length, 10); // total entries
    eocd.writeUInt32LE(cdLength, 12); // central dir size
    eocd.writeUInt32LE(cdOffset, 16); // central dir offset
    eocd.writeUInt16LE(0, 20); // comment length

    fs.writeFileSync(filePath, Buffer.concat([...chunks, cd, eocd]));
}
