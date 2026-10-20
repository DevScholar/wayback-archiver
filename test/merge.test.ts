import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mergeArchives } from "../src/cli/merge.js";
import { buildFixture, readFixture } from "./wacz-fixture.js";

// merge rewrites offsets and the WARC file name, then copies record bytes
// verbatim. These run on small real WACZ files built by wacz-fixture.ts.

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wacz-merge-"));
}

const quiet = (): void => {};

test("merging two archives keeps every record and resolves each to its body", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(first, [
      { url: "http://a.example/one", ts: "19980101000000000", body: "one" },
      { url: "http://a.example/two", ts: "19980101000001000", body: "two" },
    ]);
    buildFixture(second, [
      { url: "http://b.example/one", ts: "20000101000000000", body: "three" },
    ]);

    const result = mergeArchives({
      inputFiles: [first, second],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.records, 3);
    assert.equal(result.duplicateCaptures, 0);
    assert.equal(result.pages, 3);

    const merged = readFixture(output);
    assert.equal(merged.entries.length, 3);
    assert.deepEqual(
      merged.records.map((record) => record.record.body.toString()).sort(),
      ["one", "three", "two"],
    );
    // Every index line points at a range the stored WARC stream actually has.
    for (const entry of merged.entries) {
      assert.ok(entry.offset >= 0);
      assert.ok(entry.offset + entry.length <= merged.warc.length);
      assert.equal(entry.filename, "data.warc.gz");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("un-indexed members (the warcinfo block) are carried over in place", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(first, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "one" },
    ]);
    buildFixture(second, [
      { url: "http://b.example/y", ts: "20000101000000000", body: "two" },
    ]);

    mergeArchives({
      inputFiles: [first, second],
      outputFile: output,
      log: quiet,
    });

    const firstRead = readFixture(first);
    const secondRead = readFixture(second);
    const merged = readFixture(output);

    // Nothing is filtered here, so the merged stream is the two inputs' streams
    // one after the other, byte for byte.
    assert.ok(
      merged.warc.equals(Buffer.concat([firstRead.warc, secondRead.warc])),
      "merged WARC is the concatenation of the input streams",
    );
    // The warcinfo member sits before the first indexed record, and keeps its
    // size: the first record still starts where the input's first record did.
    const inputFirstOffset = Math.min(
      ...firstRead.entries.map((entry) => entry.offset),
    );
    const mergedFirstOffset = Math.min(
      ...merged.entries.map((entry) => entry.offset),
    );
    assert.equal(mergedFirstOffset, inputFirstOffset);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a capture the archive already holds is not stored twice", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(first, [
      { url: "http://a.example/shared", ts: "19980101000000000", body: "same" },
      {
        url: "http://a.example/only-first",
        ts: "19980101000001000",
        body: "x",
      },
    ]);
    buildFixture(second, [
      { url: "http://a.example/shared", ts: "19980101000000000", body: "same" },
      {
        url: "http://a.example/only-second",
        ts: "19980101000002000",
        body: "y",
      },
    ]);

    const result = mergeArchives({
      inputFiles: [first, second],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.records, 3);
    assert.equal(result.duplicateCaptures, 1);
    const merged = readFixture(output);
    assert.equal(
      merged.entries.filter((entry) => entry.url === "http://a.example/shared")
        .length,
      1,
    );
    // The shared capture is one page, not two.
    assert.equal(
      merged.pages.filter((page) => page.url === "http://a.example/shared")
        .length,
      1,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one URL and timestamp with different bytes keeps both records", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(first, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v1" },
    ]);
    buildFixture(second, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "v2" },
    ]);

    const result = mergeArchives({
      inputFiles: [first, second],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.records, 2);
    assert.equal(result.duplicateCaptures, 0);
    assert.deepEqual(
      readFixture(output)
        .records.map((record) => record.record.body.toString())
        .sort(),
      ["v1", "v2"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("merging the same archive twice is idempotent", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "one.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "one" },
      { url: "http://a.example/y", ts: "19980101000001000", body: "two" },
    ]);
    const inputRead = readFixture(input);

    const result = mergeArchives({
      inputFiles: [input, input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.records, inputRead.entries.length);
    assert.equal(result.duplicateCaptures, inputRead.entries.length);
    const merged = readFixture(output);
    // The record stream is unchanged: every member and gap was already there.
    assert.ok(merged.warc.equals(inputRead.warc));
    assert.deepEqual(
      merged.entries.map((entry) => entry.url).sort(),
      inputRead.entries.map((entry) => entry.url).sort(),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an archive with several WARC files merges into one stream", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "multi.wacz");
    const output = path.join(directory, "merged.wacz");
    buildFixture(
      input,
      [{ url: "http://a.example/x", ts: "19980101000000000", body: "main" }],
      {
        additionalStreams: [
          {
            path: "archive/extra.warc.gz",
            records: [
              {
                url: "http://b.example/y",
                ts: "20000101000000000",
                body: "extra",
              },
            ],
          },
        ],
      },
    );

    const result = mergeArchives({
      inputFiles: [input],
      outputFile: output,
      log: quiet,
    });

    assert.equal(result.records, 2);
    const merged = readFixture(output);
    assert.equal(merged.entries.length, 2);
    for (const entry of merged.entries) {
      assert.equal(entry.filename, "data.warc.gz");
    }
    assert.deepEqual(
      merged.records.map((record) => record.record.body.toString()).sort(),
      ["extra", "main"],
    );
    // The one output WARC is stored where the reader looks for it.
    assert.ok(
      merged.datapackage.resources.some(
        (resource) =>
          (resource as Record<string, unknown>).path === "archive/data.warc.gz",
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--title names the merged archive, and the basename is the default", () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, "first.wacz");
    const second = path.join(directory, "second.wacz");
    const named = path.join(directory, "named.wacz");
    const unnamed = path.join(directory, "plain-archive.wacz");
    buildFixture(first, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "one" },
    ]);
    buildFixture(second, [
      { url: "http://b.example/y", ts: "20000101000000000", body: "two" },
    ]);

    mergeArchives({
      inputFiles: [first, second],
      outputFile: named,
      title: "Combined",
      log: quiet,
    });
    assert.equal(readFixture(named).title, "Combined");

    mergeArchives({
      inputFiles: [first, second],
      outputFile: unnamed,
      log: quiet,
    });
    assert.equal(readFixture(unnamed).title, "plain-archive");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to write over an input archive", () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, "one.wacz");
    buildFixture(input, [
      { url: "http://a.example/x", ts: "19980101000000000", body: "one" },
    ]);
    assert.throws(
      () =>
        mergeArchives({
          inputFiles: [input],
          outputFile: input,
          log: quiet,
        }),
      /refusing to overwrite an input archive/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing input is reported before anything is written", () => {
  const directory = tempDir();
  try {
    const output = path.join(directory, "merged.wacz");
    assert.throws(
      () =>
        mergeArchives({
          inputFiles: [path.join(directory, "nope.wacz")],
          outputFile: output,
          log: quiet,
        }),
      /input archive not found/,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
