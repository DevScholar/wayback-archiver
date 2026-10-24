import type { CdxjEntry } from "../src/archive/cdxj.js";
import type { WarcRecord } from "../src/archive/warc.js";
import type { WaybackTarget } from "../src/lib/wayback.js";
import type { FetchedHop } from "../src/restore/fetch.js";
import { buildRestoredRecords } from "../src/restore/records.js";

// Synthetic hops shaped like Wayback's `id_` responses, shared by the restorer
// tests: one plain capture, several historical snapshots of one URL, a playback
// (timestamp-shift) redirect, an era redirect, and Wayback's own error page.

export function target(innerUrl: string, ts14: string): WaybackTarget {
  return {
    innerUrl,
    ts14,
    modifier: "",
    idUrl: `https://web.archive.org/web/${ts14}id_/${innerUrl}`,
  };
}

export function hop(
  overrides: Partial<FetchedHop> & { url: string },
): FetchedHop {
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/html"]],
    body: Buffer.from("body"),
    ...overrides,
  };
}

export const identity = {
  userAgent: "TestAgent/1.0",
  accept: "*/*",
  acceptLanguage: "en",
};

export function build(
  targetValue: WaybackTarget,
  hops: FetchedHop[],
  storedKeys = new Set<string>(),
  identifiedTypeBySnapshot?: Map<string, string>,
) {
  return buildRestoredRecords({
    target: targetValue,
    hops,
    storedKeys,
    titleByInnerUrl: new Map(),
    identifiedTypeBySnapshot,
    ...identity,
  });
}

export function historicalHeaders(server: string): [string, string][] {
  return [
    ["x-archive-orig-server", server],
    ["x-archive-orig-date", "Sat, 26 Oct 1996 00:19:00 GMT"],
    ["x-archive-orig-content-length", "4"],
    ["server", "nginx"],
    ["content-type", "image/jpeg"],
  ];
}

export function cdxEntry(url: string, ts14: string): CdxjEntry {
  return {
    key: "",
    timestamp: ts14 + "000",
    url,
    mime: "text/html",
    status: 200,
    offset: 0,
    length: 0,
    digest: null,
    filename: "",
    json: {},
  };
}

export function warcRecord(opts: {
  identified?: string;
  guessedType?: string;
  guessedCharset?: string;
  contentType?: string;
}): WarcRecord {
  const httpHeaders = new Map<string, string>();
  httpHeaders.set("content-type", opts.contentType ?? "text/html");
  if (opts.guessedType)
    httpHeaders.set("x-archive-guessed-content-type", opts.guessedType);
  if (opts.guessedCharset)
    httpHeaders.set("x-archive-guessed-charset", opts.guessedCharset);
  const headers = new Map<string, string>();
  if (opts.identified)
    headers.set("warc-identified-payload-type", opts.identified);
  return {
    warcType: "response",
    headers,
    targetUri: null,
    date: null,
    contentType: null,
    httpStatus: 200,
    httpStatusText: "OK",
    httpHeaders,
    body: Buffer.alloc(0),
  };
}
