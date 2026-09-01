/**
 * time.ts
 *
 * Timestamp conversion helpers. WACZ mixes two timestamp forms:
 *   • CDXJ — a 17-digit value `YYYYMMDDHHMMSSmmm` (used for record lookup).
 *   • RFC3339 — ISO 8601 with milliseconds and a `Z` suffix (used by WARC-Date
 *     and pages.jsonl).
 */

/** Convert a 17-digit CDXJ timestamp to RFC3339 (assumed UTC). */
export function cdxjTsToRfc3339(ts: string): string {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?/);
    if (!m) return ts;
    let s = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    if (m[7]) s += `.${m[7]}`;
    return s + 'Z';
}

/** Extract the leading 14 digits of an RFC3339 timestamp (for /web/<ts>/ routes). */
export function rfc3339ToTs14(ts: string): string {
    const digits = ts.replace(/\D/g, '');
    return digits.slice(0, 14);
}

/** Current UTC time as a 17-digit CDXJ timestamp (`YYYYMMDDHHMMSSmmm`). */
export function nowTs17(): string {
    const d = new Date();
    const p = (n: number, w: number) => String(n).padStart(w, '0');
    return (
        p(d.getUTCFullYear(), 4) +
        p(d.getUTCMonth() + 1, 2) +
        p(d.getUTCDate(), 2) +
        p(d.getUTCHours(), 2) +
        p(d.getUTCMinutes(), 2) +
        p(d.getUTCSeconds(), 2) +
        p(d.getUTCMilliseconds(), 3)
    );
}
