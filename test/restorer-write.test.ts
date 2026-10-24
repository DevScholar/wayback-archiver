import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { ZipReader } from "../src/archive/zip.js";
import { parseCdxj } from "../src/archive/cdxj.js";
import { parseWarcRecord } from "../src/archive/warc.js";
import { snapshotKey } from "../src/restore/records.js";
import { writeOutput } from "../src/restore/write.js";
import { build, hop, target } from "./restorer-fixture.js";

// The restorer's write path: the records a run keeps become a WACZ whose index
// resolves each capture to its own bytes.

test("the written WACZ indexes both snapshots of one URL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-restored-"));
  const outputFile = path.join(directory, "out.wacz");
  try {
    const storedKeys = new Set<string>();
    const identified = new Map([
      ["http://a.example/x\t19980101000000", "text/html; charset=windows-1250"],
    ]);
    const kept = [];
    const pages = [];
    for (const ts14 of ["19980101000000", "19990101000000"]) {
      const result = build(
        target("http://a.example/x", ts14),
        [
          hop({
            url: `https://web.archive.org/web/${ts14}id_/http://a.example/x`,
            body: Buffer.from(ts14),
          }),
        ],
        storedKeys,
        identified,
      );
      kept.push(...result.records);
      pages.push(...result.pages);
    }

    writeOutput({
      outputFile,
      title: "test",
      existing: null,
      kept,
      pages,
      carried: [],
      restoredSnapKeys: new Set(
        kept.map((record) =>
          snapshotKey(record.innerUrl, record.ts17.slice(0, 14)),
        ),
      ),
    });

    const zip = ZipReader.open(outputFile);
    const entries = parseCdxj(
      zip.readEntry("indexes/index.cdx").toString("utf8"),
    );
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.timestamp.slice(0, 14)).sort(),
      ["19980101000000", "19990101000000"],
    );

    // Each index entry resolves to its own body.
    for (const entry of entries) {
      const record = parseWarcRecord(
        zlib.gunzipSync(
          zip.storedRange("archive/data.warc.gz", entry.offset, entry.length),
        ),
      );
      assert.equal(record.body.toString(), entry.timestamp.slice(0, 14));
      const expected = entry.timestamp.startsWith("19980101000000")
        ? "text/html; charset=windows-1250"
        : undefined;
      assert.equal(
        record.headers.get("warc-identified-payload-type"),
        expected,
      );
    }

    const pageLines = zip
      .readEntry("pages/pages.jsonl")
      .toString("utf8")
      .trim()
      .split("\n");
    assert.equal(pageLines.length, 3); // header + two pages
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
