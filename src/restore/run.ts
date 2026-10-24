/**
 * run.ts
 *
 * One restore run: read the input, work out what is pending, restore what the
 * input already holds, fetch the rest, then write (or append to) the output
 * archive and report what happened.
 */

import * as path from "path";
import { parseWaybackUrl } from "../lib/wayback.js";
import {
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT,
  DEFAULT_ACCEPT_LANGUAGE,
} from "../lib/http.js";
import type { RunLog } from "../lib/run-log.js";
import { readInputArchive } from "./input.js";
import { planRestore } from "./plan.js";
import { createRunState } from "./state.js";
import { restoreLocalTargets } from "./local-pass.js";
import { restoreNetworkTargets } from "./network-pass.js";
import { writeOutput } from "./write.js";
import { snapshotKey } from "./records.js";
import type { Args } from "./args.js";

/** Restore one archive. Exported for the offline log test, which runs a whole
 * restore against a fixture and reads the log it leaves behind. */
export async function restoreArchive(args: Args, log: RunLog): Promise<void> {
  const input = readInputArchive(args.input);
  if (!input) {
    log.error("Not a WACZ (missing CDX index).");
    process.exitCode = 1;
    return;
  }

  const plan = planRestore(input, args.outputFile);
  const state = createRunState(plan);

  const basename = path.basename(args.outputFile).replace(/\.wacz$/i, "");
  const title =
    args.title ??
    (plan.existing && plan.existing.title ? plan.existing.title : basename);
  const userAgent = args.userAgent || DEFAULT_USER_AGENT;
  const accept = args.accept || DEFAULT_ACCEPT;
  const acceptLanguage = args.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;

  log.line("=== Wayback Restorer ===");
  log.line("Started:   " + new Date().toISOString());
  log.line("Input:     " + args.input);
  log.line(
    "Output:    " +
      args.outputFile +
      (plan.existing ? " (appending)" : " (new)"),
  );
  log.line("Log:       " + log.filePath);
  log.line("Title:     " + title);
  log.line("User-Agent: " + userAgent);
  log.line(
    `${plan.existingSnapshotKeys.size} already restored, reusing ${plan.reuseLocally.length} locally (im_), fetching ${plan.targets.length} URL(s), carrying over ${plan.carried.length} (concurrency ${args.concurrency})...\n`,
  );

  // What the input holds for each pending snapshot, file only: its capture time,
  // the replay modifiers the crawler recorded, and the route this run starts
  // from. These lines are what explain a later "NO LOCAL BODY", "REUSE SKIP" or
  // "SHIFT" line for the same URL.
  log.note(
    `-- input: ${input.entries.length} record(s), ${plan.targetBySnap.size} snapshot(s), ${plan.pending.length} pending --`,
  );
  for (const t of plan.pending) {
    const mods = [
      ...(plan.modifiersBySnap.get(snapshotKey(t.innerUrl, t.ts14)) ?? []),
    ]
      .map((m) => m || "(bare)")
      .join(",");
    log.note(
      `SNAPSHOT ${t.innerUrl} ts=${t.ts14} mods=${mods || "(none)"} route=${plan.replayUrlBySnap.get(snapshotKey(t.innerUrl, t.ts14)) ?? t.idUrl}`,
    );
  }

  const local = restoreLocalTargets({ input, plan, state, log });
  if (local.promoted.length > 0) {
    plan.targets.push(...local.promoted);
    plan.targets.sort((a, b) =>
      a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0,
    );
    log.line(
      `promoted ${local.promoted.length} local snapshot(s) to network fetch`,
    );
  }

  await restoreNetworkTargets({
    state,
    input,
    plan,
    targets: plan.targets,
    log,
    userAgent,
    accept,
    acceptLanguage,
    concurrency: args.concurrency,
    rateLimitDelay: args.rateLimitDelay,
    max429Retries: args.max429Retries,
    offline: args.offline,
  });

  state.kept.sort((a, b) =>
    a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0,
  );

  // Carried records are deduped by URL + timestamp: a URL captured several
  // times keeps every capture. The set guards both against the output (so a
  // re-run appends only new captures) and against a URL that appears twice in
  // `carried` (a replay record carried on failure can coincide with the
  // successful-restore flow).
  const seenCarried = new Set<string>();
  const carriedToWrite = state.carried.filter((c) => {
    const key = `${c.url}\t${c.ts}`;
    if (plan.existingCarriedKeys.has(key)) return false;
    if (seenCarried.has(key)) return false;
    seenCarried.add(key);
    return true;
  });
  carriedToWrite.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // `--drop-unrestored` produces a historical-only archive: unrestored
  // Wayback replay records are omitted, while non-replay content is still
  // carried as-is. The input remains the lossless source.
  const finalCarried = args.dropUnrestored
    ? carriedToWrite.filter((c) => parseWaybackUrl(c.url) === null)
    : carriedToWrite;
  const droppedReplay = carriedToWrite.length - finalCarried.length;
  const droppedNote =
    droppedReplay > 0
      ? `, ${droppedReplay} unrestored replay record(s) dropped`
      : "";

  log.line(
    `\n${state.ok} restored, ${state.shifted} shifted to their real capture time, ${state.failed} skipped, ${finalCarried.length} carried over${droppedNote}`,
  );
  log.note(
    `summary: snapshots=${plan.targetBySnap.size} alreadyRestored=${plan.existingSnapshotKeys.size} reusedLocally=${local.reusedLocally} fetched=${plan.targets.length} promoted=${local.promoted.length} restored=${state.ok} shifted=${state.shifted} failed=${state.failed} carried=${finalCarried.length} droppedReplay=${droppedReplay}`,
  );

  if (
    state.kept.length === 0 &&
    finalCarried.length === 0 &&
    (!plan.existing || (args.title === undefined && !args.dropUnrestored))
  ) {
    if (plan.existing) {
      log.line(
        "Nothing new to add: the output already holds every record these snapshots produced.",
      );
      return;
    }
    log.error("Nothing to restore.");
    process.exitCode = 1;
    return;
  }

  // Snapshots restored this run, so dropStaleCarried can prune their stale
  // carried wayback records from the existing output (B2).
  const restoredSnapKeys = new Set(
    state.kept.map((r) => snapshotKey(r.innerUrl, r.ts17.slice(0, 14))),
  );

  writeOutput({
    outputFile: args.outputFile,
    title,
    existing: plan.existing,
    kept: state.kept,
    pages: state.keptPages,
    carried: finalCarried,
    restoredSnapKeys,
    dropUnrestored: args.dropUnrestored,
  });

  log.line("\n=== Done ===");
  log.line("Wrote " + args.outputFile);
  log.line("Log:   " + log.filePath);
}
