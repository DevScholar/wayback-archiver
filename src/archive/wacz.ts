/**
 * wacz.ts
 *
 * Facade over a WACZ file. Opens the ZIP once, parses datapackage.json,
 * the CDXJ index, and pages.jsonl, and exposes a way to read any resource's
 * HTTP payload on demand.
 *
 * The lookup tables live in `wacz-index` and the record reads in
 * `wacz-records`; this class holds them together for the tools that replay,
 * merge, de-duplicate or export an archive.
 */

import { ZipReader } from "./zip.js";
import { type WarcRecord } from "./warc.js";
import { parseCdxj, type CdxjEntry } from "./cdxj.js";
import {
  buildWaczIndex,
  findCapture,
  findNearestCapture,
  findThumbnail,
  type WaczIndex,
} from "./wacz-index.js";
import { WarcRecordReader } from "./wacz-records.js";

export interface WaczPage {
  url: string;
  ts: string;
  title?: string;
  id?: string;
  size?: number;
}

export interface ResolvedRecord {
  entry: CdxjEntry;
  /** The URL that actually matched the index (may differ from the request). */
  matchedUrl: string;
  record: WarcRecord;
}

export class Wacz {
  private zip: ZipReader;
  private _entries: CdxjEntry[] = [];
  private _pages: WaczPage[] = [];
  private _index: WaczIndex = buildWaczIndex([]);
  private _reader: WarcRecordReader;
  private _title = "";

  constructor(private filePath: string) {
    this.zip = ZipReader.open(filePath);
    this._reader = new WarcRecordReader(this.zip);
    this.load();
  }

  get title(): string {
    return this._title || "Web Archive";
  }

  get pages(): WaczPage[] {
    return [...this._pages];
  }

  get entries(): CdxjEntry[] {
    return [...this._entries];
  }

  /**
   * Find the thumbnail (page screenshot) for a page capture, or null. `ts` is
   * RFC3339 (pages.jsonl form). A page is identified by its capture time and
   * inner URL: for a Wayback replay URL the capture time is the timestamp
   * embedded in the URL; for a direct or restored capture it is the page's
   * own `ts`. The same pair is used to index each thumbnail, so a page always
   * matches its own screenshot even when the same URL was captured many
   * times.
   */
  thumbnailFor(url: string, ts: string): CdxjEntry | null {
    return findThumbnail(this._index, url, ts);
  }

  /** Release the archive's underlying file descriptor. Safe to call more than
   * once; the archive cannot be read after this. */
  close(): void {
    this.zip.close();
  }

  /** Allow `using`-style ownership: `using w = new Wacz(...)`. */
  [Symbol.dispose](): void {
    this.close();
  }

  private load(): void {
    // datapackage.json
    try {
      const dp = JSON.parse(
        this.zip.readEntry("datapackage.json").toString("utf8"),
      );
      if (typeof dp.title === "string") this._title = dp.title;
    } catch {
      /* datapackage.json is optional in practice */
    }

    // indexes -- take the first .cdx file
    const indexName = this.zip
      .names()
      .find((n) => n.endsWith(".cdx") && !n.endsWith(".cdx.gz"));
    if (indexName) {
      this._entries = parseCdxj(this.zip.readEntry(indexName).toString("utf8"));
      this._index = buildWaczIndex(this._entries);
    }

    // pages.jsonl
    try {
      const text = this.zip.readEntry("pages/pages.jsonl").toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof obj.url === "string" && typeof obj.ts === "string") {
          this._pages.push({
            url: obj.url,
            ts: obj.ts,
            title: typeof obj.title === "string" ? obj.title : undefined,
            id: typeof obj.id === "string" ? obj.id : undefined,
            size: typeof obj.size === "number" ? obj.size : undefined,
          });
        }
      }
    } catch {
      /* pages.jsonl is optional */
    }
  }

  /** Find the best index entry for a requested URL, or null. */
  resolve(url: string): CdxjEntry | null {
    return findCapture(this._index, url);
  }

  /**
   * Resolve a URL against the index, preferring the capture closest to a
   * target timestamp prefix by absolute distance -- the same rule the Wayback
   * Machine uses for replay (a miss may resolve either forward to a later
   * capture or backward to an earlier one, whichever is nearer). Ties are
   * broken toward the earlier capture. `ts` may be a full 17-digit timestamp
   * or any shorter prefix. Falls back to the earliest capture when the URL is
   * not indexed at all.
   */
  resolveAt(url: string, ts: string): CdxjEntry | null {
    return findNearestCapture(this._index, url, ts);
  }

  /**
   * Resolve a URL and decompress its WARC record. Returns null if the URL
   * is not in the index. Errors reading a specific record throw.
   *
   * WARC `revisit` records (deduplication) carry an empty body and a digest,
   * pointing at the original `response` record via WARC-Refers-To-Target-URI.
   * We follow that reference so the requested URL serves the original bytes
   * under its own name -- the entry and matchedUrl stay on the requested URL,
   * only the record payload comes from the referred-to original.
   */
  resolveRecord(url: string, ts?: string): ResolvedRecord | null {
    const entry = ts ? this.resolveAt(url, ts) : this.resolve(url);
    if (!entry) return null;

    let record = this._reader.read(entry);
    let matchedUrl = entry.url;

    // Follow revisit chains (bounded to avoid pathological cycles). The
    // original is resolved at the same timestamp as the revisit entry so a
    // deduplication reference points at the capture from the same point in
    // time rather than the earliest capture of that URL.
    for (let i = 0; i < 8; i++) {
      const refersTo = record.headers.get("warc-refers-to-target-uri");
      if (
        refersTo &&
        (record.warcType === "revisit" || record.body.length === 0)
      ) {
        const original = this.resolveAt(refersTo, entry.timestamp);
        if (!original || original.url === matchedUrl) break;
        record = this._reader.read(original);
      } else {
        break;
      }
    }

    return { entry, matchedUrl, record };
  }

  /**
   * Async counterpart of `resolveRecord` for the replay server. Same revisit
   * chain-following, but each record read is awaited off the event loop so a
   * slow decompression never blocks other requests.
   */
  async resolveRecordAsync(
    url: string,
    ts?: string,
  ): Promise<ResolvedRecord | null> {
    const entry = ts ? this.resolveAt(url, ts) : this.resolve(url);
    if (!entry) return null;

    let record = await this._reader.readAsync(entry);
    let matchedUrl = entry.url;

    for (let i = 0; i < 8; i++) {
      const refersTo = record.headers.get("warc-refers-to-target-uri");
      if (
        refersTo &&
        (record.warcType === "revisit" || record.body.length === 0)
      ) {
        const original = this.resolveAt(refersTo, entry.timestamp);
        if (!original || original.url === matchedUrl) break;
        record = await this._reader.readAsync(original);
      } else {
        break;
      }
    }

    return { entry, matchedUrl, record };
  }

  /**
   * Read the record an index entry points at, following `revisit` references.
   *
   * Callers that already hold an entry (the CDX endpoint, for instance) need
   * the payload bytes rather than the empty body of a deduplicated record.
   * Unlike `resolveRecordAsync` this does not look the URL up again, so the
   * entry that answers is exactly the one asked for -- two captures of the same
   * URL at the same timestamp must not borrow each other's bytes.
   */
  async recordForEntryAsync(entry: CdxjEntry): Promise<WarcRecord> {
    let record = await this._reader.readAsync(entry);
    for (let i = 0; i < 8; i++) {
      const refersTo = record.headers.get("warc-refers-to-target-uri");
      if (
        refersTo &&
        (record.warcType === "revisit" || record.body.length === 0)
      ) {
        const original = this.resolveAt(refersTo, entry.timestamp);
        if (!original) break;
        record = await this._reader.readAsync(original);
      } else {
        break;
      }
    }
    return record;
  }
}
