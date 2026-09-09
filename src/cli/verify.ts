#!/usr/bin/env node
/**
 * verify.ts
 *
 * Offline fixity audit for a WACZ file. The downloader already writes every
 * digest an integrity check needs -- the resources' `sha256` hashes in
 * `datapackage.json`, the `datapackage-digest.json` that hashes datapackage
 * itself, and each WARC record's `WARC-Payload-Digest` / `WARC-Block-Digest` --
 * but never reads them back. This command closes the loop: it reads a finished
 * archive and confirms, layer by layer, that no byte has changed since it was
 * written.
 *
 * Three layers, each stronger than the last:
 *
 *   1. `datapackage-digest.json` -> `sha256(datapackage.json bytes)`.
 *   2. Each `datapackage.json` resource -> its `hash` + `bytes` must match the
 *      corresponding ZIP entry's stored bytes. This layer covers the whole
 *      `data.warc.gz` as one blob, so un-indexed `request` records are checked
 *      too, without ever walking the gzip members.
 *   3. Each CDXJ entry (a response record) -> gunzip the member and re-derive
 *      its `WARC-Block-Digest` (over the HTTP message) and
 *      `WARC-Payload-Digest` (over the body), then compare.
 *
 * This is an offline audit, not a replay-path gate: the replay server still
 * reads by trusting the index, and this command is run deliberately (after a
 * migration, a copy to new media, or on a schedule) to detect bit-rot.
 *
 * Usage:
 *   npx tsx src/cli/verify.ts <archive.wacz>
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { ZipReader } from '../archive/zip.js';
import { parseCdxj } from '../archive/cdxj.js';
import { findHeaderEnd } from '../archive/warc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Strip a leading `sha256:`/`sha-256:` prefix and whitespace, lowercase the
 * hex, or return null when the value is empty/absent. */
function hexOf(value: string | undefined | null): string | null {
    if (value == null) return null;
    const m = /(?:sha256:|sha-256:)?\s*([0-9a-fA-F]{64})/.exec(value.trim());
    return m ? m[1].toLowerCase() : null;
}

interface Stats {
    checked: number;
    ok: number;
    failed: number;
    absent: number;
    skipped: number;
}

function newStats(): Stats {
    return { checked: 0, ok: 0, failed: 0, absent: 0, skipped: 0 };
}

/** Parse a WARC record's WARC headers into a lowercase-name map (only the WARC
 * header block, not the HTTP block). */
function warcHeaders(raw: Buffer): Map<string, string> {
    const sep = findHeaderEnd(raw);
    if (sep.index < 0) return new Map();
    const text = raw.subarray(0, sep.index).toString('utf8');
    const map = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    const input = process.argv[2];
    if (!input) {
        console.error('Usage: npx tsx src/cli/verify.ts <archive.wacz>');
        process.exit(1);
    }

    const zip = ZipReader.open(input);
    const names = zip.names();

    let exitCode = 0;
    const fail = (msg: string): void => {
        exitCode = 1;
        console.log('FAIL  ' + msg);
    };
    const ok = (msg: string): void => {
        console.log('PASS  ' + msg);
    };

    // ---------------------------------------------------------------------
    // Layer 1: datapackage-digest.json -> sha256(datapackage.json).
    // ---------------------------------------------------------------------
    console.log('=== datapackage-digest.json ===');
    let datapackage: Record<string, unknown> | null = null;
    try {
        const dpBuf = zip.readEntry('datapackage.json');
        datapackage = JSON.parse(dpBuf.toString('utf8'));
        const digestEntry = zip.readEntry('datapackage-digest.json');
        const digest = JSON.parse(digestEntry.toString('utf8'));
        const expected = hexOf(typeof digest.hash === 'string' ? digest.hash : undefined);
        const actual = sha256(dpBuf);
        if (!expected) {
            fail('datapackage-digest.json has no usable hash');
        } else if (expected === actual) {
            ok(`datapackage.json matches digest (sha256:${actual})`);
        } else {
            fail(`datapackage.json digest mismatch: stored ${expected}, computed ${actual}`);
        }
    } catch (e) {
        fail(`could not read datapackage: ${(e as Error).message}`);
    }

    // ---------------------------------------------------------------------
    // Layer 2: each resource hash + bytes vs the ZIP entry's stored bytes.
    // ---------------------------------------------------------------------
    console.log('\n=== datapackage resources ===');
    const resStats = newStats();
    const resourceBytes = new Map<string, Buffer>();
    if (datapackage && Array.isArray(datapackage.resources)) {
        const resources = datapackage.resources as Array<Record<string, unknown>>;
        for (const r of resources) {
            const path = typeof r.path === 'string' ? r.path : '';
            const expectedHash = hexOf(typeof r.hash === 'string' ? r.hash : undefined);
            const expectedBytes = typeof r.bytes === 'number' ? r.bytes : -1;
            if (!path) {
                fail('resource missing `path`');
                resStats.failed++;
                continue;
            }
            let data: Buffer;
            try {
                data = zip.readEntry(path);
            } catch (e) {
                fail(`${path}: not present in ZIP (${(e as Error).message})`);
                resStats.failed++;
                continue;
            }
            resourceBytes.set(path, data);
            resStats.checked++;
            const hashOk = !expectedHash || expectedHash === sha256(data);
            const bytesOk = expectedBytes < 0 || expectedBytes === data.length;
            if (!hashOk) {
                fail(`${path}: hash mismatch (stored ${expectedHash}, computed ${sha256(data)})`);
            } else if (!bytesOk) {
                fail(`${path}: size mismatch (stored ${expectedBytes}, actual ${data.length})`);
            }
            if (hashOk && bytesOk) resStats.ok++;
            else resStats.failed++;
        }
    } else {
        console.log('note: no `resources` array in datapackage.json');
    }
    console.log(`resources: ${resStats.ok} ok, ${resStats.failed} failed`);

    // ---------------------------------------------------------------------
    // Layer 3: per-record WARC digests, over the exact byte spans each covers.
    // ---------------------------------------------------------------------
    console.log('\n=== WARC records ===');
    const recStats = newStats();
    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    const warcName = names.find((n) => n.endsWith('.warc') || n.endsWith('.warc.gz'));

    if (!indexName || !warcName) {
        fail('not a WACZ (missing CDX index or WARC)');
    } else {
        let entries: ReturnType<typeof parseCdxj>;
        try {
            entries = parseCdxj(zip.readEntry(indexName).toString('utf8'));
        } catch (e) {
            entries = [];
            fail(`could not parse index: ${(e as Error).message}`);
        }
        for (const e of entries) {
            recStats.checked++;
            let raw: Buffer;
            try {
                const member = zip.storedRange(warcName, e.offset, e.length);
                raw = zlib.gunzipSync(member);
            } catch (err) {
                recStats.failed++;
                fail(`${e.url}: could not read record (${(err as Error).message})`);
                continue;
            }

            const warc = warcHeaders(raw);
            const blockDigest = hexOf(warc.get('warc-block-digest'));
            const payloadDigest = hexOf(warc.get('warc-payload-digest'));
            const contentLen = Number(warc.get('content-length'));

            // The WARC `Content-Length` is the exact HTTP-message length (status
            // line + HTTP headers + blank line + body), which is what
            // WARC-Block-Digest hashes. Re-derive that span and the body span.
            const sep = findHeaderEnd(raw);
            if (sep.index < 0 || !Number.isFinite(contentLen) || contentLen < 0) {
                recStats.skipped++;
                console.log(`SKIP  ${e.url}: no usable Content-Length to re-derive digest spans`);
                continue;
            }
            const block = raw.subarray(sep.index + sep.termLen, sep.index + sep.termLen + contentLen);
            const httpSep = findHeaderEnd(block);
            const body = httpSep.index >= 0 ? block.subarray(httpSep.index + httpSep.termLen) : block;

            if (blockDigest) {
                const computed = sha256(block);
                if (computed === blockDigest) {
                    recStats.ok++;
                } else {
                    recStats.failed++;
                    fail(`${e.url}: WARC-Block-Digest mismatch (stored ${blockDigest}, computed ${computed})`);
                }
            } else {
                recStats.absent++;
            }
            if (payloadDigest) {
                const computed = sha256(body);
                if (computed === payloadDigest) {
                    recStats.ok++;
                } else {
                    recStats.failed++;
                    fail(`${e.url}: WARC-Payload-Digest mismatch (stored ${payloadDigest}, computed ${computed})`);
                }
            } else {
                recStats.absent++;
            }
            if (!blockDigest && !payloadDigest) {
                recStats.skipped++;
                console.log(`SKIP  ${e.url}: no WARC digests to check`);
            }
        }
        console.log(
            `records: ${recStats.ok} digest-checks ok, ${recStats.failed} failed, ` +
            `${recStats.absent} digest(s) absent, ${recStats.skipped} skipped`,
        );
    }

    console.log('\n=== ' + (exitCode === 0 ? 'VERIFY PASSED' : 'VERIFY FAILED') + ' ===');
    process.exit(exitCode);
}

main();
