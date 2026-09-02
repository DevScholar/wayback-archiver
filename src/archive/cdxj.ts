/**
 * cdxj.ts
 *
 * Parses a CDXJ index. Each line is:
 *
 *   <surt-key> <timestamp> <json>
 *
 * where the timestamp is a 17-digit WARC-style value (YYYYMMDDHHMMSSmmm) and
 * the JSON carries the fields needed to locate the record in the WARC:
 * `url`, `mime`, `offset`, `length`, `status`, `filename`, `digest`, etc.
 */

export interface CdxjEntry {
    /** The SURT sort key (used only for ordering). */
    key: string;
    /** 17-digit CDXJ timestamp, e.g. "20260831074839556". */
    timestamp: string;
    url: string;
    mime: string;
    status: number | null;
    /** Byte offset of the gzip member within the stored WARC file. */
    offset: number;
    /** Compressed length of the gzip member. */
    length: number;
    digest: string | null;
    filename: string;
    /** The raw JSON object for this line. */
    json: Record<string, unknown>;
}

export function parseCdxj(text: string): CdxjEntry[] {
    const out: CdxjEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;

        const sp1 = line.indexOf(' ');
        if (sp1 < 0) continue;
        const key = line.slice(0, sp1);

        const rest = line.slice(sp1 + 1).trimStart();
        const sp2 = rest.indexOf(' ');
        const timestamp = sp2 < 0 ? rest : rest.slice(0, sp2);
        const jsonText = sp2 < 0 ? '{}' : rest.slice(sp2 + 1).trim();

        let json: Record<string, unknown> = {};
        try {
            json = JSON.parse(jsonText);
        } catch {
            continue; // skip malformed lines
        }

        const url = String(json.url || '');
        const offset = Number(json.offset);
        const length = Number(json.length);
        if (!url || !Number.isFinite(offset) || !Number.isFinite(length)) continue;

        out.push({
            key,
            timestamp,
            url,
            mime: String(json.mime || ''),
            status: json.status != null ? Number(json.status) : null,
            offset,
            length,
            digest: json.digest != null ? String(json.digest) : null,
            filename: String(json.filename || ''),
            json,
        });
    }
    return out;
}
