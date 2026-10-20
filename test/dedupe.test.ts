import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dedupeArchive } from "../src/cli/dedupe.js";
import { buildFixture, readFixture } from "./wacz-fixture.js";

// dedupe groups records by exact URL, clusters them by capture time, and keeps
// one record per cluster. These run on small real WACZ files built by
// wacz-fixture.ts.

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wacz-dedupe-"));
}

const quiet = (): void => {};

test("the same exact URL collapses to its earliest response", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
      { url: "http://a.example/x", ts: "19980101000001000", body: "v2" },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.recordsBefore, 2);
    assert.equal(result.recordsAfter, 1);
    assert.equal(result.dropped, 1);
    assert.equal(result.urlsReduced, 1);
    const read = readFixture(output);
    assert.equal(read.entries.length, 1);
    assert.equal(read.records[0].record.body.toString(), "v1");
    // The page entry of the dropped capture goes with it.
    assert.equal(read.pages.length, 1);
    assert.equal(read.pages[0].url, "http://a.example/x");
    assert.equal(read.pages[0].ts, "1998-01-01T00:00:00.000Z");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("URLs that differ only by query string, trailing slash or case are kept apart", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      { url: "http://a.example/x?a=1", ts: "19980101000000000", body: "one" },
      { url: "http://a.example/x?a=2", ts: "19980101000001000", body: "two" },
      { url: "http://a.example/x", ts: "19980101000002000", body: "three" },
      { url: "http://a.example/x/", ts: "19980101000003000", body: "four" },
      { url: "http://a.example/X", ts: "19980101000004000", body: "five" },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.dropped, 0);
    assert.equal(result.recordsAfter, 5);
    assert.equal(readFixture(output).entries.length, 5);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the exemption window keeps captures that are farther apart", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const collapsed = path.join(directory, "collapsed.wacz");
    const protectedOut = path.join(directory, "protected.wacz");
    buildFixture(input, [
      // Ten minutes apart: inside a 60 minute window.
      { url: "http://a.example/near", ts: "19980101000000000", body: "n1" },
      { url: "http://a.example/near", ts: "19980101001000000", body: "n2" },
      // Two hours apart: outside a 60 minute window.
      { url: "http://a.example/far", ts: "19980101000000000", body: "f1" },
      { url: "http://a.example/far", ts: "19980101020000000", body: "f2" },
    ]);

    const withWindow = dedupeArchive({
      inputFiles: [input],
      outputFile: protectedOut,
      exemptionMinutes: 60,
      log: quiet,
    });
    assert.equal(withWindow.recordsAfter, 3); // near collapses, far stays
    assert.deepEqual(
      readFixture(protectedOut)
        .records.map((record) => record.record.body.toString())
        .sort(),
      ["f1", "f2", "n1"],
    );

    const withoutWindow = dedupeArchive({
      inputFiles: [input],
      outputFile: collapsed,
      log: quiet,
    });
    assert.equal(withoutWindow.recordsAfter, 2);
    assert.deepEqual(
      readFixture(collapsed)
        .records.map((record) => record.record.body.toString())
        .sort(),
      ["f1", "n1"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a revisit loses to the response it names", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      {
        url: "http://a.example/x",
        ts: "19980101000000000",
        id: "<urn:uuid:x1>",
        body: "payload",
      },
      {
        url: "http://a.example/x",
        ts: "19980101000001000",
        id: "<urn:uuid:x2>",
        revisit: {
          refersToId: "<urn:uuid:x1>",
          refersToUri: "http://a.example/x",
          refersToDate: "1998-01-01T00:00:00Z",
        },
      },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.recordsAfter, 1);
    assert.equal(result.revisitsKept, 0);
    assert.equal(result.revisitsDropped, 1);
    const read = readFixture(output);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0].record.warcType, "response");
    assert.equal(read.records[0].record.body.toString(), "payload");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a surviving revisit keeps the record it points at", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      {
        url: "http://a.example/target",
        ts: "19980101000000000",
        id: "<urn:uuid:t1>",
        body: "same",
      },
      {
        url: "http://a.example/target",
        ts: "19980101000001000",
        id: "<urn:uuid:t2>",
        body: "same",
      },
      {
        // A single record of another URL: kept as-is, but it only replays
        // through the record it names, so that record must survive too.
        url: "http://b.example/alias",
        ts: "19980101000002000",
        id: "<urn:uuid:r1>",
        revisit: {
          refersToId: "<urn:uuid:t2>",
          refersToUri: "http://a.example/target",
          refersToDate: "1998-01-01T00:00:01Z",
        },
      },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.recordsAfter, 3);
    assert.equal(result.referentsKept, 1);
    const read = readFixture(output);
    assert.deepEqual(read.entries.map((entry) => entry.url).sort(), [
      "http://a.example/target",
      "http://a.example/target",
      "http://b.example/alias",
    ]);
    // The page entry of the protected capture stays.
    assert.deepEqual(read.pages.map((page) => page.ts).sort(), [
      "1998-01-01T00:00:00.000Z",
      "1998-01-01T00:00:01.000Z",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("kept records stay byte for byte and the un-indexed warcinfo is carried", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "keep" },
      { url: "http://a.example/x", ts: "19980101000001000", body: "drop" },
      { url: "http://b.example/y", ts: "20000101000000000", body: "other" },
    ]);
    const before = readFixture(input);

    dedupeArchive({ inputFiles: [input], outputFile: output, log: quiet });
    const after = readFixture(output);

    const gap = Math.min(...before.entries.map((entry) => entry.offset));
    assert.equal(Math.min(...after.entries.map((entry) => entry.offset)), gap);
    assert.ok(
      after.warc.subarray(0, gap).equals(before.warc.subarray(0, gap)),
      "the warcinfo member before the first record is copied unchanged",
    );
    const keptRaw = before.records.find(
      (record) => record.record.body.toString() === "keep",
    )!;
    const writtenRaw = after.records.find(
      (record) => record.record.body.toString() === "keep",
    )!;
    assert.ok(writtenRaw.raw.equals(keptRaw.raw));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an exemption window of 0 collapses only records with the same timestamp", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "first" },
      {
        url: "http://a.example/x",
        ts: "19980101000000000",
        body: "same time",
      },
      {
        url: "http://a.example/x",
        ts: "19980101000000001",
        body: "one ms later",
      },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      exemptionMinutes: 0,
      log: quiet,
    });

    assert.equal(result.recordsAfter, 2);
    assert.deepEqual(
      readFixture(output)
        .records.map((record) => record.record.body.toString())
        .sort(),
      ["first", "one ms later"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a copy of the same file with overlapping captures keeps one per URL", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    // One archive, two snapshots of one page far apart in time: with the window
    // set wide enough the tool keeps both, which is the safe setting for an
    // archive restored from the Wayback Machine.
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "1998" },
      { url: "http://a.example/x", ts: "19990101000000000", body: "1999" },
      {
        url: "http://a.example/x",
        ts: "19990101000001000",
        body: "1999 again",
      },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      exemptionMinutes: 60,
      log: quiet,
    });

    assert.equal(result.recordsAfter, 2);
    assert.deepEqual(
      readFixture(output)
        .records.map((record) => record.record.body.toString())
        .sort(),
      ["1998", "1999"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--dry-run reports the plan and writes nothing", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    const output = path.join(directory, "out.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
      { url: "http://a.example/x", ts: "19980101000001000", body: "v2" },
    ]);

    const result = dedupeArchive({
      inputFiles: [input],
      outputFile: output,
      dryRun: true,
      log: quiet,
    });

    assert.equal(result.wrote, false);
    assert.equal(result.dropped, 1);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the output defaults to <input>-deduped.wacz next to the input", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "site.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
    ]);

    dedupeArchive({ inputFiles: [input], log: quiet });

    assert.ok(fs.existsSync(path.join(directory, "site-deduped.wacz")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to write over the input archive", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
    ]);
    assert.throws(
      () =>
        dedupeArchive({
          inputFiles: [input],
          outputFile: input,
          log: quiet,
        }),
      /refusing to overwrite the input archive/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dedupe rewrites one archive at a time", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    buildFixture(first, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "one" },
    ]);
    buildFixture(second, [
      { url: "http://b.example/y", ts: "20000101000000000", body: "two" },
    ]);
    assert.throws(
      () =>
        dedupeArchive({
          inputFiles: [first, second],
          outputFile: path.join(directory, "out.wacz"),
          log: quiet,
        }),
      /dedupe rewrites one archive at a time/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a negative exemption window is rejected", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "in.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
    ]);
    assert.throws(
      () =>
        dedupeArchive({
          inputFiles: [input],
          outputFile: path.join(directory, "out.wacz"),
          exemptionMinutes: -1,
          log: quiet,
        }),
      /must be a number of minutes/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
