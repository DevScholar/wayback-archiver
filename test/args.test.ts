import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv, splitList } from "../src/lib/args.js";

// The shared argv parser used by merge and dedupe. Both spellings of a value
// flag work, a repeated flag keeps every value, and a mistake is reported
// instead of silently ignored.

test("parseArgv accepts --flag=value and --flag value", () => {
  const inline = parseArgv(["--output-file=out.wacz"], ["--output-file"]);
  assert.deepEqual(inline.values.get("--output-file"), ["out.wacz"]);
  assert.deepEqual(inline.errors, []);

  const spaced = parseArgv(["--output-file", "out.wacz"], ["--output-file"]);
  assert.deepEqual(spaced.values.get("--output-file"), ["out.wacz"]);
  assert.deepEqual(spaced.errors, []);
});

test("parseArgv keeps every occurrence of a repeated flag", () => {
  const parsed = parseArgv(
    ["--input-files=a.wacz,b.wacz", "--input-files", "c.wacz"],
    ["--input-files"],
  );
  assert.deepEqual(parsed.values.get("--input-files"), [
    "a.wacz,b.wacz",
    "c.wacz",
  ]);
  assert.deepEqual(parsed.errors, []);
});

test("parseArgv records boolean flags and positional arguments", () => {
  const parsed = parseArgv(
    ["--dry-run", "in.wacz"],
    ["--output-file"],
    ["--dry-run"],
  );
  assert.equal(parsed.values.get("--dry-run")?.length, 1);
  assert.deepEqual(parsed.positional, ["in.wacz"]);
  assert.deepEqual(parsed.errors, []);
});

test("parseArgv reports unknown flags, missing values and stray values", () => {
  assert.deepEqual(parseArgv(["--nope=1"], []).errors, [
    "unknown option --nope",
  ]);
  assert.deepEqual(parseArgv(["--title"], ["--title"]).errors, [
    "option --title needs a value",
  ]);
  assert.deepEqual(
    parseArgv(["--title", "--dry-run"], ["--title"], ["--dry-run"]).errors,
    ["option --title needs a value"],
  );
  assert.deepEqual(parseArgv(["--dry-run=1"], [], ["--dry-run"]).errors, [
    "option --dry-run takes no value",
  ]);
});

test("splitList trims parts and drops empty ones", () => {
  assert.deepEqual(splitList(" a.wacz , b.wacz ,"), ["a.wacz", "b.wacz"]);
  assert.deepEqual(splitList(""), []);
});
