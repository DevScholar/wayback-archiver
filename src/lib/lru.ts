/**
 * lru.ts
 *
 * A small least-recently-used cache with an optional byte budget, used by the
 * replay server to avoid re-reading and re-decompressing the same archived
 * records on every request. Eviction drops the oldest entries until the entry
 * count is within `maxEntries` and the summed `sizeOf` is within `maxBytes`,
 * so memory stays bounded no matter how large the archive (or how many
 * distinct resources visitors request).
 */

export interface LruOptions<V> {
    /** Maximum number of cached entries. */
    maxEntries: number;
    /** Maximum total bytes of cached values (the sum of `sizeOf`). */
    maxBytes: number;
    /** Byte size of a value; defaults to 1 per entry (count-only budget). */
    sizeOf?: (value: V) => number;
    /**
     * Per-entry byte cap: a single value larger than this is never cached, even
     * if it would fit within `maxBytes`. Lets one oversized asset (a large
     * image or PDF) be served without evicting the whole hot cache. Defaults to
     * `maxBytes`.
     */
    maxEntryBytes?: number;
}

export class LruCache<V> {
    private readonly map = new Map<string, V>();
    private bytes = 0;

    constructor(private readonly opts: LruOptions<V>) {}

    get(key: string): V | undefined {
        const v = this.map.get(key);
        if (v === undefined) return undefined;
        // Refresh recency: re-inserting moves the entry to the "newest" end.
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    set(key: string, value: V): void {
        const size = this.opts.sizeOf ? this.opts.sizeOf(value) : 1;
        // A single value larger than the per-entry cap (or the whole budget)
        // would evict everything else the moment the next entry lands, so
        // refuse it outright.
        const entryCap = this.opts.maxEntryBytes ?? this.opts.maxBytes;
        if (size > entryCap) return;

        const old = this.map.get(key);
        if (old !== undefined) {
            this.bytes -= this.opts.sizeOf ? this.opts.sizeOf(old) : 1;
            this.map.delete(key);
        }

        this.map.set(key, value);
        this.bytes += size;
        this.evict();
    }

    clear(): void {
        this.map.clear();
        this.bytes = 0;
    }

    get size(): number {
        return this.map.size;
    }

    private evict(): void {
        while (this.map.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
            const oldestKey = this.map.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            const v = this.map.get(oldestKey)!;
            this.bytes -= this.opts.sizeOf ? this.opts.sizeOf(v) : 1;
            this.map.delete(oldestKey);
        }
    }
}
