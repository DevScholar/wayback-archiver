/**
 * digest.ts
 *
 * Digest helpers for the fixity audit: computing, comparing and spelling the
 * SHA-1 / SHA-256 values a WARC record and a datapackage carry. The algorithm
 * comes from a digest's own length rather than its label, so a WARC written by
 * the Wayback Machine (`sha1:BASE32`) and one written by a Webrecorder tool
 * (`sha256:hex`) are both checked the same way.
 */

import * as crypto from "crypto";
import { base32Encode, type ParsedDigest } from "../lib/digest.js";
import { findHeaderEnd } from "../archive/warc.js";

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Strip a leading `sha256:`/`sha-256:` prefix and whitespace, lowercase the
 * hex, or return null when the value is empty/absent. */
export function hexOf(value: string | undefined | null): string | null {
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
export function digestMatches(bytes: Buffer, stored: ParsedDigest): boolean {
  if (!stored.bytes) return false;
  const algorithm = stored.bytes.length === 20 ? "sha1" : "sha256";
  const computed = crypto.createHash(algorithm).update(bytes).digest();
  return computed.equals(stored.bytes);
}

/** Recompute `bytes` in the algorithm and spelling `stored` uses, for a
 * mismatch message. */
export function computedDigestText(
  bytes: Buffer,
  stored: ParsedDigest,
): string {
  const algorithm = stored.bytes?.length === 20 ? "sha1" : "sha256";
  const raw = crypto.createHash(algorithm).update(bytes).digest();
  const value =
    stored.source === "base32" ? base32Encode(raw) : raw.toString("hex");
  return `${algorithm}:${value}`;
}

export function digestText(stored: ParsedDigest | null): string {
  if (!stored) return "(absent)";
  const value = stored.source === "base32" ? stored.base32 : stored.hex;
  return `${stored.algorithm}:${value ?? ""}`;
}

/** Two digests name the same bytes, whether or not they share a spelling. */
export function sameDigest(
  a: ParsedDigest | null,
  b: ParsedDigest | null,
): boolean {
  return !!a?.bytes && !!b?.bytes && a.bytes.equals(b.bytes);
}

export interface Stats {
  checked: number;
  ok: number;
  failed: number;
  absent: number;
  skipped: number;
}

export function newStats(): Stats {
  return { checked: 0, ok: 0, failed: 0, absent: 0, skipped: 0 };
}

/** Parse a WARC record's WARC headers into a lowercase-name map (only the WARC
 * header block, not the HTTP block). */
export function warcHeaders(raw: Buffer): Map<string, string> {
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
