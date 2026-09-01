/**
 * wacz.ts
 *
 * Facade over a WACZ file. Opens the ZIP once, parses datapackage.json,
 * the CDXJ index, and pages.jsonl, and exposes a way to read any resource's
 * HTTP payload on demand.
 */

import * as zlib from 'zlib';
import { ZipReader } from './zip';
import { parseWarcRecord, WarcRecord } from './warc';
import { parseCdxj, CdxjEntry } from './cdxj';
import { candidateUrls, lookupKey, lookupPathKey } from './url';

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
    /** lookupKey(url) -> all captures of that URL, in index (ascending ts) order. */
    private _indexByKey = new Map<string, CdxjEntry[]>();
    /** lookupPathKey(url) -> all captures sharing that scheme/host/port/path, any query. */
    private _indexByPath = new Map<string, CdxjEntry[]>();
    /** Maps a WARC file basename (from CDXJ `filename`) to its ZIP entry path. */
    private _warcEntries = new Map<string, string>();
    private _title = '';

    constructor(private filePath: string) {
        this.zip = ZipReader.open(filePath);
        this.load();
    }

    get title(): string {
        return this._title || 'Web Archive';
    }

    get pages(): WaczPage[] {
        return this._pages;
    }

    get entries(): CdxjEntry[] {
        return this._entries;
    }

    private load(): void {
        // Index WARC entries by basename so CDXJ `filename` ("data.warc.gz")
        // can be resolved to its full ZIP path ("archive/data.warc.gz").
        for (const name of this.zip.names()) {
            const base = name.split('/').pop();
            if (base && (base.endsWith('.warc') || base.endsWith('.warc.gz'))) {
                this._warcEntries.set(base, name);
            }
        }

        // datapackage.json
        try {
            const dp = JSON.parse(this.zip.readEntry('datapackage.json').toString('utf8'));
            if (typeof dp.title === 'string') this._title = dp.title;
        } catch {
            /* datapackage.json is optional in practice */
        }

        // indexes — take the first .cdx file
        const indexName = this.zip.names().find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'));
        if (indexName) {
            this._entries = parseCdxj(this.zip.readEntry(indexName).toString('utf8'));
            for (const e of this._entries) {
                const key = lookupKey(e.url);
                const list = this._indexByKey.get(key);
                if (list) list.push(e);
                else this._indexByKey.set(key, [e]);

                const pkey = lookupPathKey(e.url);
                const plist = this._indexByPath.get(pkey);
                if (plist) plist.push(e);
                else this._indexByPath.set(pkey, [e]);
            }
            // Sort each list by ascending timestamp so timestamp-aware lookups
            // can pick "the latest capture at or before T" and "the nearest".
            for (const list of this._indexByKey.values()) {
                list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
            }
            for (const list of this._indexByPath.values()) {
                list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
            }
        }

        // pages.jsonl
        try {
            const text = this.zip.readEntry('pages/pages.jsonl').toString('utf8');
            for (const line of text.split(/\r?\n/)) {
                if (!line.trim()) continue;
                let obj: Record<string, unknown>;
                try {
                    obj = JSON.parse(line);
                } catch {
                    continue;
                }
                if (typeof obj.url === 'string' && typeof obj.ts === 'string') {
                    this._pages.push({
                        url: obj.url,
                        ts: obj.ts,
                        title: typeof obj.title === 'string' ? obj.title : undefined,
                        id: typeof obj.id === 'string' ? obj.id : undefined,
                        size: typeof obj.size === 'number' ? obj.size : undefined,
                    });
                }
            }
        } catch {
            /* pages.jsonl is optional */
        }
    }

    /** Find the best index entry for a requested URL, or null. */
    resolve(url: string): CdxjEntry | null {
        for (const cand of candidateUrls(url)) {
            const list = this._indexByKey.get(lookupKey(cand));
            if (list && list.length) return list[0];
        }
        // Query-variant fallback: same scheme/host/port/path, any query. This
        // covers the case where the crawler stored the resource under a
        // different query form than the page references (e.g. an image served
        // at `?w=400` archived only at `?w=1200&dpr=on,2`).
        const plist = this._indexByPath.get(lookupPathKey(url));
        if (plist && plist.length) return plist[0];
        return null;
    }

    /**
     * Resolve a URL against the index, preferring the capture nearest to (but
     * not after) a target timestamp prefix. `ts` may be a full 17-digit
     * timestamp or any shorter prefix; matches are compared on that prefix.
     * Falls back to the earliest capture when no capture is at-or-before.
     */
    resolveAt(url: string, ts: string): CdxjEntry | null {
        // A truncated timestamp means "the end of the smallest specified
        // unit", so pad with 9s (not 0s) to make it an inclusive upper bound.
        // E.g. "20260831074847" (second precision) -> "...74847999" so a
        // capture at 48:47.976 is at-or-before it, while a capture in the next
        // second (48:48.000) is not.
        const target = ts.padEnd(17, '9');
        let best: CdxjEntry | null = null;
        for (const cand of candidateUrls(url)) {
            const list = this._indexByKey.get(lookupKey(cand));
            if (!list) continue;
            for (const e of list) {
                // Skip captures after the target time.
                if (e.timestamp > target) continue;
                // Keep the latest capture at-or-before the target.
                if (!best || e.timestamp > best.timestamp) best = e;
            }
        }
        if (best) return best;
        // Query-variant fallback, still honoring the timestamp bound.
        const plist = this._indexByPath.get(lookupPathKey(url));
        if (plist) {
            for (const e of plist) {
                if (e.timestamp > target) continue;
                if (!best || e.timestamp > best.timestamp) best = e;
            }
        }
        return best ?? this.resolve(url);
    }

    /**
     * Resolve a URL and decompress its WARC record. Returns null if the URL
     * is not in the index. Errors reading a specific record throw.
     *
     * WARC `revisit` records (deduplication) carry an empty body and a digest,
     * pointing at the original `response` record via WARC-Refers-To-Target-URI.
     * We follow that reference so the requested URL serves the original bytes
     * under its own name — the entry and matchedUrl stay on the requested URL,
     * only the record payload comes from the referred-to original.
     */
    resolveRecord(url: string, ts?: string): ResolvedRecord | null {
        const entry = ts ? this.resolveAt(url, ts) : this.resolve(url);
        if (!entry) return null;

        let record = this.readRecord(entry);
        let matchedUrl = entry.url;

        // Follow revisit chains (bounded to avoid pathological cycles). The
        // original is resolved at the same timestamp as the revisit entry so a
        // deduplication reference points at the capture from the same point in
        // time rather than the earliest capture of that URL.
        for (let i = 0; i < 8; i++) {
            const refersTo = record.headers.get('warc-refers-to-target-uri');
            if (refersTo && (record.warcType === 'revisit' || record.body.length === 0)) {
                const original = this.resolveAt(refersTo, entry.timestamp);
                if (!original || original.url === matchedUrl) break;
                record = this.readRecord(original);
            } else {
                break;
            }
        }

        return { entry, matchedUrl, record };
    }

    /** Decompress and parse a single index entry's WARC record. */
    private readRecord(entry: CdxjEntry): WarcRecord {
        const zipName = this._warcEntries.get(entry.filename) || entry.filename;
        const raw = this.zip.storedRange(zipName, entry.offset, entry.length);
        const inflated = zlib.gunzipSync(raw);
        return parseWarcRecord(inflated);
    }
}
