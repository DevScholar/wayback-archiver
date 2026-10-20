/**
 * digest.ts
 *
 * The two digest spellings a web archive uses, and the conversion between them.
 *
 * The Wayback Machine reports a capture's digest as SHA-1 encoded in Base32:
 * 32 uppercase characters, no algorithm label, no padding. Webrecorder's tools
 * (and the CDXJ specification's own example) report SHA-256 in lowercase hex
 * under a `sha-256:` label. Both describe the same bytes -- the HTTP response
 * payload -- so the difference is an encoding choice, not a disagreement about
 * what is hashed.
 *
 * Base32 and hex convert in both directions, losslessly. SHA-1 and SHA-256 do
 * not: a SHA-256 digest cannot be shortened into the SHA-1 the Wayback Machine
 * prints. `waybackDigestOf` therefore never guesses -- it returns the Base32
 * form only when the value really is a SHA-1 digest, and null otherwise so the
 * caller can decide whether to recompute from the payload.
 */

import * as crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes as RFC 4648 Base32: uppercase, no padding. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode RFC 4648 Base32 (padding tolerated), or null when the text holds a
 * character outside the alphabet. */
export function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase()) {
    if (ch === "=") continue;
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** SHA-1 of `data` as 32 uppercase Base32 characters, the form the Wayback
 * Machine prints in its CDX `digest` column. */
export function sha1Base32(data: Buffer): string {
  return base32Encode(crypto.createHash("sha1").update(data).digest());
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** A digest value split into the forms a caller may need. */
export interface ParsedDigest {
  /** Lowercased algorithm name, e.g. "sha1" or "sha256". */
  algorithm: string;
  /** 20 bytes for SHA-1, 32 for SHA-256, null when the encoding is unknown. */
  bytes: Buffer | null;
  /** Lowercase hex, or null when the encoding is unknown. */
  hex: string | null;
  /** Uppercase Base32, or null when the encoding is unknown. */
  base32: string | null;
  /** The spelling the value arrived in, so a recomputed digest can be
   * compared in the same form. */
  source: "hex" | "base32";
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE32_RE = /^[A-Z2-7]+$/;

/**
 * Parse a digest value in any of the spellings found in the wild:
 *
 *   `sha1:BASE32`   Wayback's WARC field
 *   `sha-256:hex`   CDXJ / WACZ
 *   `sha256:hex`    the same, without the dash (CDXJ `recordDigest`)
 *   `BASE32`        Wayback's CDX column, label stripped
 *   `hex`           a bare 40- or 64-character hex digest
 *
 * Returns null for an empty or unrecognizable value.
 */
export function parseDigest(
  value: string | null | undefined,
): ParsedDigest | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;

  let algorithm = "";
  let body = text;
  const colon = text.indexOf(":");
  if (colon > 0) {
    algorithm = text.slice(0, colon).trim().toLowerCase();
    body = text.slice(colon + 1).trim();
  }
  if (!body) return null;

  // Work out the encoding from the text itself, then reconcile it with the
  // label. A bare token carries no label, so its length alone decides.
  let bytes: Buffer | null = null;
  let hex: string | null = null;
  let base32: string | null = null;
  let source: "hex" | "base32" = "hex";

  if (HEX_RE.test(body) && (body.length === 40 || body.length === 64)) {
    hex = body.toLowerCase();
    bytes = Buffer.from(hex, "hex");
    source = "hex";
  } else if (
    BASE32_RE.test(body.toUpperCase()) &&
    (body.length === 32 || body.length === 52)
  ) {
    base32 = body.toUpperCase();
    bytes = base32Decode(base32);
    source = "base32";
  } else {
    return null;
  }
  if (!bytes) return null;
  if (!hex) hex = bytes.toString("hex");
  if (!base32) base32 = base32Encode(bytes);

  // A label that disagrees with the value's length is a bug in the writer, not
  // a reason to fail: trust the length, which is what every reader does.
  if (!algorithm) algorithm = bytes.length === 20 ? "sha1" : "sha256";
  const normalized =
    algorithm === "sha-1"
      ? "sha1"
      : algorithm === "sha-256"
        ? "sha256"
        : algorithm;

  return { algorithm: normalized, bytes, hex, base32, source };
}

/**
 * The 32-character Base32 SHA-1 the Wayback Machine would print for this
 * digest, or null when the value is not a SHA-1 digest.
 *
 * A SHA-256 digest has no Base32 SHA-1 equivalent, so this returns null rather
 * than a plausible-looking lie. The caller recomputes from the payload when it
 * needs the Wayback spelling.
 */
export function waybackDigestOf(
  value: string | null | undefined,
): string | null {
  const parsed = parseDigest(value);
  if (!parsed || parsed.algorithm !== "sha1" || parsed.bytes?.length !== 20) {
    return null;
  }
  return parsed.base32;
}
