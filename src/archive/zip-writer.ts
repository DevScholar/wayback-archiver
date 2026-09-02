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

/** Write `entries` into a ZIP file at `filePath`. */
export function writeZipFile(filePath: string, entries: ZipWriteEntry[]): void {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const e of entries) {
        const method = e.method === 'store' ? 0 : 8;
        const crc = crc32(e.data);
        const comp = method === 0 ? e.data : zlib.deflateRawSync(e.data);
        const nameBuf = Buffer.from(e.name, 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOC_SIG, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra length

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(CEN_SIG, 0);
        cen.writeUInt16LE(20, 4); // version made by
        cen.writeUInt16LE(20, 6); // version needed
        cen.writeUInt16LE(0, 8); // flags
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(DOS_TIME, 12);
        cen.writeUInt16LE(DOS_DATE, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(comp.length, 20);
        cen.writeUInt32LE(e.data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30); // extra length
        cen.writeUInt16LE(0, 32); // comment length
        cen.writeUInt16LE(0, 34); // disk number start
        cen.writeUInt16LE(0, 36); // internal attrs
        cen.writeUInt32LE(0, 38); // external attrs
        cen.writeUInt32LE(offset, 42); // local header offset

        chunks.push(local, nameBuf, comp);
        central.push(cen, nameBuf);
        offset += 30 + nameBuf.length + comp.length;
    }

    const cdOffset = offset;
    const cd = Buffer.concat(central);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with central dir
    eocd.writeUInt16LE(entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(entries.length, 10); // total entries
    eocd.writeUInt32LE(cd.length, 12); // central dir size
    eocd.writeUInt32LE(cdOffset, 16); // central dir offset
    eocd.writeUInt16LE(0, 20); // comment length

    fs.writeFileSync(filePath, Buffer.concat([...chunks, cd, eocd]));
}
