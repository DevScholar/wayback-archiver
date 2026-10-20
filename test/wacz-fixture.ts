/**
 * wacz-fixture.ts
 *
 * Builds small WACZ files for the merge/dedupe tests. Records go through the
 * same WARC writer the downloader uses and the same ZIP writer, so a fixture
 * has the shape the tools meet in practice: one gzip member per record, a CDXJ
 * index pointing at byte ranges, and a `pages.jsonl`.
 *
 * The file name is not `*.test.ts`, so the test runner does not execute it.
 */

import * as crypto from "crypto";
import * as zlib from "zlib";
import { writeZipFile, type ZipWriteEntry } from "../src/archive/zip-writer.js";
import {
  buildWarcRecord,
  buildWarcinfoRecord,
  payloadDigest,
} from "../src/archive/warc-writer.js";
import { surtKey } from "../src/lib/url.js";
import { cdxjTsToRfc3339 } from "../src/lib/time.js";
import { SOFTWARE, resource } from "../src/archive/wacz-append.js";
import { ZipReader } from "../src/archive/zip.js";
import { parseCdxj, type CdxjEntry } from "../src/archive/cdxj.js";
import { parseWarcRecord, type WarcRecord } from "../src/archive/warc.js";

/** The record a fixture revisit points at. */
export interface FixtureRevisit {
  /** `WARC-Record-ID` of the record this revisit names. */
  refersToId: string;
  /** Defaults to the revisit's own URL. */
  refersToUri?: string;
  /** Defaults to the revisit's own capture time. */
  refersToDate?: string;
}

export interface FixtureRecord {
  url: string;
  /** 17-digit CDXJ timestamp. */
  ts: string;
  body?: string;
  status?: number;
  mime?: string;
  headers?: [string, string][];
  /** `WARC-Record-ID`. Generated when absent. */
  id?: string;
  /** Write a `revisit` record instead of a `response`. */
  revisit?: FixtureRevisit;
}

export interface FixtureOptions {
  title?: string;
  /** ZIP path of the WARC stream. Defaults to `archive/data.warc.gz`. */
  warcPath?: string;
  /** More WARC streams in the same archive. */
  additionalStreams?: { path: string; records: FixtureRecord[] }[];
  /** Write a `warcinfo` member at the start of every stream. Default true. */
  withWarcinfo?: boolean;
  /** Page entries. Defaults to one per HTML response. */
  pages?: Record<string, unknown>[];
  /** Extra `datapackage.json` fields. */
  datapackage?: Record<string, unknown>;
}

const FIXED_DATE = "2026-01-01T00:00:00.000Z";

function buildRevisit(record: FixtureRecord, id: string): Buffer {
  const mime = record.mime ?? "text/html";
  const block = Buffer.from(
    `HTTP/1.1 200 OK\r\ncontent-type: ${mime}\r\n\r\n`,
    "latin1",
  );
  const target = record.revisit!;
  const refersToUri = target.refersToUri ?? record.url;
  const refersToDate = target.refersToDate ?? cdxjTsToRfc3339(record.ts);
  const head =
    "WARC/1.1\r\n" +
    `WARC-Record-ID: ${id}\r\n` +
    `WARC-Target-URI: ${record.url}\r\n` +
    `WARC-Date: ${cdxjTsToRfc3339(record.ts)}\r\n` +
    "WARC-Type: revisit\r\n" +
    "WARC-Profile: http://netpreserve.org/warc/1.1/revisit/identical-payload-digest\r\n" +
    `WARC-Refers-To: ${target.refersToId}\r\n` +
    `WARC-Refers-To-Target-URI: ${refersToUri}\r\n` +
    `WARC-Refers-To-Date: ${refersToDate}\r\n` +
    "Content-Type: application/http; msgtype=response\r\n" +
    `WARC-Payload-Digest: ${payloadDigest(Buffer.alloc(0))}\r\n` +
    `Content-Length: ${block.length}\r\n` +
    "\r\n";
  return Buffer.concat([
    Buffer.from(head, "latin1"),
    block,
    Buffer.from("\r\n\r\n", "latin1"),
  ]);
}

/** Write a WACZ holding `records` (plus optional extra WARC streams). */
export function buildFixture(
  filePath: string,
  records: FixtureRecord[],
  opts: FixtureOptions = {},
): void {
  const streams = [
    { path: opts.warcPath ?? "archive/data.warc.gz", records },
    ...(opts.additionalStreams ?? []),
  ];
  const title = opts.title ?? "fixture";
  const indexLines: string[] = [];
  const warcStreams: { path: string; data: Buffer }[] = [];
  const autoPages: Record<string, unknown>[] = [];

  for (const stream of streams) {
    const basename = stream.path.split("/").pop() ?? "data.warc.gz";
    const members: Buffer[] = [];
    let offset = 0;

    if (opts.withWarcinfo !== false) {
      const warcinfo = buildWarcinfoRecord({
        recordId: `<urn:uuid:${crypto.randomUUID()}>`,
        dateRfc3339: FIXED_DATE,
        warcFilename: `${basename}#/${stream.path}`,
        software: SOFTWARE,
        isPartOf: title,
      });
      const member = zlib.gzipSync(warcinfo);
      members.push(member);
      offset += member.length;
    }

    for (const record of stream.records) {
      const id = record.id ?? `<urn:uuid:${crypto.randomUUID()}>`;
      const mime = record.mime ?? "text/html";
      const body = Buffer.from(record.body ?? "", "utf8");
      const member = zlib.gzipSync(
        record.revisit
          ? buildRevisit(record, id)
          : buildWarcRecord({
              recordId: id,
              targetUri: record.url,
              dateRfc3339: cdxjTsToRfc3339(record.ts),
              response: {
                status: record.status ?? 200,
                statusText: "",
                headers: record.headers ?? [["content-type", mime]],
                body,
              },
            }),
      );
      indexLines.push(
        `${surtKey(record.url)} ${record.ts} ${JSON.stringify({
          url: record.url,
          digest: payloadDigest(body),
          mime: record.revisit ? "warc/revisit" : mime,
          offset,
          length: member.length,
          status: record.status ?? 200,
          filename: basename,
        })}`,
      );
      members.push(member);
      offset += member.length;

      if (!record.revisit && /html/i.test(mime) && opts.pages === undefined) {
        autoPages.push({
          url: record.url,
          ts: cdxjTsToRfc3339(record.ts),
          title: record.url,
        });
      }
    }

    warcStreams.push({ path: stream.path, data: Buffer.concat(members) });
  }

  const pageList = opts.pages ?? autoPages;
  const pagesText =
    [{ format: "json-pages-1.0", id: "pages", title: "All Pages" }, ...pageList]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const pagesBuf = Buffer.from(pagesText, "utf8");
  const cdx = Buffer.from(indexLines.join("\n") + "\n", "utf8");

  const resources = [
    resource("pages.jsonl", "pages/pages.jsonl", pagesBuf),
    ...warcStreams.map((warc) =>
      resource(
        warc.path.split("/").pop() ?? "data.warc.gz",
        warc.path,
        warc.data,
      ),
    ),
    resource("index.cdx", "indexes/index.cdx", cdx),
  ];
  const datapackage = {
    profile: "data-package",
    wacz_version: "1.1.1",
    software: SOFTWARE,
    title,
    created: FIXED_DATE,
    resources,
    ...(opts.datapackage ?? {}),
  };
  const datapackageBuf = Buffer.from(
    JSON.stringify(datapackage, null, 2) + "\n",
    "utf8",
  );
  const digestBuf = Buffer.from(
    JSON.stringify(
      {
        path: "datapackage.json",
        hash:
          "sha256:" +
          crypto.createHash("sha256").update(datapackageBuf).digest("hex"),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const zipEntries: ZipWriteEntry[] = [
    { name: "datapackage.json", data: datapackageBuf, method: "deflate" },
    { name: "datapackage-digest.json", data: digestBuf, method: "deflate" },
    { name: "pages/pages.jsonl", data: pagesBuf, method: "deflate" },
    ...warcStreams.map((warc) => ({
      name: warc.path,
      data: warc.data,
      method: "store" as const,
    })),
    { name: "indexes/index.cdx", data: cdx, method: "store" },
  ];
  writeZipFile(filePath, zipEntries);
}

export interface ReadFixtureRecord {
  entry: CdxjEntry;
  record: WarcRecord;
  /** The gzip member, verbatim. */
  raw: Buffer;
}

export interface ReadFixture {
  title: string;
  entries: CdxjEntry[];
  records: ReadFixtureRecord[];
  pages: Record<string, unknown>[];
  /** The `data.warc.gz` stream, verbatim. */
  warc: Buffer;
  datapackage: Record<string, unknown>;
}

/** Read a WACZ back for assertions. */
export function readFixture(filePath: string): ReadFixture {
  const zip = ZipReader.open(filePath);
  try {
    const names = zip.names();
    const indexPath = names.find(
      (name) => name.endsWith(".cdx") && !name.endsWith(".cdx.gz"),
    );
    if (!indexPath) throw new Error("fixture has no CDX index");
    const warcPath = names.find(
      (name) => name.endsWith(".warc") || name.endsWith(".warc.gz"),
    );
    if (!warcPath) throw new Error("fixture has no WARC");
    const warc = zip.readEntry(warcPath);
    const entries = parseCdxj(zip.readEntry(indexPath).toString("utf8"));

    const records = entries.map((entry) => {
      const raw = zip.storedRange(warcPath, entry.offset, entry.length);
      return {
        entry,
        raw,
        record: parseWarcRecord(zlib.gunzipSync(raw)),
      };
    });

    const pages: Record<string, unknown>[] = [];
    try {
      const text = zip.readEntry("pages/pages.jsonl").toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.url === "string") pages.push(obj);
      }
    } catch {
      /* pages.jsonl is optional */
    }

    let datapackage: Record<string, unknown> = {};
    try {
      datapackage = JSON.parse(
        zip.readEntry("datapackage.json").toString("utf8"),
      );
    } catch {
      /* optional */
    }

    return {
      title: typeof datapackage.title === "string" ? datapackage.title : "",
      entries,
      records,
      pages,
      warc,
      datapackage,
    };
  } finally {
    zip.close();
  }
}
