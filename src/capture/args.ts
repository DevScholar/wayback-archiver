/**
 * args.ts
 *
 * The downloader's command line and URL list file: what to fetch, where the
 * archive goes, which client identity to fetch with, and whether each URL is a
 * Wayback replay URL to unwrap.
 */

import * as fs from "fs";

export interface Args {
  urlList: string;
  outputFile: string;
  title?: string;
  userAgent?: string;
  accept?: string;
  acceptLanguage?: string;
  concurrency: number;
  wayback: boolean;
}

export const USAGE =
  'Usage: npx tsx src/cli/downloader.ts --url-list=my-urls.txt --output-file=my-archive.wacz [--title="My WACZ Title"] [--user-agent="..."] [--accept="..."] [--accept-language="..."] [--concurrency 8] [--wayback]';

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    urlList: "",
    outputFile: "",
    concurrency: 8,
    wayback: false,
  };
  for (const a of argv) {
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const val = eq >= 0 ? a.slice(eq + 1) : "";
    if (key === "--url-list") args.urlList = val;
    else if (key === "--output-file") args.outputFile = val;
    else if (key === "--title") args.title = val;
    else if (key === "--user-agent") args.userAgent = val;
    else if (key === "--accept") args.accept = val;
    else if (key === "--accept-language") args.acceptLanguage = val;
    else if (key === "--concurrency") args.concurrency = parseInt(val, 10) || 8;
    else if (key === "--wayback") args.wayback = true;
  }
  if (!args.urlList) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!args.outputFile) {
    console.error("Error: --output-file is required");
    process.exit(1);
  }
  return args;
}

/** Read the URL list: one URL per line, blank lines and `#` comments ignored,
 * only http/https URLs, duplicates dropped. */
export function readUrlList(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf-8");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const u = raw.trim();
    if (!u || u.startsWith("#")) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
