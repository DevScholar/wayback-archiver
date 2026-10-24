/**
 * index-files.ts
 *
 * The metadata files a flat export writes beside the extracted resources:
 * `urls.csv` mapping each file to its timestamp and original URL, the
 * pre-generated `wayback-index.html` page list, and the captive "not saved"
 * page every unsaved URL reference points at.
 */

import * as fs from "fs";
import * as path from "path";
import type { Wacz } from "../archive/wacz.js";
import {
  renderIndexPage,
  buildPageRows,
  type IndexRow,
} from "../replay/index-page.js";
import { rfc3339ToTs14 } from "../lib/time.js";
import { FLAT_NOT_FOUND_FILE } from "../replay/plugins.js";
import { renderNotFoundPage } from "../replay/not-found.js";
import { captureKey } from "./naming.js";

function csvEscape(field: string): string {
  const s = String(field);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Write `urls.csv`: "File Name,Timestamp,Original URLs", sorted by file name. */
export function writeUrlCsv(outDir: string, rows: IndexRow[]): void {
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const csvLines = ["File Name,Timestamp,Original URLs"];
  for (const r of rows) {
    csvLines.push(
      `${csvEscape(r.name)},${csvEscape(r.timestamp)},${csvEscape(r.url)}`,
    );
  }
  fs.writeFileSync(path.join(outDir, "urls.csv"), csvLines.join("\n") + "\n");
}

/**
 * Write `wayback-index.html`: the archive's pages, each linking to the flat file
 * it was exported to (or to nothing, when that capture was not exported). The
 * preview column is only built when thumbnails were exported
 * (`--with=thumbnail`), otherwise the screenshot files don't exist and the
 * column would point at nothing.
 */
export function writeIndexHtml(
  outDir: string,
  wacz: Wacz,
  flatName: Map<string, string>,
  withTypes: Set<string>,
): void {
  const pageRows = buildPageRows(
    wacz.pages,
    (url, ts) => flatName.get(captureKey(url, rfc3339ToTs14(ts))) ?? null,
    withTypes.has("thumbnail")
      ? (url, ts) => {
          const thumb = wacz.thumbnailFor(url, ts);
          return thumb
            ? (flatName.get(
                captureKey(thumb.url, thumb.timestamp.slice(0, 14)),
              ) ?? null)
            : null;
        }
      : undefined,
  );
  fs.writeFileSync(
    path.join(outDir, "wayback-index.html"),
    renderIndexPage(wacz.title, pageRows, [
      "Page",
      "Timestamp",
      "Original URL",
    ]),
  );
}

/** Write the captive "not saved" page. Every unsaved URL reference is
 * rewritten to it with the original address attached, and a tiny inline script
 * shows that address. */
export function writeFlatNotFoundPage(outDir: string): void {
  fs.writeFileSync(
    path.join(outDir, FLAT_NOT_FOUND_FILE),
    renderNotFoundPage(),
  );
}
