#!/usr/bin/env node
/**
 * export-to-html.ts
 *
 * Exports a WACZ archive into a standalone, flat folder of files that can be
 * browsed directly from the filesystem (file://) without a server.
 *
 * Naming: every extracted file is named `<prefix>~<n><ext>` where `<prefix>`
 * is the first five characters of the original file name (the URL's basename),
 * lowercased, and `<n>` is a counter that disambiguates files sharing a
 * prefix. The extension is taken from the URL when present, otherwise derived
 * from the content type (text/html -> .html, image/jpeg -> .jpg, ...),
 * otherwise omitted -- matching examples like `about~1.html`, `infor~2.asp`,
 * `cdx~1`.
 *
 * Two metadata files are written to the output root:
 *   urls.csv   -- "File Name,Timestamp,Original URLs" mapping, timestamps in
 *                WACZ-compatible RFC3339 form.
 *   wayback-index.html -- a pre-generated index page (the replay server also
 *                generates this on demand).
 *
 * The per-page screenshots (`urn:thumbnail:` and `urn:view:` records) are
 * large -- a PNG per page -- and are only used for the index-page preview, so
 * they are NOT exported by default. Pass `--with=thumbnail` (and/or
 * `--with=view`) to include them.
 *
 * Usage:
 *   npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>] [--with=thumbnail,view]
 *
 * The export itself lives under `src/export`: the naming rules in `naming`,
 * the link lookup in `links`, the metadata files in `index-files`, and the
 * work in `run`.
 */

import * as path from "path";
import { FLAT_NOT_FOUND_FILE } from "../replay/plugins.js";
import { exportArchive } from "../export/run.js";

function parseArgs(argv: string[]): {
  wacz: string;
  out: string;
  withTypes: Set<string>;
} {
  let wacz = "";
  let out = "";
  const withTypes = new Set<string>();
  const positional: string[] = [];
  const collectWith = (raw: string): void => {
    for (const t of raw.split(",")) {
      const tt = t.trim().toLowerCase();
      if (tt) withTypes.add(tt);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i] || "";
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--with") {
      collectWith(argv[++i] || "");
    } else if (a.startsWith("--with=")) {
      collectWith(a.slice("--with=".length));
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }
  if (positional.length > 0) wacz = positional[0];
  if (!wacz) {
    console.error(
      "Usage: npx tsx src/cli/export-to-html.ts <archive.wacz> [--out <dir>] [--with=thumbnail,view]",
    );
    process.exit(1);
  }
  if (!out) {
    out = path.join(
      path.dirname(path.resolve(wacz)),
      path.basename(wacz, ".wacz") + "-html",
    );
  }
  return { wacz: path.resolve(wacz), out: path.resolve(out), withTypes };
}

function main(): void {
  const {
    wacz: waczPath,
    out: outDir,
    withTypes,
  } = parseArgs(process.argv.slice(2));

  console.log("=== WACZ Export to HTML ===");
  console.log("Archive:  " + waczPath);
  console.log("Output:   " + outDir);

  const result = exportArchive({ waczPath, outDir, withTypes });

  console.log("");
  console.log("=== Export Complete ===");
  console.log(`  Files written: ${result.files}`);
  console.log(`  Skipped:       ${result.skipped}`);
  console.log("  urls.csv:      " + path.join(outDir, "urls.csv"));
  console.log(
    "  wayback-index.html:    " + path.join(outDir, "wayback-index.html"),
  );
  console.log(
    "  unarchived-message.html: " + path.join(outDir, FLAT_NOT_FOUND_FILE),
  );
}

main();
