/**
 * args.ts
 *
 * The restorer's command line: which archive to read, where the restored
 * archive and the run log go, how many fetches to run at once, and how to
 * treat a snapshot that cannot be restored.
 */

import * as path from "path";

export interface Args {
  input: string;
  outputFile: string;
  /** Where the run log goes; defaults to `<input stem>-restored.log` next to
   * the input archive. */
  logFile: string;
  title?: string;
  concurrency: number;
  userAgent?: string;
  accept?: string;
  acceptLanguage?: string;
  /** Delay (ms) between slow-queue requests, and the backoff unit for a 429. */
  rateLimitDelay: number;
  /** Extra attempts beyond the first for a URL that keeps answering 429. */
  max429Retries: number;
  /** Fail every fetch immediately without opening a socket (for offline runs). */
  offline: boolean;
  /** Omit unrestored Wayback replay records from the output, leaving only
   * historical records and non-replay content. */
  dropUnrestored: boolean;
}

export const USAGE =
  'Usage: npx tsx src/cli/wayback-machine-restorer.ts <archive.wacz> [--output-file <out.wacz>] [--log-file <path>] [--title <t>] [--concurrency 8] [--user-agent "..."] [--rate-limit-delay 3000] [--max-429-retries 3] [--offline] [--drop-unrestored]';

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: "",
    outputFile: "",
    logFile: "",
    concurrency: 8,
    rateLimitDelay: 3000,
    max429Retries: 3,
    offline: false,
    dropUnrestored: false,
  };
  const positional: string[] = [];

  // `--flag value` (space-separated) and `--flag=value` are both accepted.
  // For a space-separated flag that expects a value, the next argv token is
  // its value unless it looks like another flag.
  const VALUE_FLAGS = new Set([
    "--output-file",
    "--log-file",
    "--title",
    "--concurrency",
    "--user-agent",
    "--accept",
    "--accept-language",
    "--rate-limit-delay",
    "--max-429-retries",
  ]);
  const takeValue = (i: number): { val: string; next: number } => {
    const eq = argv[i].indexOf("=");
    if (eq >= 0) return { val: argv[i].slice(eq + 1), next: i };
    const nxt = argv[i + 1];
    if (nxt !== undefined && !nxt.startsWith("--"))
      return { val: nxt, next: i + 1 };
    return { val: "", next: i };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    let val = eq >= 0 ? a.slice(eq + 1) : "";
    if (eq < 0 && VALUE_FLAGS.has(key)) {
      const r = takeValue(i);
      val = r.val;
      i = r.next;
    }

    if (key === "--output-file") args.outputFile = val;
    else if (key === "--log-file") args.logFile = val;
    else if (key === "--title") args.title = val;
    else if (key === "--concurrency") args.concurrency = parseInt(val, 10) || 8;
    else if (key === "--user-agent") args.userAgent = val;
    else if (key === "--accept") args.accept = val;
    else if (key === "--accept-language") args.acceptLanguage = val;
    else if (key === "--rate-limit-delay")
      args.rateLimitDelay = parseInt(val, 10) || 3000;
    else if (key === "--max-429-retries")
      args.max429Retries = parseInt(val, 10) || 3;
    else if (key === "--offline") args.offline = true;
    else if (key === "--drop-unrestored") args.dropUnrestored = true;
    else if (!a.startsWith("--")) positional.push(a);
  }
  if (positional.length > 0) args.input = path.resolve(positional[0]);
  if (!args.input) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!args.outputFile) {
    const base = path.basename(args.input).replace(/\.wacz$/i, "");
    args.outputFile = path.join(
      path.dirname(args.input),
      base + "-restored.wacz",
    );
  }
  args.logFile = logPathFor(args.input, args.logFile);
  return args;
}

/**
 * Where a run's log goes: `<input stem>-restored.log` next to the input archive,
 * the same name the default output would take. `--log-file` overrides it. The
 * log is appended to, so repeated runs of one archive leave a history in one
 * file.
 */
export function logPathFor(inputFile: string, logFile?: string): string {
  if (logFile) return path.resolve(logFile);
  const stem = path.basename(inputFile).replace(/\.wacz$/i, "");
  return path.join(path.dirname(inputFile), stem + "-restored.log");
}
