/**
 * network-pass.ts
 *
 * Restoring snapshots by fetching their `id_` identity route from the Wayback
 * Machine: a normal pool at full concurrency, plus a slow queue that drains the
 * URLs that answered 429 one at a time with backoff.
 */

import type { WaybackTarget } from "../lib/wayback.js";
import { sleep } from "../lib/http.js";
import type { RunLog } from "../lib/run-log.js";
import { fetchOnce, type FetchedHop } from "./fetch.js";
import { buildRestoredRecords, type RestoredRecords } from "./records.js";
import { carryFailedSnapshot, type RunState } from "./state.js";
import type { InputArchive } from "./input.js";
import type { RestorePlan } from "./plan.js";

/**
 * Fetch and store every target. A chain that only shifts to a real capture
 * elsewhere (Wayback had nothing at the requested timestamp) does not restore
 * the requested snapshot itself: its input records are left as-is for a later
 * run instead of being relabelled with bytes captured at a different time.
 */
export async function restoreNetworkTargets(opts: {
  state: RunState;
  input: InputArchive;
  plan: RestorePlan;
  targets: WaybackTarget[];
  log: RunLog;
  userAgent: string;
  accept: string;
  acceptLanguage: string;
  concurrency: number;
  rateLimitDelay: number;
  max429Retries: number;
  offline: boolean;
}): Promise<void> {
  const {
    state,
    input,
    plan,
    targets,
    log,
    userAgent,
    accept,
    acceptLanguage,
    concurrency,
    rateLimitDelay,
    max429Retries,
    offline,
  } = opts;

  /** Turn one successful fetch into output records. */
  const storeOutcome = (
    target: WaybackTarget,
    hops: FetchedHop[],
  ): RestoredRecords => {
    const batch = buildRestoredRecords({
      target,
      hops,
      storedKeys: state.storedKeys,
      titleByInnerUrl: input.titleByInnerUrl,
      userAgent,
      accept,
      acceptLanguage,
      identifiedTypeBySnapshot: input.identifiedTypeBySnapshot,
    });
    state.kept.push(...batch.records);
    state.keptPages.push(...batch.pages);
    return batch;
  };

  /** The redirect chain of one fetch, file only: every hop, with the status and
   * type it answered. A timestamp shift is visible here as the hop that landed
   * on another `/web/<ts>/` URL, and a failure as the hop that never arrived. */
  const noteFetch = (target: WaybackTarget, hops: FetchedHop[]): void => {
    log.note(`FETCH ${target.idUrl} requested ts=${target.ts14}`);
    for (const hop of hops) {
      const type =
        hop.headers.find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1] ?? "(no content-type)";
      log.note(`  HOP ${hop.status} ${type} ${hop.body.length}B ${hop.url}`);
    }
  };

  // Normal pool: one attempt per URL, at full concurrency. A 429 is set
  // aside on the rate-limit list rather than retried in-place.
  const slowQueue: { target: WaybackTarget; retries: number }[] = [];
  let cursor = 0;

  const worker = async (id: number): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) break;
      const t = targets[i];
      const outcome = await fetchOnce(
        t.idUrl,
        userAgent,
        accept,
        acceptLanguage,
        offline,
      );
      if (outcome.kind === "rate-limited") {
        slowQueue.push({ target: t, retries: 0 });
        log.line(`[${id}] RATE-LIMITED ${t.innerUrl}`);
        continue;
      }
      if (outcome.kind === "error") {
        state.failed++;
        carryFailedSnapshot(state, input, plan, t);
        log.line(
          `[${id}] FAIL ${outcome.message} | ${t.innerUrl} (left as-is)`,
        );
        log.note(
          `  fetch ${t.idUrl} (ts=${t.ts14}) failed: ${outcome.message}`,
        );
        continue;
      }
      noteFetch(t, outcome.hops);
      const batch = storeOutcome(t, outcome.hops);
      if (batch.wroteTarget) {
        state.ok++;
        log.line(`[${id}] OK ${batch.lastStatus} ${t.innerUrl}`);
      } else if (batch.records.length > 0) {
        // Wayback answered with a timestamp shift: the bytes are real,
        // but they belong to another capture, so they are stored under
        // that capture's own time and this snapshot is left as-is.
        state.shifted++;
        carryFailedSnapshot(state, input, plan, t);
        log.line(
          `[${id}] SHIFT ${batch.lastStatus} ${t.innerUrl} (no capture at ${t.ts14}; nearest capture stored at ${batch.lastTs14}) (left as-is)`,
        );
        log.note(
          `  shift stored at ${batch.lastTs14}; playbackRedirects=${batch.skippedPlaybackRedirects} errorPages=${batch.skippedErrorPages}`,
        );
      } else if (batch.skippedAlreadyStored > 0) {
        // The redirect led to a capture another chain had already
        // stored, so no new record was written, but the bytes are in
        // the archive at their own time.
        state.shifted++;
        carryFailedSnapshot(state, input, plan, t);
        log.line(
          `[${id}] SHIFT ${t.innerUrl} (no capture at ${t.ts14}; nearest capture already in the archive at ${batch.alreadyStoredTs14}) (left as-is)`,
        );
      } else {
        state.failed++;
        carryFailedSnapshot(state, input, plan, t);
        log.line(
          `[${id}] SKIP ${t.innerUrl} (no historical capture) (left as-is)`,
        );
        log.note(
          `  no record kept; playbackRedirects=${batch.skippedPlaybackRedirects} errorPages=${batch.skippedErrorPages}`,
        );
      }
    }
  };

  const threads: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) threads.push(worker(i + 1));
  await Promise.all(threads);

  // Slow queue: drain one at a time, with backoff on repeated 429s, so the
  // rate-limited URLs retry at a gentler pace than the normal pool.
  if (slowQueue.length > 0) {
    log.line(
      `\nDraining ${slowQueue.length} rate-limited URL(s) at ${rateLimitDelay}ms...\n`,
    );
  }
  while (slowQueue.length > 0) {
    const item = slowQueue.shift()!;
    const outcome = await fetchOnce(
      item.target.idUrl,
      userAgent,
      accept,
      acceptLanguage,
      offline,
    );
    if (outcome.kind === "rate-limited") {
      if (item.retries < max429Retries) {
        item.retries++;
        slowQueue.push(item);
        log.line(
          `SLOW retry ${item.retries}/${max429Retries} (backing off ${rateLimitDelay * item.retries}ms) ${item.target.innerUrl}`,
        );
        await sleep(rateLimitDelay * item.retries);
      } else {
        state.failed++;
        carryFailedSnapshot(state, input, plan, item.target);
        log.line(
          `FAIL gave up after ${max429Retries} rate-limit retries | ${item.target.innerUrl} (left as-is)`,
        );
      }
      continue;
    }
    if (outcome.kind === "error") {
      state.failed++;
      carryFailedSnapshot(state, input, plan, item.target);
      log.line(
        `SLOW FAIL ${outcome.message} | ${item.target.innerUrl} (left as-is)`,
      );
      log.note(
        `  fetch ${item.target.idUrl} (ts=${item.target.ts14}) failed: ${outcome.message}`,
      );
      continue;
    }
    noteFetch(item.target, outcome.hops);
    const batch = storeOutcome(item.target, outcome.hops);
    if (batch.wroteTarget) {
      state.ok++;
      log.line(`SLOW OK ${batch.lastStatus} ${item.target.innerUrl}`);
    } else if (batch.records.length > 0) {
      state.shifted++;
      carryFailedSnapshot(state, input, plan, item.target);
      log.line(
        `SLOW SHIFT ${batch.lastStatus} ${item.target.innerUrl} (no capture at ${item.target.ts14}; nearest capture stored at ${batch.lastTs14}) (left as-is)`,
      );
      log.note(
        `  shift stored at ${batch.lastTs14}; playbackRedirects=${batch.skippedPlaybackRedirects} errorPages=${batch.skippedErrorPages}`,
      );
    } else if (batch.skippedAlreadyStored > 0) {
      state.shifted++;
      carryFailedSnapshot(state, input, plan, item.target);
      log.line(
        `SLOW SHIFT ${item.target.innerUrl} (no capture at ${item.target.ts14}; nearest capture already in the archive at ${batch.alreadyStoredTs14}) (left as-is)`,
      );
    } else {
      state.failed++;
      carryFailedSnapshot(state, input, plan, item.target);
      log.line(
        `SLOW SKIP ${item.target.innerUrl} (no historical capture) (left as-is)`,
      );
      log.note(
        `  no record kept; playbackRedirects=${batch.skippedPlaybackRedirects} errorPages=${batch.skippedErrorPages}`,
      );
    }
    await sleep(rateLimitDelay);
  }
}
