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
import { candidateUrls, lookupKey, lookupPathKey, lookupKeyCi } from '../lib/url';

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
    /** lookupKeyCi(url) -> all captures whose scheme/host/path differ only by case. */
    private _indexByKeyCi = new Map<string, CdxjEntry[]>();
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

        // indexes -- take the first .cdx file
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

                const cikey = lookupKeyCi(e.url);
                const cilist = this._indexByKeyCi.get(cikey);
                if (cilist) cilist.push(e);
                else this._indexByKeyCi.set(cikey, [e]);
            }
            // Sort each list by ascending timestamp so timestamp-aware lookups
            // can pick "the latest capture at or before T" and "the nearest".
            for (const list of this._indexByKey.values()) {
                list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
            }
            for (const list of this._indexByPath.values()) {
                list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
            }
            for (const list of this._indexByKeyCi.values()) {
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

        // Case-insensitive fallback (last resort): the page references a path
        // in a different case than the crawler stored (legacy case-insensitive
        // servers, e.g. old IIS). Exact match already won above, so this only
        // fires on a genuine miss.
        const cilist = this._indexByKeyCi.get(lookupKeyCi(url));
        if (cilist && cilist.length) return cilist[0];
        return null;
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
        // A truncated timestamp names the end of the smallest specified unit,
        // so pad with 9s (not 0s) to make the target point the inclusive upper
        // bound of that unit (e.g. "20260831074847" -> "...74847999").
        const target = ts.padEnd(17, '9');

        const best = { before: null as CdxjEntry | null, after: null as CdxjEntry | null };

        const consider = (e: CdxjEntry): void => {
            if (e.timestamp <= target) {
                if (!best.before || e.timestamp > best.before.timestamp) best.before = e;
            } else {
                if (!best.after || e.timestamp < best.after.timestamp) best.after = e;
            }
        };

        const nearestOf = (list: CdxjEntry[]): CdxjEntry | null => {
            best.before = null;
            best.after = null;
            for (const e of list) consider(e);
            const before = best.before;
            const after = best.after;
            if (!before) return after ?? null;
            if (!after) return before;
            const gapBefore = BigInt(target) - BigInt(before.timestamp);
            const gapAfter = BigInt(after.timestamp) - BigInt(target);
            return gapBefore <= gapAfter ? before : after;
        };

        // Exact URL first: pick the nearest capture of this exact URL. An
        // exact hit must never be shadowed by a host/scheme variant (`www.` vs
        // bare, http vs https) whose capture sits closer to the requested
        // timestamp. That shadowing is exactly how a `www.` -> bare redirect
        // loops: the bare target request re-matches the `www.` redirect record
        // through the variant fallback and redirects straight back to bare.
        const exact = this._indexByKey.get(lookupKey(url));
        if (exact && exact.length) return nearestOf(exact);

        // Query-variant fallback: same scheme/host/port/path, any query.
        const plist = this._indexByPath.get(lookupPathKey(url));
        if (plist && plist.length) return nearestOf(plist);

        // Host/scheme variants (www. vs bare, http vs https), tried only when
        // the exact URL is not indexed at all.
        for (const cand of candidateUrls(url)) {
            if (cand === url) continue;
            const list = this._indexByKey.get(lookupKey(cand));
            if (list && list.length) return nearestOf(list);
        }

        // Case-insensitive fallback (last resort): exact + query-variant +
        // host/scheme all missed; try the same resource under a differently
        // cased path.
        const cilist = this._indexByKeyCi.get(lookupKeyCi(url));
        if (cilist && cilist.length) return nearestOf(cilist);

        return this.resolve(url);
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
