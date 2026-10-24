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
 *
 * The audit itself is in `src/verify/audit`, its digest helpers in
 * `src/verify/digest`.
 */

import { verifyArchive } from "../verify/audit.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npx tsx src/cli/verify.ts <archive.wacz>");
  process.exit(1);
}

process.exit(verifyArchive(input));
