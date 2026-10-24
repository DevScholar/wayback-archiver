import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  restoreArchive,
  logPathFor,
  type Args,
} from "../src/cli/wayback-machine-restorer.js";
import { RunLog } from "../src/lib/run-log.js";
import { buildFixture } from "./wacz-fixture.js";

// A restore takes long enough that the terminal which ran it is often gone
// before the result is examined, so the run's decisions also go to a log file.
// These tests read that file: the console block, a per-snapshot line, a local
// reuse decision, a failed fetch, and the closing summary.

test("the log path follows the input archive's stem", () => {
  const input = path.join("some", "dir", "xp-cn-2001.wacz");
  assert.equal(
    logPathFor(input),
    path.join("some", "dir", "xp-cn-2001-restored.log"),
  );
  assert.equal(
    logPathFor(input, "elsewhere.log"),
    path.resolve("elsewhere.log"),
  );
});

test("a restore run writes its decisions into the log file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-restore-log-"));
  const input = path.join(dir, "tiny.wacz");
  buildFixture(input, [
    {
      url: "https://web.archive.org/web/20010101000000im_/http://example.com/a.gif",
      ts: "20260101000000000",
      mime: "image/gif",
      body: "GIF89a",
    },
    {
      url: "https://web.archive.org/web/20010101000000/http://example.com/",
      ts: "20260101000000001",
      mime: "text/html",
      body: "<html>hello</html>",
    },
  ]);

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

  const text = fs.readFileSync(args.logFile, "utf8");
  assert.match(text, /=== Wayback Restorer ===/);
  assert.match(
    text,
    /SNAPSHOT http:\/\/example\.com\/a\.gif ts=20010101000000 mods=im_/,
  );
  assert.match(text, /REUSE OK 200 http:\/\/example\.com\/a\.gif/);
  assert.match(
    text,
    /\[1\] FAIL offline \(no network access\) \| http:\/\/example\.com\/ \(left as-is\)/,
  );
  assert.match(
    text,
    /fetch https:\/\/web\.archive\.org\/web\/20010101000000id_\/http:\/\/example\.com\/ \(ts=20010101000000\) failed: offline/,
  );
  assert.match(
    text,
    /summary: snapshots=2 alreadyRestored=0 reusedLocally=1 fetched=1 promoted=0 restored=1 shifted=0 failed=1 carried=1/,
  );
  assert.match(text, /=== Done ===/);
  assert.ok(fs.existsSync(args.outputFile));
});
