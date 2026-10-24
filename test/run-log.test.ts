import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RunLog } from "../src/lib/run-log.js";

function tempLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-run-log-"));
  return path.join(dir, "run.log");
}

/** Run `body` with the console quiet: these tests check the file, and the
 * console is the other half of the same call. */
function quietly(body: () => void): void {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    body();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

test("a log mirrors every line and appends across runs", () => {
  const file = tempLogPath();
  quietly(() => {
    const first = new RunLog(file);
    first.line("first run");
    first.note("detail only in the file");
    first.error("a problem");
    first.close();

    const second = new RunLog(file);
    second.line("second run");
    second.close();
  });

  assert.equal(
    fs.readFileSync(file, "utf8"),
    "first run\ndetail only in the file\na problem\nsecond run\n",
  );
});

test("closing a log twice is safe and a closed log keeps working", () => {
  const file = tempLogPath();
  quietly(() => {
    const log = new RunLog(file);
    log.line("before close");
    log.close();
    log.close();
    log.line("after close");
    log.note("not written");
  });
  assert.equal(fs.readFileSync(file, "utf8"), "before close\n");
});

test("a log that cannot be opened reports itself without failing the run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-run-log-"));
  const missing = path.join(dir, "no-such-directory", "run.log");
  quietly(() => {
    const log = new RunLog(missing);
    assert.doesNotThrow(() => log.line("still running"));
    log.close();
  });
  assert.equal(fs.existsSync(missing), false);
});
