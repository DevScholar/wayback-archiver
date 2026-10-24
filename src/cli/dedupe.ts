#!/usr/bin/env node
/**
 * dedupe.ts
 *
 * Removes duplicate captures of one URL from a WACZ.
 *
 * Usage:
 *   npx tsx src/cli/dedupe.ts --input-files=in.wacz [--output-file=out.wacz] [--exemption-minutes=60] [--dry-run] [--title="..."]
 *
 *   --input-files        one WACZ path (repeating or comma-separating the flag
 *                        is accepted, but dedupe rewrites one archive at a
 *                        time; use merge.ts first).
 *   --output-file        destination .wacz path. Defaults to
 *                        `<input>-deduped.wacz` next to the input.
 *   --exemption-minutes  captures more than this many minutes apart are NOT
 *                        duplicates. Omit it and every record of one exact URL
 *                        collapses to one, keeping the earliest real response.
 *   --dry-run            print what would be removed, write nothing.
 *   --title              archive title. Defaults to the input's title.
 *
 * The decision about what survives is in `src/dedupe/plan`, the rewrite in
 * `src/dedupe/run`.
 */

import { parseArgv, splitList } from "../lib/args.js";
import { dedupeArchive } from "../dedupe/run.js";

const USAGE =
  'Usage: npx tsx src/cli/dedupe.ts --input-files=in.wacz [--output-file=out.wacz] [--exemption-minutes=60] [--dry-run] [--title="..."]';

export function main(argv: string[]): void {
  const parsed = parseArgv(
    argv,
    ["--input-files", "--output-file", "--title", "--exemption-minutes"],
    ["--dry-run"],
  );
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) console.error("Error: " + error);
    console.error(USAGE);
    process.exit(1);
  }
  if (parsed.positional.length > 0) {
    console.error(`Error: unexpected argument ${parsed.positional[0]}`);
    console.error(USAGE);
    process.exit(1);
  }

  const inputFiles = (parsed.values.get("--input-files") ?? []).flatMap(
    splitList,
  );
  if (inputFiles.length === 0) {
    console.error("Error: --input-files is required");
    console.error(USAGE);
    process.exit(1);
  }

  const exemptionText = (parsed.values.get("--exemption-minutes") ?? []).at(-1);
  let exemptionMinutes: number | undefined;
  if (exemptionText !== undefined) {
    exemptionMinutes = Number(exemptionText);
    if (!Number.isFinite(exemptionMinutes) || exemptionMinutes < 0) {
      console.error(
        `Error: --exemption-minutes must be a number of minutes, 0 or more: ${exemptionText}`,
      );
      console.error(USAGE);
      process.exit(1);
    }
  }

  dedupeArchive({
    inputFiles,
    outputFile: (parsed.values.get("--output-file") ?? []).at(-1),
    title: (parsed.values.get("--title") ?? []).at(-1),
    exemptionMinutes,
    dryRun: parsed.values.has("--dry-run"),
  });
}

// Run only when executed directly (not when imported by a test).
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("Fatal: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
