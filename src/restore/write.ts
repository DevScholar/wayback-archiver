/**
 * write.ts
 *
 * Writing the restored archive: the kept records and the carried ones become
 * one WARC stream, one CDXJ index and one pages.jsonl, wrapped in the WACZ ZIP
 * layout the other tools read.
 */

import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { writeZipFile } from "../archive/zip-writer.js";
import {
  buildWarcRecord,
  buildWarcinfoRecord,
  payloadDigest,
} from "../archive/warc-writer.js";
import { cdxjTsToRfc3339 } from "../lib/time.js";
import {
  SOFTWARE,
  indexLine,
  resource,
  type ExistingArchive,
} from "../archive/wacz-append.js";
import type { KeptRecord } from "./records.js";
import {
  dropStaleCarried,
  dropUnrestoredReplay,
  type CarriedRecord,
  type DroppedArchive,
} from "./carry.js";

/** Write (or append to) the output WACZ. Exported for the offline write-path
 * tests, which build records directly instead of fetching them. */
export function writeOutput(opts: {
  outputFile: string;
  title: string;
  existing: ExistingArchive | null;
  kept: KeptRecord[];
  pages: Record<string, unknown>[];
  carried: CarriedRecord[];
  restoredSnapKeys: Set<string>;
  /** Drop every carried Wayback replay record, including one an existing
   * output already holds, so only historical records remain. */
  dropUnrestored?: boolean;
}): void {
  const {
    outputFile,
    title,
    existing,
    kept,
    pages,
    carried,
    restoredSnapKeys,
    dropUnrestored = false,
  } = opts;

  const nowIso = new Date().toISOString();
  let cleaned: DroppedArchive | null = null;
  if (existing) {
    cleaned = dropStaleCarried(existing, restoredSnapKeys);
    if (dropUnrestored) {
      cleaned = dropUnrestoredReplay({ ...existing, ...cleaned });
    }
  }
  const baseWarcGz = cleaned ? cleaned.warcGz : null;
  const baseIndexLines = cleaned ? cleaned.indexLines : [];

  const warcParts: Buffer[] = baseWarcGz ? [baseWarcGz] : [];
  let offset = baseWarcGz ? baseWarcGz.length : 0;
  const newIndexLines: string[] = [];
  const carriedPages: Record<string, unknown>[] = [];

  // A fresh archive begins with a `warcinfo` record describing the restore,
  // mirroring the downloader. On append the existing stream (and its own
  // warcinfo) is carried over unchanged, so it is written exactly once.
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

  for (const r of kept) {
    // The `request` record (when present) is written first as its own
    // member, un-indexed: it documents the `id_` fetch that produced the
    // response member that follows.
    if (r.requestRecord) {
      const reqMember = zlib.gzipSync(r.requestRecord);
      warcParts.push(reqMember);
      offset += reqMember.length;
    }

    const record = buildWarcRecord({
      recordId: r.recordId,
      targetUri: r.innerUrl,
      dateRfc3339: cdxjTsToRfc3339(r.ts17),
      response: {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
        body: r.body,
      },
      identifiedPayloadType: r.identifiedPayloadType,
    });
    const member = zlib.gzipSync(record);
    warcParts.push(member);
    newIndexLines.push(
      indexLine(
        r.innerUrl,
        r.ts17,
        r.status,
        r.mime,
        payloadDigest(r.body),
        offset,
        member.length,
      ),
    );
    offset += member.length;
  }

  // Non-replay records carried over verbatim: the original gzip member bytes
  // are copied unchanged and re-indexed at their new offset, preserving every
  // other CDXJ field (including any non-standard ones the source tool wrote).
  for (const c of carried) {
    const member = c.rawMember;
    warcParts.push(member);
    const json = { ...c.json, offset, length: member.length };
    newIndexLines.push(`${c.key} ${c.ts} ${JSON.stringify(json)}`);
    offset += member.length;

    if (c.page) {
      // A carried page keeps the input's own page entry, including its
      // full text and size, instead of a stripped-down replacement. This
      // also covers a revisit record whose CDX mime says `warc/revisit`
      // but which the input still listed as a page.
      carriedPages.push(c.page);
    } else if (c.isHtml) {
      carriedPages.push({
        url: c.url,
        ts: cdxjTsToRfc3339(c.ts),
        title: c.title || c.url,
      });
    }
  }
  const warcGz = Buffer.concat(warcParts);

  const allIndexLines = [...baseIndexLines, ...newIndexLines].sort();
  const cdx = Buffer.from(allIndexLines.join("\n") + "\n", "utf-8");

  const allPages = [...pages, ...carriedPages];
  let pagesText: string;
  if (cleaned && cleaned.pagesText) {
    pagesText =
      cleaned.pagesText.replace(/\s+$/, "") +
      "\n" +
      allPages.map((o) => JSON.stringify(o)).join("\n") +
      "\n";
  } else {
    pagesText =
      [
        { format: "json-pages-1.0", id: "pages", title: "All Pages" },
        ...allPages,
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n";
  }
  const pagesBuf = Buffer.from(pagesText, "utf-8");

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
  dp.resources = [
    resource("pages.jsonl", "pages/pages.jsonl", pagesBuf),
    resource("data.warc.gz", "archive/data.warc.gz", warcGz),
    resource("index.cdx", "indexes/index.cdx", cdx),
  ];
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
    { name: "pages/pages.jsonl", data: pagesBuf, method: "deflate" },
    { name: "archive/data.warc.gz", data: warcGz, method: "store" },
    { name: "indexes/index.cdx", data: cdx, method: "store" },
  ]);
}
