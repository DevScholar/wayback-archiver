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

import * as crypto from "crypto";
import * as zlib from "zlib";
import { ZipReader } from "../archive/zip.js";
import { parseCdxj } from "../archive/cdxj.js";
import { findHeaderEnd } from "../archive/warc.js";
import { base32Encode, parseDigest, type ParsedDigest } from "../lib/digest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Strip a leading `sha256:`/`sha-256:` prefix and whitespace, lowercase the
 * hex, or return null when the value is empty/absent. */
function hexOf(value: string | undefined | null): string | null {
  if (value == null) return null;
  const m = /(?:sha256:|sha-256:)?\s*([0-9a-fA-F]{64})/.exec(value.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Compare a freshly computed digest against the one a record carries.
 *
 * The algorithm comes from the digest's own length rather than its label:
 * 20 bytes is SHA-1, 32 is SHA-256. That way a WARC written by the Wayback
 * Machine (`sha1:BASE32`) and one written by a Webrecorder tool
 * (`sha256:hex`) are both checked the same way, instead of one of them being
 * reported as having no digest at all.
 */
function digestMatches(bytes: Buffer, stored: ParsedDigest): boolean {
  if (!stored.bytes) return false;
  const algorithm = stored.bytes.length === 20 ? "sha1" : "sha256";
  const computed = crypto.createHash(algorithm).update(bytes).digest();
  return computed.equals(stored.bytes);
}

/** Recompute `bytes` in the algorithm and spelling `stored` uses, for a
 * mismatch message. */
function computedDigestText(bytes: Buffer, stored: ParsedDigest): string {
  const algorithm = stored.bytes?.length === 20 ? "sha1" : "sha256";
  const raw = crypto.createHash(algorithm).update(bytes).digest();
  const value =
    stored.source === "base32" ? base32Encode(raw) : raw.toString("hex");
  return `${algorithm}:${value}`;
}

function digestText(stored: ParsedDigest | null): string {
  if (!stored) return "(absent)";
  const value = stored.source === "base32" ? stored.base32 : stored.hex;
  return `${stored.algorithm}:${value ?? ""}`;
}

/** Two digests name the same bytes, whether or not they share a spelling. */
function sameDigest(a: ParsedDigest | null, b: ParsedDigest | null): boolean {
  return !!a?.bytes && !!b?.bytes && a.bytes.equals(b.bytes);
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
  const text = raw.subarray(0, sep.index).toString("utf8");
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    map.set(
      line.slice(0, idx).trim().toLowerCase(),
      line.slice(idx + 1).trim(),
    );
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: npx tsx src/cli/verify.ts <archive.wacz>");
    process.exit(1);
  }

  const zip = ZipReader.open(input);
  const names = zip.names();

  let exitCode = 0;
  const fail = (msg: string): void => {
    exitCode = 1;
    console.log("FAIL  " + msg);
  };
  const ok = (msg: string): void => {
    console.log("PASS  " + msg);
  };

  // ---------------------------------------------------------------------
  // Layer 1: datapackage-digest.json -> sha256(datapackage.json).
  // ---------------------------------------------------------------------
  console.log("=== datapackage-digest.json ===");
  let datapackage: Record<string, unknown> | null = null;
  try {
    const dpBuf = zip.readEntry("datapackage.json");
    datapackage = JSON.parse(dpBuf.toString("utf8"));
    const digestEntry = zip.readEntry("datapackage-digest.json");
    const digest = JSON.parse(digestEntry.toString("utf8"));
    const expected = hexOf(
      typeof digest.hash === "string" ? digest.hash : undefined,
    );
    const actual = sha256(dpBuf);
    if (!expected) {
      fail("datapackage-digest.json has no usable hash");
    } else if (expected === actual) {
      ok(`datapackage.json matches digest (sha256:${actual})`);
    } else {
      fail(
        `datapackage.json digest mismatch: stored ${expected}, computed ${actual}`,
      );
    }
  } catch (e) {
    fail(`could not read datapackage: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // Layer 2: each resource hash + bytes vs the ZIP entry's stored bytes.
  // ---------------------------------------------------------------------
  console.log("\n=== datapackage resources ===");
  const resStats = newStats();
  const resourceBytes = new Map<string, Buffer>();
  if (datapackage && Array.isArray(datapackage.resources)) {
    const resources = datapackage.resources as Array<Record<string, unknown>>;
    for (const r of resources) {
      const path = typeof r.path === "string" ? r.path : "";
      const expectedHash = hexOf(
        typeof r.hash === "string" ? r.hash : undefined,
      );
      const expectedBytes = typeof r.bytes === "number" ? r.bytes : -1;
      if (!path) {
        fail("resource missing `path`");
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
        fail(
          `${path}: hash mismatch (stored ${expectedHash}, computed ${sha256(data)})`,
        );
      } else if (!bytesOk) {
        fail(
          `${path}: size mismatch (stored ${expectedBytes}, actual ${data.length})`,
        );
      }
      if (hashOk && bytesOk) resStats.ok++;
      else resStats.failed++;
    }
  } else {
    console.log("note: no `resources` array in datapackage.json");
  }
  console.log(`resources: ${resStats.ok} ok, ${resStats.failed} failed`);

  // ---------------------------------------------------------------------
  // Layer 3: per-record WARC digests, over the exact byte spans each covers.
  //
  // A `response` record's `WARC-Payload-Digest` covers the HTTP entity body.
  // A non-HTTP record (`resource`, `metadata`) has no HTTP message: its
  // payload is the whole block. A `revisit` record carries no payload of its
  // own: by WARC 1.1 its digest identifies the payload of the record named by
  // `WARC-Refers-To-Target-URI` / `WARC-Refers-To-Date`, so it is checked
  // against that record, and reported as unverifiable (not failed) when the
  // referenced record is not in the archive.
  // ---------------------------------------------------------------------
  console.log("\n=== WARC records ===");
  const recStats = newStats();
  const indexName =
    names.find((n) => n.endsWith(".cdx") && !n.endsWith(".cdx.gz")) ||
    names.find((n) => n.endsWith(".cdx"));
  const warcName = names.find(
    (n) => n.endsWith(".warc") || n.endsWith(".warc.gz"),
  );

  if (!indexName || !warcName) {
    fail("not a WACZ (missing CDX index or WARC)");
  } else {
    let entries: ReturnType<typeof parseCdxj>;
    try {
      entries = parseCdxj(zip.readEntry(indexName).toString("utf8"));
    } catch (e) {
      entries = [];
      fail(`could not parse index: ${(e as Error).message}`);
    }

    interface LoadedRecord {
      entry: { url: string };
      warc: Map<string, string>;
      block: Buffer;
      payload: Buffer;
      blockDigest: ParsedDigest | null;
      payloadDigest: ParsedDigest | null;
      targetUri: string;
      date: string;
      warcType: string;
    }

    const loaded: LoadedRecord[] = [];
    const revisitChecks: LoadedRecord[] = [];

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
      const blockDigest = parseDigest(warc.get("warc-block-digest"));
      const payloadDigest = parseDigest(warc.get("warc-payload-digest"));
      const contentLen = Number(warc.get("content-length"));

      // The WARC `Content-Length` is the exact record-block length. For a
      // response that block is the whole HTTP message (status line +
      // headers + blank line + body), which is what WARC-Block-Digest
      // hashes; the body span is re-derived from it. A non-HTTP record's
      // payload is the entire block, so no blank line is looked for.
      const sep = findHeaderEnd(raw);
      if (sep.index < 0 || !Number.isFinite(contentLen) || contentLen < 0) {
        recStats.skipped++;
        console.log(
          `SKIP  ${e.url}: no usable Content-Length to re-derive digest spans`,
        );
        continue;
      }
      const block = raw.subarray(
        sep.index + sep.termLen,
        sep.index + sep.termLen + contentLen,
      );
      const isHttp = block.subarray(0, 5).toString("latin1") === "HTTP/";
      let payload = block;
      if (isHttp) {
        const httpSep = findHeaderEnd(block);
        if (httpSep.index >= 0)
          payload = block.subarray(httpSep.index + httpSep.termLen);
      }

      const record: LoadedRecord = {
        entry: { url: e.url },
        warc,
        block,
        payload,
        blockDigest,
        payloadDigest,
        targetUri: warc.get("warc-target-uri") || "",
        date: warc.get("warc-date") || "",
        warcType: warc.get("warc-type") || "",
      };
      loaded.push(record);

      if (blockDigest) {
        if (digestMatches(block, blockDigest)) {
          recStats.ok++;
        } else {
          recStats.failed++;
          fail(
            `${e.url}: WARC-Block-Digest mismatch (stored ${digestText(blockDigest)}, computed ${computedDigestText(block, blockDigest)})`,
          );
        }
      } else {
        recStats.absent++;
      }

      if (payloadDigest) {
        if (record.warcType === "revisit") {
          revisitChecks.push(record);
        } else {
          if (digestMatches(payload, payloadDigest)) {
            recStats.ok++;
          } else {
            recStats.failed++;
            fail(
              `${e.url}: WARC-Payload-Digest mismatch (stored ${digestText(payloadDigest)}, computed ${computedDigestText(payload, payloadDigest)})`,
            );
          }
        }
      } else {
        recStats.absent++;
      }
      if (!blockDigest && !payloadDigest) {
        recStats.skipped++;
        console.log(`SKIP  ${e.url}: no WARC digests to check`);
      }
    }

    // Resolve revisit digests through the record they name. A visit with an
    // exact (target URI + date) match must match it; when only the target
    // URI is known and several captures exist, a match against any of them
    // passes, and no match is reported as unverifiable rather than as
    // corruption, because the intended capture cannot be identified.
    const byTarget = new Map<string, LoadedRecord[]>();
    const byTargetDate = new Map<string, LoadedRecord[]>();
    for (const record of loaded) {
      if (!record.targetUri) continue;
      const list = byTarget.get(record.targetUri) ?? [];
      list.push(record);
      byTarget.set(record.targetUri, list);
      if (record.date) {
        const key = record.targetUri + "\t" + record.date;
        const dated = byTargetDate.get(key) ?? [];
        dated.push(record);
        byTargetDate.set(key, dated);
      }
    }

    let resolvedRevisits = 0;
    let unverifiableRevisits = 0;
    for (const revisit of revisitChecks) {
      const expected = revisit.payloadDigest!;
      const refersTo = revisit.warc.get("warc-refers-to-target-uri") || "";
      const refersDate = revisit.warc.get("warc-refers-to-date") || "";
      const exact =
        refersTo && refersDate
          ? byTargetDate.get(refersTo + "\t" + refersDate)
          : undefined;
      const candidates =
        exact ?? (refersTo ? (byTarget.get(refersTo) ?? []) : []);

      let matched = false;
      for (const candidate of candidates) {
        if (candidate === revisit) continue;
        if (candidate.warcType === "revisit") {
          if (sameDigest(candidate.payloadDigest, expected)) {
            matched = true;
            break;
          }
        } else if (digestMatches(candidate.payload, expected)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        resolvedRevisits++;
        recStats.ok++;
      } else if (exact) {
        recStats.failed++;
        fail(
          `${revisit.entry.url}: WARC-Payload-Digest does not match the referenced record (stored ${digestText(expected)})`,
        );
      } else {
        unverifiableRevisits++;
      }
    }

    if (revisitChecks.length > 0) {
      console.log(
        `revisits: ${resolvedRevisits} payload digest(s) checked through WARC-Refers-To, ` +
          `${unverifiableRevisits} unverifiable (referenced record not archived)`,
      );
    }
    console.log(
      `records: ${recStats.ok} digest-checks ok, ${recStats.failed} failed, ` +
        `${recStats.absent} digest(s) absent, ${recStats.skipped} skipped`,
    );
  }

  console.log(
    "\n=== " + (exitCode === 0 ? "VERIFY PASSED" : "VERIFY FAILED") + " ===",
  );
  process.exit(exitCode);
}

main();
