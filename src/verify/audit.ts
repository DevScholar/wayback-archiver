/**
 * audit.ts
 *
 * The offline fixity audit, layer by layer:
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
 */

import * as zlib from "zlib";
import { ZipReader } from "../archive/zip.js";
import { parseCdxj } from "../archive/cdxj.js";
import { findHeaderEnd } from "../archive/warc.js";
import { parseDigest, type ParsedDigest } from "../lib/digest.js";
import {
  computedDigestText,
  digestMatches,
  digestText,
  hexOf,
  newStats,
  sameDigest,
  sha256,
  warcHeaders,
} from "./digest.js";

/** A report sink; each call is one line of the audit. */
type Reporter = (line: string) => void;

/**
 * Audit a WACZ file and report every layer. Returns the process exit code: 0
 * when every check passed, 1 when any failed.
 */
export function verifyArchive(
  inputFile: string,
  log: Reporter = console.log,
): number {
  const zip = ZipReader.open(inputFile);
  const names = zip.names();

  let exitCode = 0;
  const fail = (msg: string): void => {
    exitCode = 1;
    log("FAIL  " + msg);
  };
  const ok = (msg: string): void => {
    log("PASS  " + msg);
  };

  try {
    // Layer 1: datapackage-digest.json -> sha256(datapackage.json).
    log("=== datapackage-digest.json ===");
    const datapackage = verifyDatapackageDigest(zip, fail, ok);

    // Layer 2: each resource hash + bytes vs the ZIP entry's stored bytes.
    log("\n=== datapackage resources ===");
    verifyResources(zip, datapackage, log, fail);

    // Layer 3: per-record WARC digests, over the exact byte spans each covers.
    log("\n=== WARC records ===");
    verifyWarcRecords(zip, names, log, fail);
  } finally {
    zip.close();
  }

  log("\n=== " + (exitCode === 0 ? "VERIFY PASSED" : "VERIFY FAILED") + " ===");
  return exitCode;
}

/** Layer 1: the hash `datapackage-digest.json` records for `datapackage.json`
 * itself. Returns the parsed datapackage, or null when it cannot be read. */
function verifyDatapackageDigest(
  zip: ZipReader,
  fail: Reporter,
  ok: Reporter,
): Record<string, unknown> | null {
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
  return datapackage;
}

/** Layer 2: every resource `datapackage.json` lists, against the ZIP entry it
 * names. */
function verifyResources(
  zip: ZipReader,
  datapackage: Record<string, unknown> | null,
  log: Reporter,
  fail: Reporter,
): void {
  const resStats = newStats();
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
    log("note: no `resources` array in datapackage.json");
  }
  log(`resources: ${resStats.ok} ok, ${resStats.failed} failed`);
}

/** A record read for the audit, with the byte spans and digests it carries. */
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

/**
 * Layer 3: per-record digests.
 *
 * A `response` record's `WARC-Payload-Digest` covers the HTTP entity body.
 * A non-HTTP record (`resource`, `metadata`) has no HTTP message: its
 * payload is the whole block. A `revisit` record carries no payload of its
 * own: by WARC 1.1 its digest identifies the payload of the record named by
 * `WARC-Refers-To-Target-URI` / `WARC-Refers-To-Date`, so it is checked
 * against that record, and reported as unverifiable (not failed) when the
 * referenced record is not in the archive.
 */
function verifyWarcRecords(
  zip: ZipReader,
  names: string[],
  log: Reporter,
  fail: Reporter,
): void {
  const recStats = newStats();
  const indexName =
    names.find((n) => n.endsWith(".cdx") && !n.endsWith(".cdx.gz")) ||
    names.find((n) => n.endsWith(".cdx"));
  const warcName = names.find(
    (n) => n.endsWith(".warc") || n.endsWith(".warc.gz"),
  );

  if (!indexName || !warcName) {
    fail("not a WACZ (missing CDX index or WARC)");
    return;
  }

  let entries: ReturnType<typeof parseCdxj>;
  try {
    entries = parseCdxj(zip.readEntry(indexName).toString("utf8"));
  } catch (e) {
    entries = [];
    fail(`could not parse index: ${(e as Error).message}`);
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
      log(`SKIP  ${e.url}: no usable Content-Length to re-derive digest spans`);
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
      log(`SKIP  ${e.url}: no WARC digests to check`);
    }
  }

  // Resolve revisit digests through the record they name. A revisit with an
  // exact (target URI + date) match must match it; when only the target URI is
  // known and several captures exist, a match against any of them passes, and
  // no match is reported as unverifiable rather than as corruption, because
  // the intended capture cannot be identified.
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
    log(
      `revisits: ${resolvedRevisits} payload digest(s) checked through WARC-Refers-To, ` +
        `${unverifiableRevisits} unverifiable (referenced record not archived)`,
    );
  }
  log(
    `records: ${recStats.ok} digest-checks ok, ${recStats.failed} failed, ` +
      `${recStats.absent} digest(s) absent, ${recStats.skipped} skipped`,
  );
}
