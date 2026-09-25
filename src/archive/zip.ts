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
const ZIP64_EOCD_SIG = 0x06064b50; // ZIP64 End Of Central Directory record
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50; // ZIP64 End Of Central Directory locator
const ZIP64_EXTRA_ID = 0x0001; // ZIP64 extended information extra field

// ZIP64 saturation sentinel: a 32-bit field at this value carries its real
// value in the ZIP64 extra field (sizes/offset) or the ZIP64 EOCD (counts,
// central-dir size/offset).
const ZIP32_MAX = 0xffffffff;

/**
 * Read the 64-bit values a ZIP64 extra field (ID 0x0001) carries. The field
 * lists, in order, only the values whose standard 32-bit field is saturated to
 * 0xFFFFFFFF: uncompressed size, compressed size, local-header offset, disk
 * number. `want` says which of the first three are saturated (hence present);
 * each present value is an 8-byte little-endian integer. Returns `null` for a
 * value that was not requested.
 */
function readZip64Extra(
    extra: Buffer,
    want: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed: number | null; compressed: number | null; offset: number | null } {
    let uncompressed: number | null = null;
    let compressed: number | null = null;
    let offset: number | null = null;
    for (let p = 0; p + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(p);
        const len = extra.readUInt16LE(p + 2);
        const data = extra.subarray(p + 4, p + 4 + len);
        if (id === ZIP64_EXTRA_ID) {
            let q = 0;
            if (want.uncompressed && q + 8 <= data.length) {
                uncompressed = Number(data.readBigUInt64LE(q));
                q += 8;
            }
            if (want.compressed && q + 8 <= data.length) {
                compressed = Number(data.readBigUInt64LE(q));
                q += 8;
            }
            if (want.offset && q + 8 <= data.length) {
                offset = Number(data.readBigUInt64LE(q));
            }
            break;
        }
        p += 4 + len;
    }
    return { uncompressed, compressed, offset };
}

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

        let entryCount = tail.readUInt16LE(eocd + 10);
        let cdLength = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);

        // ZIP64: when a count/size/offset saturates its 32-bit field, the real
        // value lives in the ZIP64 EOCD record, found via the ZIP64 EOCD
        // locator that sits immediately before the classic EOCD.
        if (entryCount === 0xffff || cdLength === ZIP32_MAX || cdOffset === ZIP32_MAX) {
            const locatorAt = this.size - tailLen + eocd - 20;
            const locator = this.readRange(locatorAt, 20);
            if (locator.readUInt32LE(0) === ZIP64_EOCD_LOCATOR_SIG) {
                const z64At = Number(locator.readBigUInt64LE(8));
                const z64 = this.readRange(z64At, 56);
                if (z64.readUInt32LE(0) === ZIP64_EOCD_SIG) {
                    entryCount = Number(z64.readBigUInt64LE(32));
                    cdLength = Number(z64.readBigUInt64LE(40));
                    cdOffset = Number(z64.readBigUInt64LE(48));
                }
            }
        }

        // Read the central directory in one shot; it is small (one ~46-byte
        // header + name per entry). Entry payloads are not read here.
        const cd = this.readRange(cdOffset, cdLength);

        let offset = 0;
        for (let i = 0; i < entryCount; i++) {
            if (cd.readUInt32LE(offset) !== CEN_SIG) {
                throw new Error('Corrupt ZIP: bad central directory entry');
            }

            const method = cd.readUInt16LE(offset + 10);
            let compressedSize = cd.readUInt32LE(offset + 20);
            let uncompressedSize = cd.readUInt32LE(offset + 24);
            const nameLen = cd.readUInt16LE(offset + 28);
            const extraLen = cd.readUInt16LE(offset + 30);
            const commentLen = cd.readUInt16LE(offset + 32);
            let localHeaderOffset = cd.readUInt32LE(offset + 42);
            const name = cd.toString('utf8', offset + 46, offset + 46 + nameLen);

            // ZIP64: a size/offset saturated to 0xFFFFFFFF carries its real
            // 64-bit value in the central entry's ZIP64 extra field.
            if (
                compressedSize === ZIP32_MAX ||
                uncompressedSize === ZIP32_MAX ||
                localHeaderOffset === ZIP32_MAX
            ) {
                const extra = cd.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen);
                const z64 = readZip64Extra(extra, {
                    uncompressed: uncompressedSize === ZIP32_MAX,
                    compressed: compressedSize === ZIP32_MAX,
                    offset: localHeaderOffset === ZIP32_MAX,
                });
                if (z64.uncompressed !== null) uncompressedSize = z64.uncompressed;
                if (z64.compressed !== null) compressedSize = z64.compressed;
                if (z64.offset !== null) localHeaderOffset = z64.offset;
            }

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

    /** Async counterpart of `readRange` for the replay server's hot path. The
     * positional read (explicit `position`) never moves the shared file offset,
     * so it is safe to interleave with the synchronous reads. */
    private readRangeAsync(offset: number, length: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (length === 0) {
                resolve(Buffer.alloc(0));
                return;
            }
            const buf = Buffer.alloc(length);
            let read = 0;
            const next = (err: NodeJS.ErrnoException | null, n: number): void => {
                if (err) return reject(err);
                if (n === 0) return reject(new Error(`Short read in ZIP (wanted ${length}, got ${read})`));
                read += n;
                if (read >= length) return resolve(buf);
                fs.read(this.fd, buf, read, length - read, offset + read, next);
            };
            fs.read(this.fd, buf, 0, length, offset, next);
        });
    }

    /** Async counterpart of `storedRange`: read a byte range of a STORE entry
     * without decompressing the whole thing. Used to gunzip a single WARC record
     * from data.warc.gz off the event loop. */
    async storedRangeAsync(name: string, start: number, length: number): Promise<Buffer> {
        const e = this.entries.get(name);
        if (!e) throw new Error(`Entry not found in archive: ${name}`);
        if (e.method !== 0) throw new Error(`storedRangeAsync requires a STORE entry: ${name}`);
        return this.readRangeAsync(e.dataOffset + start, length);
    }

    /** Release the file descriptor. Safe to call more than once. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        fs.closeSync(this.fd);
    }
}
