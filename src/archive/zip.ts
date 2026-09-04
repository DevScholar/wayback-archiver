/**
 * zip.ts
 *
 * A minimal ZIP reader with only the parts WACZ needs. WACZ files store
 * `archive/data.warc.gz` with the STORE method so it can be read via random
 * byte ranges (HTTP Range semantics), and the smaller metadata files are
 * either STORE or DEFLATE. We support both, using nothing but the Node
 * standard library.
 *
 * The reader keeps a file descriptor and reads only what it needs: the central
 * directory (one small header + name per entry) stays in memory, while entry
 * payloads -- including individual WARC records -- are pulled from disk on
 * demand via positional reads. This keeps memory proportional to the number of
 * entries, not the archive size.
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
    private fd: number;
    private size: number;
    private entries = new Map<string, ZipEntry>();
    private closed = false;

    private constructor(fd: number, size: number) {
        this.fd = fd;
        this.size = size;
        this.parse();
    }

    static open(filePath: string): ZipReader {
        const fd = fs.openSync(filePath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            return new ZipReader(fd, size);
        } catch (err) {
            fs.closeSync(fd);
            throw err;
        }
    }

    /** Read exactly `length` bytes at `offset`, looping over short reads. */
    private readRange(offset: number, length: number): Buffer {
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const n = fs.readSync(this.fd, buf, read, length - read, offset + read);
            if (n === 0) break;
            read += n;
        }
        if (read !== length) {
            throw new Error(`Short read in ZIP (wanted ${length}, got ${read})`);
        }
        return buf;
    }

    private parse(): void {
        // Locate the End Of Central Directory record by scanning backwards. It
        // is followed by an optional comment of up to 65535 bytes, so it sits
        // within the last 65557 bytes of the file.
        const tailLen = Math.min(this.size, 65557);
        const tail = this.readRange(this.size - tailLen, tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('Not a valid ZIP file (End Of Central Directory not found)');

        const entryCount = tail.readUInt16LE(eocd + 10);
        const cdLength = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);

        // Read the central directory in one shot; it is small (one ~46-byte
        // header + name per entry). Entry payloads are not read here.
        const cd = this.readRange(cdOffset, cdLength);

        let offset = 0;
        for (let i = 0; i < entryCount; i++) {
            if (cd.readUInt32LE(offset) !== CEN_SIG) {
                throw new Error('Corrupt ZIP: bad central directory entry');
            }

            const method = cd.readUInt16LE(offset + 10);
            const compressedSize = cd.readUInt32LE(offset + 20);
            const uncompressedSize = cd.readUInt32LE(offset + 24);
            const nameLen = cd.readUInt16LE(offset + 28);
            const extraLen = cd.readUInt16LE(offset + 30);
            const commentLen = cd.readUInt16LE(offset + 32);
            const localHeaderOffset = cd.readUInt32LE(offset + 42);
            const name = cd.toString('utf8', offset + 46, offset + 46 + nameLen);

            // Resolve the actual start of the file data from the local header.
            const local = this.readRange(localHeaderOffset, 30);
            if (local.readUInt32LE(0) !== LOC_SIG) {
                throw new Error(`Corrupt ZIP: bad local header for ${name}`);
            }
            const lNameLen = local.readUInt16LE(26);
            const lExtraLen = local.readUInt16LE(28);
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
        const raw = this.readRange(e.dataOffset, e.compressedSize);
        if (e.method === 0) return raw; // STORE
        if (e.method === 8) return zlib.inflateRawSync(raw); // DEFLATE
        throw new Error(`Unsupported compression method ${e.method} for ${name}`);
    }

    /**
     * Read a byte range of a STORE entry without decompressing the whole thing.
     * Used to gunzip a single WARC record from data.warc.gz. The returned buffer
     * is owned by the caller.
     */
    storedRange(name: string, start: number, length: number): Buffer {
        const e = this.entries.get(name);
        if (!e) throw new Error(`Entry not found in archive: ${name}`);
        if (e.method !== 0) throw new Error(`storedRange requires a STORE entry: ${name}`);
        return this.readRange(e.dataOffset + start, length);
    }

    /** Release the file descriptor. Safe to call more than once. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        fs.closeSync(this.fd);
    }
}
