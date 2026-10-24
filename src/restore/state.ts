/**
 * state.ts
 *
 * The mutable result both restore passes fill in: the records to write, the
 * snapshots already stored, and the records carried over unchanged.
 */

import type { WaybackTarget } from "../lib/wayback.js";
import type { KeptRecord } from "./records.js";
import { snapshotKey } from "./records.js";
import type { CarriedRecord } from "./carry.js";
import type { InputArchive } from "./input.js";
import type { RestorePlan } from "./plan.js";

export interface RunState {
  /** Records the local and network passes restored. */
  kept: KeptRecord[];
  /** pages.jsonl entries for the restored HTML records. */
  keptPages: Record<string, unknown>[];
  /** Snapshots already stored: seeded from the output, grown by both passes.
   * De-duplication is by inner URL AND capture timestamp, so seeding it with
   * the output's own snapshots also stops a redirect target that the output
   * already holds from being written a second time. */
  storedKeys: Set<string>;
  /** Records carried over verbatim, including a failed snapshot's originals. */
  carried: CarriedRecord[];
  /** Snapshots restored for the requested capture time. */
  ok: number;
  /** Snapshots that only exist at another capture time (left as-is). */
  shifted: number;
  /** Snapshots that could not be restored (left as-is). */
  failed: number;
}

export function createRunState(plan: RestorePlan): RunState {
  return {
    kept: [],
    keptPages: [],
    storedKeys: new Set(plan.existingSnapshotKeys),
    carried: [...plan.carried],
    ok: 0,
    shifted: 0,
    failed: 0,
  };
}

/**
 * Carry a failed snapshot's original records over verbatim.
 *
 * When a snapshot cannot be restored -- a failed `id_` fetch, an exhausted
 * rate limit, or a local body that could not be resolved -- its original
 * record(s) are left untouched in the output instead of being dropped, so a
 * later run can retry the restore against a still-complete archive.
 *
 * ALL original entries are carried, not just one, so a duplicate capture is
 * preserved losslessly.
 */
export function carryFailedSnapshot(
  state: RunState,
  input: InputArchive,
  plan: RestorePlan,
  target: WaybackTarget,
): void {
  for (const entry of plan.entriesBySnap.get(
    snapshotKey(target.innerUrl, target.ts14),
  ) ?? []) {
    const c = input.carryFromEntry(entry);
    if (c) state.carried.push(c);
  }
}
