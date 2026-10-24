/**
 * wacz-records.ts
 *
 * Reading one capture's WARC record out of the archive by byte range. The
 * decompressed record is cached by its index location (not by URL), and
 * concurrent cold reads of the same record share one decompression.
 */

import * as zlib from "zlib";
import type { CdxjEntry } from "./cdxj.js";
import { parseWarcRecord, type WarcRecord } from "./warc.js";
import type { ZipReader } from "./zip.js";
import { LruCache } from "../lib/lru.js";

/** Gunzip a buffer off the event loop: `zlib.gunzip` runs the deflate work on
 * libuv's threadpool, so a large record's decompression does not block the
 * server's event loop the way `gunzipSync` does. */
function gunzipAsync(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

export class WarcRecordReader {
  /** Maps a WARC file basename (from CDXJ `filename`) to its ZIP entry path. */
  private warcEntries = new Map<string, string>();

  /**
   * Decompressed WARC records, keyed by `<filename>@<offset>`. Reading and
   * gunzipping a record on every request is the dominant cost of replaying a
   * hot URL; caching the parsed result turns repeated requests for the same
   * capture into a map lookup. The byte budget bounds the cache regardless of
   * archive size, and the value is keyed on the CDXJ location rather than the
   * URL so two distinct captures of the same URL (or a revisit and its
   * referred-to original) never collide.
   */
  private recordCache = new LruCache<WarcRecord>({
    maxEntries: 512,
    maxBytes: 128 * 1024 * 1024,
    // Records larger than 8 MiB are not cached: they are still read and
    // decompressed on demand, but caching one huge binary would evict the
    // whole working set of small records that dominate a page's replay.
    maxEntryBytes: 8 * 1024 * 1024,
    sizeOf: (r) => r.body.length,
  });

  /** In-flight async reads, keyed like `recordCache`. Concurrent requests for
   * a cold record share one decompression instead of each starting its own;
   * the promise is removed once it settles. */
  private pendingRecords = new Map<string, Promise<WarcRecord>>();

  constructor(private zip: ZipReader) {
    // Index WARC entries by basename so CDXJ `filename` ("data.warc.gz")
    // can be resolved to its full ZIP path ("archive/data.warc.gz").
    for (const name of zip.names()) {
      const base = name.split("/").pop();
      if (base && (base.endsWith(".warc") || base.endsWith(".warc.gz"))) {
        this.warcEntries.set(base, name);
      }
    }
  }

  /** Decompress and parse a single index entry's WARC record. */
  read(entry: CdxjEntry): WarcRecord {
    const zipName = this.warcEntries.get(entry.filename) || entry.filename;
    const cacheKey = `${zipName}@${entry.offset}`;
    const cached = this.recordCache.get(cacheKey);
    if (cached) return cached;

    const raw = this.zip.storedRange(zipName, entry.offset, entry.length);
    const inflated = zlib.gunzipSync(raw);
    const record = parseWarcRecord(inflated);
    this.recordCache.set(cacheKey, record);
    return record;
  }

  /**
   * Async counterpart of `read` for the replay server: reads and gunzips
   * a record without blocking the event loop. Cold records from concurrent
   * requests are de-duplicated through `pendingRecords`, so a burst of clients
   * hitting the same uncached capture triggers one decompression, not N.
   */
  readAsync(entry: CdxjEntry): Promise<WarcRecord> {
    const zipName = this.warcEntries.get(entry.filename) || entry.filename;
    const cacheKey = `${zipName}@${entry.offset}`;

    const cached = this.recordCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const pending = this.pendingRecords.get(cacheKey);
    if (pending) return pending;

    const loading = this.loadAsync(zipName, entry, cacheKey);
    this.pendingRecords.set(cacheKey, loading);
    return loading;
  }

  /** Perform the actual async read + gunzip + parse + cache for a cold record. */
  private async loadAsync(
    zipName: string,
    entry: CdxjEntry,
    cacheKey: string,
  ): Promise<WarcRecord> {
    try {
      const raw = await this.zip.storedRangeAsync(
        zipName,
        entry.offset,
        entry.length,
      );
      const inflated = await gunzipAsync(raw);
      const record = parseWarcRecord(inflated);
      this.recordCache.set(cacheKey, record);
      return record;
    } finally {
      this.pendingRecords.delete(cacheKey);
    }
  }
}
