/**
 * package.ts
 *
 * Packaging captured records into a WACZ: one gzip member per WARC record (so a
 * record can be read by byte range), a sorted CDXJ index, pages.jsonl, and the
 * datapackage that describes them.
 */

import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { writeZipFile } from "../archive/zip-writer.js";
import { buildWarcinfoRecord } from "../archive/warc-writer.js";
import { cdxjTsToRfc3339 } from "../lib/time.js";
import {
  SOFTWARE,
  isHtmlMime,
  resource,
  indexLine,
  type ExistingArchive,
} from "../archive/wacz-append.js";

/** One hop of a fetched URL's redirect chain, already serialized as a WARC
 * `response` record (offset/length assigned later). A chain of length 1 means
 * the fetch returned a final response with no redirect. */
export interface HopRecord {
  url: string;
  status: number;
  mime: string;
  digest: string;
  responseRecord: Buffer;
}

/** A fetched URL, as a `request` record plus the WARC records that record its
 * outcome. On success there is one `response` record per redirect hop. A
 * failed fetch is not archived at all: the WARC record types (and the
 * `metadata` field vocabulary) have no standard way to record a capture error,
 * so nothing is written for it -- matching ArchiveWeb.page, which also omits
 * failed fetches. */
export interface NewRecord {
  url: string;
  ts: string;
  /** Page title extracted from the final hop's HTML body, when it is a page. */
  title?: string;
  /** The `request` record describing how this URL was fetched (headers sent). */
  requestRecord: Buffer;
  /** Serialized response records, one per redirect hop, in request order. */
  hops: HopRecord[];
}

export function writeWacz(opts: {
  outputFile: string;
  title: string;
  existing: ExistingArchive | null;
  newRecords: NewRecord[];
}): void {
  const { outputFile, title, existing, newRecords } = opts;

  // Each record is its own gzip member so a single record can be read by byte
  // range. A fresh archive begins with a `warcinfo` record describing the
  // crawl; on append the existing stream (and its own warcinfo) is carried
  // over unchanged, so the warcinfo is written exactly once per archive.
  const nowIso = new Date().toISOString();
  const warcParts: Buffer[] = existing ? [existing.warcGz] : [];
  let offset = existing ? existing.warcGz.length : 0;

  if (!existing) {
    const warcinfo = buildWarcinfoRecord({
      recordId: `<urn:uuid:${crypto.randomUUID()}>`,
      dateRfc3339: nowIso,
      warcFilename: `${path.basename(outputFile)}#/archive/data.warc.gz`,
      software: SOFTWARE,
      isPartOf: title,
    });
    const member = zlib.gzipSync(warcinfo);
    warcParts.push(member);
    offset += member.length;
  }

  const newIndexLines: string[] = [];
  const newPageObjs: Record<string, unknown>[] = [];

  for (const r of newRecords) {
    // The `request` record is written first as its own member -- always,
    // success or failure -- so the archive records the *intent* (what was
    // asked for, under which client identity) even when nothing came back.
    // It is NOT indexed: the CDXJ entries point only at response members, so
    // the request stays a self-describing annotation in the WARC stream
    // without being served.
    const reqMember = zlib.gzipSync(r.requestRecord);
    warcParts.push(reqMember);
    offset += reqMember.length;

    // One response record + CDXJ entry per redirect hop, each under its own
    // URL, so a replay of the original URL follows the 3xx chain hop by hop.
    for (const hop of r.hops) {
      const respMember = zlib.gzipSync(hop.responseRecord);
      warcParts.push(respMember);
      newIndexLines.push(
        indexLine(
          hop.url,
          r.ts,
          hop.status,
          hop.mime,
          hop.digest,
          offset,
          respMember.length,
        ),
      );
      offset += respMember.length;
    }

    // Only web pages become entry points listed on the index page, and only
    // one per url-list entry (keyed to the requested URL). Redirect hop URLs
    // stay in the index but are not pages. Subresources (images, CSS, JS, ...)
    // are still archived in the WARC, but omitting them from pages.jsonl keeps
    // the home page to just pages.
    const last = r.hops[r.hops.length - 1];
    if (isHtmlMime(last.mime)) {
      newPageObjs.push({
        url: r.url,
        ts: cdxjTsToRfc3339(r.ts),
        title: r.title || r.url,
      });
    }
  }
  const warcGz = Buffer.concat(warcParts);

  // Re-sort the merged CDXJ index (append requires the whole index to stay
  // sorted by SURT key + timestamp).
  const allIndexLines = [
    ...(existing ? existing.indexLines : []),
    ...newIndexLines,
  ].sort();
  const cdx = Buffer.from(allIndexLines.join("\n") + "\n", "utf-8");

  // pages.jsonl: keep the existing content, append the new pages.
  let pagesText: string;
  if (existing && existing.pagesText) {
    pagesText =
      existing.pagesText.replace(/\s+$/, "") +
      "\n" +
      newPageObjs.map((o) => JSON.stringify(o)).join("\n") +
      "\n";
  } else {
    pagesText =
      [
        { format: "json-pages-1.0", id: "pages", title: "All Pages" },
        ...newPageObjs,
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n";
  }
  const pages = Buffer.from(pagesText, "utf-8");

  // datapackage: preserve existing metadata, override title/resources/modified.
  const resources = [
    resource("pages.jsonl", "pages/pages.jsonl", pages),
    resource("data.warc.gz", "archive/data.warc.gz", warcGz),
    resource("index.cdx", "indexes/index.cdx", cdx),
  ];
  const dp: Record<string, unknown> = existing
    ? { ...existing.datapackage }
    : {
        profile: "data-package",
        wacz_version: "1.1.1",
        software: SOFTWARE,
        created: nowIso,
      };
  dp.title = title;
  dp.modified = nowIso;
  dp.resources = resources;
  const datapackageBuf = Buffer.from(
    JSON.stringify(dp, null, 2) + "\n",
    "utf-8",
  );

  const digestJson = {
    path: "datapackage.json",
    hash:
      "sha256:" +
      crypto.createHash("sha256").update(datapackageBuf).digest("hex"),
  };

  writeZipFile(outputFile, [
    { name: "datapackage.json", data: datapackageBuf, method: "deflate" },
    {
      name: "datapackage-digest.json",
      data: Buffer.from(JSON.stringify(digestJson, null, 2) + "\n", "utf-8"),
      method: "deflate",
    },
    { name: "pages/pages.jsonl", data: pages, method: "deflate" },
    { name: "archive/data.warc.gz", data: warcGz, method: "store" },
    { name: "indexes/index.cdx", data: cdx, method: "store" },
  ]);
}
