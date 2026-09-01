/**
 * zip.ts
 *
 * A minimal ZIP reader with only the parts WACZ needs. WACZ files store
 * `archive/data.warc.gz` with the STORE method so it can be read via random
 * byte ranges (HTTP Range semantics), and the smaller metadata files are
 * either STORE or DEFLATE. We support both, using nothing but the Node
 * standard library.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

export interface ZipEntry {
    name: string;
    /** 0 = STORE, 8 = DEFLATE. */
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    /** Byte offset of the entry's file data within the archive. */
    dataOffset: number;
}

export class ZipReader {
    private buf: Buffer;
    private entries = new Map<string, ZipEntry>();

    constructor(buf: Buffer) {
        this.buf = buf;
        this.parse();
    }

    static open(filePath: string): ZipReader {
        return new ZipReader(fs.readFileSync(filePath));
    }

    private parse(): void {
        const buf = this.buf;

        // Locate the End Of Central Directory record by scanning backwards.
        // It is followed by an optional comment of up to 65535 bytes.
        let eocd = -1;
        const min = Math.max(0, buf.length - 65557);
        for (let i = buf.length - 22; i >= min; i--) {
            if (buf.readUInt32LE(i) === EOCD_SIG) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('Not a valid ZIP file (End Of Central Directory not found)');

        const entryCount = buf.readUInt16LE(eocd + 10);
        let offset = buf.readUInt32LE(eocd + 16);

        for (let i = 0; i < entryCount; i++) {
            if (buf.readUInt32LE(offset) !== CEN_SIG) {
                throw new Error('Corrupt ZIP: bad central directory entry');
            }

            const method = buf.readUInt16LE(offset + 10);
            const compressedSize = buf.readUInt32LE(offset + 20);
            const uncompressedSize = buf.readUInt32LE(offset + 24);
            const nameLen = buf.readUInt16LE(offset + 28);
            const extraLen = buf.readUInt16LE(offset + 30);
            const commentLen = buf.readUInt16LE(offset + 32);
            const localHeaderOffset = buf.readUInt32LE(offset + 42);
            const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

            // Resolve the actual start of the file data from the local header.
            if (buf.readUInt32LE(localHeaderOffset) !== LOC_SIG) {
                throw new Error(`Corrupt ZIP: bad local header for ${name}`);
            }
            const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
            const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
            const dataOffset = localHeaderOffset + 30 + lNameLen + lExtraLen;

            this.entries.set(name, {
                name,
                method,
                compressedSize,
                uncompressedSize,
                dataOffset,
            });

            offset += 46 + nameLen + extraLen + commentLen;
        }
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    /** Read a whole entry, decompressed. */
    readEntry(name: string): Buffer {
        const e = this.entries.get(name);
        if (!e) throw new Error(`Entry not found in archive: ${name}`);
        const raw = this.buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
        if (e.method === 0) return Buffer.from(raw); // STORE — copy so the caller owns it
        if (e.method === 8) return zlib.inflateRawSync(raw); // DEFLATE
        throw new Error(`Unsupported compression method ${e.method} for ${name}`);
    }

    /**
     * Read a byte range of a STORE entry without copying or decompressing the
     * whole thing. Used to gunzip a single WARC record from data.warc.gz.
     * The returned buffer shares memory with the archive buffer.
     */
    storedRange(name: string, start: number, length: number): Buffer {
        const e = this.entries.get(name);
        if (!e) throw new Error(`Entry not found in archive: ${name}`);
        if (e.method !== 0) throw new Error(`storedRange requires a STORE entry: ${name}`);
        return this.buf.subarray(e.dataOffset + start, e.dataOffset + start + length);
    }
}
