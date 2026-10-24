/**
 * byte-range.ts
 *
 * Byte-range support (RFC 7233) for replayed bodies. A replay body is fully
 * materialized before it is written, so a range request can be satisfied by
 * slicing that buffer. This is what lets a browser drag a `<video>` scrubber on
 * an archived video: the media element probes with `Range: bytes=0-` first,
 * then re-requests the exact byte spans it needs as the user seeks.
 */

/** An inclusive byte range `[start, end]`, resolved and clamped against a
 * known total length. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single `Range: bytes=...` header against a body of `total` bytes.
 *
 * Returns:
 *   - a clamped, inclusive `{ start, end }` when the range is satisfiable;
 *   - `null` when there is no range header (serve the whole body);
 *   - `'invalid'` when the range is malformed or unsatisfiable (416).
 *
 * Only a single range is handled (`bytes=0-`, `bytes=500-999`, `bytes=-2048`).
 * A multi-range request (`bytes=0-99,200-299`) is treated as invalid rather
 * than answered with a multipart/byteranges body, which browsers never send
 * for `<video>` seeking anyway.
 */
export function parseByteRange(
  header: string | undefined,
  total: number,
): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const startStr = m[1];
  const endStr = m[2];

  if (startStr === "") {
    // Suffix range: the final N bytes (`bytes=-N`).
    if (endStr === "" || total === 0) return "invalid";
    const suffixLen = parseInt(endStr, 10);
    if (suffixLen <= 0) return "invalid";
    return { start: Math.max(0, total - suffixLen), end: total - 1 };
  }

  const start = parseInt(startStr, 10);
  if (endStr === "") {
    // Open-ended range: from `start` to the end (`bytes=N-`).
    if (start >= total) return "invalid";
    return { start, end: total - 1 };
  }

  const end = parseInt(endStr, 10);
  if (start > end || start >= total) return "invalid";
  return { start, end: Math.min(end, total - 1) };
}
