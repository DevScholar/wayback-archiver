/**
 * warc-peek.ts
 *
 * Reading a WARC member's header block without inflating its whole payload.
 * The rewrite tools use it to tell a `response` from a `revisit` and to read a
 * revisit's `WARC-Refers-To-*` fields, which the CDX index alone does not
 * record reliably.
 */

import * as zlib from "zlib";

/** Compressed bytes to inflate when peeking at a record's WARC header. A WARC
 * header block is small, and deflate cannot expand more than about 1 KiB of
 * plaintext per compressed byte, so this bounds the peek to a few MiB even for
 * a pathological record. */
const PEEK_COMPRESSED_BYTES = 2048;

/** Bytes of the inflated prefix to read as the header block. */
const PEEK_PLAIN_BYTES = 8192;

/**
 * Read a record's WARC header block without inflating its whole payload.
 *
 * The header sits at the start of the decompressed member, so inflating a
 * prefix of the compressed member with `Z_SYNC_FLUSH` yields it without
 * decoding the body. A member stored uncompressed (a `.warc` stream, which a
 * WACZ allows when the archive is streamed) is read as plain text. Returns null
 * for a member that is neither.
 */
export function peekWarcHeaders(member: Buffer): Map<string, string> | null {
  if (member.length === 0) return null;
  const slice =
    member.length > PEEK_COMPRESSED_BYTES
      ? member.subarray(0, PEEK_COMPRESSED_BYTES)
      : member;
  let text: string;
  try {
    text = zlib
      .gunzipSync(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .subarray(0, PEEK_PLAIN_BYTES)
      .toString("latin1");
  } catch {
    text = member.subarray(0, PEEK_PLAIN_BYTES).toString("latin1");
  }
  if (!text.startsWith("WARC/")) return null;

  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.set(
      line.slice(0, index).trim().toLowerCase(),
      line.slice(index + 1).trim(),
    );
  }
  return headers;
}

/** The `WARC-Type` a member declares, lowercased, or "" when it has none. */
export function peekWarcType(member: Buffer): string {
  const headers = peekWarcHeaders(member);
  return (headers?.get("warc-type") ?? "").toLowerCase();
}
