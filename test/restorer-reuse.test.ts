import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  restoreArchive,
  resolveLocalChain,
  logPathFor,
  type Args,
} from "../src/cli/wayback-machine-restorer.js";
import { RunLog } from "../src/lib/run-log.js";
import { buildFixture, readFixture } from "./wacz-fixture.js";
import { cdxjTsToRfc3339 } from "../src/lib/time.js";
import type { WarcRecord } from "../src/archive/warc.js";

// Two local-reuse rules, both checked here against a fixture archive and
// against the records a chain is handed:
//
//   1. every capture of a replay URL is kept, so a `revisit` that names its own
//      URL still resolves to the `response` that holds the bytes;
//   2. a recorded playback redirect means the requested snapshot was never
//      captured, so the bytes are stored at the capture's own time and the
//      requested snapshot is left as-is, exactly like a network SHIFT.

function responseRecord(opts: {
  date?: string | null;
  body?: string;
  status?: number;
  mime?: string;
}): WarcRecord {
  const headers = new Map<string, string>();
  const httpHeaders = new Map<string, string>([
    ["content-type", opts.mime ?? "image/gif"],
  ]);
  return {
    warcType: "response",
    headers,
    targetUri: null,
    date: opts.date ?? null,
    contentType: opts.mime ?? "image/gif",
    httpStatus: opts.status ?? 200,
    httpStatusText: "",
    httpHeaders,
    body: Buffer.from(opts.body ?? "", "latin1"),
  };
}

function revisitRecord(refersTo: string, refersDate: string): WarcRecord {
  return {
    warcType: "revisit",
    headers: new Map<string, string>([
      ["warc-refers-to-target-uri", refersTo],
      ["warc-refers-to-date", refersDate],
    ]),
    targetUri: null,
    date: "2026-01-01T00:00:01.000Z",
    contentType: "image/gif",
    httpStatus: 200,
    httpStatusText: "",
    httpHeaders: new Map<string, string>([["content-type", "image/gif"]]),
    body: Buffer.alloc(0),
  };
}

test("a local chain follows a revisit to the record it names", () => {
  const first =
    "https://web.archive.org/web/20010101000000im_/http://example.com/a.gif";
  const second =
    "https://web.archive.org/web/20010101000000id_/http://example.com/a.gif";
  const map = new Map<string, WarcRecord[]>([
    [first, [revisitRecord(second, "2026-01-01T00:00:02.000Z")]],
    [
      second,
      [
        // An earlier capture of the same replay URL answered 404 with a body,
        // so only `WARC-Refers-To-Date` identifies the record the revisit names.
        responseRecord({
          date: "2026-01-01T00:00:00.000Z",
          status: 404,
          body: "not found",
        }),
        responseRecord({ date: "2026-01-01T00:00:02.000Z", body: "GIF89a" }),
      ],
    ],
  ]);

  const resolved = resolveLocalChain(first, map);
  assert.equal(resolved.finalUrl, second);
  assert.equal(resolved.record?.httpStatus, 200);
  assert.equal(resolved.record?.body.toString("latin1"), "GIF89a");
});

test("a local chain stops at a URL the input never captured", () => {
  const first =
    "https://web.archive.org/web/20010101000000im_/http://example.com/a.gif";
  const map = new Map<string, WarcRecord[]>([
    [
      first,
      [
        revisitRecord(
          "https://example.com/gone.gif",
          "1999-01-01T00:00:00.000Z",
        ),
      ],
    ],
  ]);

  const resolved = resolveLocalChain(first, map);
  assert.equal(resolved.record, null);
  assert.match(resolved.stopReason ?? "", /no local record for/);
});

test("a local chain does not follow a redirect the site sent", () => {
  const first =
    "https://web.archive.org/web/20010101000000im_/http://example.com/a.gif";
  const second =
    "https://web.archive.org/web/20010101000000im_/http://example.com/b.gif";
  // A replay of a real redirect carries historical headers and a rewritten
  // location, so its bytes are not identity bytes: only `id_` restores it.
  const redirect = responseRecord({ status: 301, mime: "image/gif" });
  redirect.httpHeaders.set("location", second);
  redirect.httpHeaders.set("x-archive-orig-server", "Microsoft-IIS/5.0");

  const map = new Map<string, WarcRecord[]>([
    [first, [redirect]],
    [second, [responseRecord({ body: "GIF89a" })]],
  ]);

  const resolved = resolveLocalChain(first, map);
  assert.equal(resolved.record, redirect);
  assert.equal(resolved.finalUrl, first);
  assert.match(resolved.stopReason ?? "", /redirect the site sent/);
});

async function restoreOffline(
  dir: string,
  input: string,
  records: Parameters<typeof buildFixture>[1],
): Promise<{ args: Args; logText: string; output: string }> {
  buildFixture(input, records);
  const args: Args = {
    input,
    outputFile: path.join(dir, "tiny-restored.wacz"),
    logFile: logPathFor(input),
    concurrency: 2,
    rateLimitDelay: 1,
    max429Retries: 0,
    offline: true,
    dropUnrestored: false,
  };
  const log = new RunLog(args.logFile);
  try {
    await restoreArchive(args, log);
  } finally {
    log.close();
  }
  return {
    args,
    logText: fs.readFileSync(args.logFile, "utf8"),
    output: args.outputFile,
  };
}

test("a snapshot captured as a revisit still reuses its local body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-reuse-"));
  const input = path.join(dir, "tiny.wacz");
  const url =
    "https://web.archive.org/web/20010101000000im_/http://example.com/ok.gif";

  const { logText, output } = await restoreOffline(dir, input, [
    {
      url,
      ts: "20260101000000000",
      mime: "image/gif",
      body: "GIF89a",
      id: "<urn:uuid:ok-response>",
    },
    {
      url,
      ts: "20260101000000001",
      mime: "image/gif",
      revisit: {
        refersToId: "<urn:uuid:ok-response>",
        refersToDate: cdxjTsToRfc3339("20260101000000000"),
      },
    },
  ]);

  const archive = readFixture(output);
  assert.equal(archive.entries.length, 1);
  assert.equal(archive.entries[0].url, "http://example.com/ok.gif");
  assert.equal(archive.entries[0].timestamp, "20010101000000000");
  assert.equal(archive.records[0].record.body.toString("latin1"), "GIF89a");
  assert.equal(
    archive.records[0].record.date,
    "2001-01-01T00:00:00.000Z",
    "the restored record is stamped with the historical capture time",
  );

  assert.match(logText, /REUSE OK 200 http:\/\/example\.com\/ok\.gif/);
  assert.match(
    logText,
    /reusedLocally=1 fetched=0 promoted=0 restored=1 shifted=0 failed=0 carried=0/,
  );
});

test("a recorded playback redirect stores the bytes at their own time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-shift-"));
  const input = path.join(dir, "tiny.wacz");
  const requested =
    "https://web.archive.org/web/20010101000000im_/http://example.com/pic.gif";
  const capture =
    "https://web.archive.org/web/20020202000000im_/http://example.com/pic.gif";

  const { logText, output } = await restoreOffline(dir, input, [
    {
      url: requested,
      ts: "20260101000000000",
      mime: "image/gif",
      status: 302,
      headers: [
        ["content-type", "image/gif"],
        ["location", capture],
      ],
    },
    {
      url: capture,
      ts: "20260101000000001",
      mime: "image/gif",
      body: "GIF89a",
    },
  ]);

  const archive = readFixture(output);
  const stored = archive.records.find(
    (item) => item.entry.url === "http://example.com/pic.gif",
  );
  assert.equal(stored?.entry.timestamp, "20020202000000000");
  assert.equal(stored?.record.body.toString("latin1"), "GIF89a");
  assert.equal(
    stored?.record.date,
    "2002-02-02T00:00:00.000Z",
    "the shifted bytes keep the capture time they really have",
  );
  assert.equal(
    archive.entries.some(
      (entry) =>
        entry.url === "http://example.com/pic.gif" &&
        entry.timestamp === "20010101000000000",
    ),
    false,
    "nothing is stored under the time that had no capture",
  );
  assert.ok(
    archive.entries.some((entry) => entry.url === requested),
    "the requested snapshot is carried over unchanged for a later run",
  );

  assert.match(
    logText,
    /SHIFT 200 http:\/\/example\.com\/pic\.gif \(no capture at 20010101000000; recorded playback redirect leads to 20020202000000 at http:\/\/example\.com\/pic\.gif\)/,
  );
  assert.match(
    logText,
    /reusedLocally=1 fetched=0 promoted=0 restored=1 shifted=1 failed=0 carried=1/,
  );
});
