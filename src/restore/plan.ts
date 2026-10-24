/**
 * plan.ts
 *
 * Deciding what a run has to do before it fetches anything: which snapshots
 * the output still lacks, which of those can be restored from bytes the input
 * already holds, which need the network, and which non-replay records are
 * carried over unchanged.
 */

import {
  parseWaybackUrl,
  hostOf,
  isArchiveOrgHost,
  type WaybackTarget,
} from "../lib/wayback.js";
import { parseCdxj, type CdxjEntry } from "../archive/cdxj.js";
import { loadExisting, type ExistingArchive } from "../archive/wacz-append.js";
import { snapshotKey } from "./records.js";
import { REUSABLE_MODIFIERS } from "./local-reuse.js";
import type { CarriedRecord } from "./carry.js";
import type { InputArchive } from "./input.js";

/** What one run will restore and carry, worked out from the input and the
 * output that already exists. */
export interface RestorePlan {
  /** One target per pending snapshot, in URL order. */
  pending: WaybackTarget[];
  /** Every snapshot's target, pending or already restored. */
  targetBySnap: Map<string, WaybackTarget>;
  /** The replay modifiers the crawler recorded per snapshot (bare, `im_`, ...). */
  modifiersBySnap: Map<string, Set<string>>;
  /** The replay route a snapshot's restoration starts from. */
  replayUrlBySnap: Map<string, string>;
  /** Every CDXJ entry per snapshot, so a failed restore can carry all of them. */
  entriesBySnap: Map<string, CdxjEntry[]>;
  /** Non-replay records carried over verbatim. */
  carried: CarriedRecord[];
  /** Snapshots whose identity bytes are already captured in the input. */
  reuseLocally: WaybackTarget[];
  /** Snapshots that must be re-fetched over the network. */
  targets: WaybackTarget[];
  /** The output archive when it already exists, so a run appends to it. */
  existing: ExistingArchive | null;
  /** Snapshots the output already holds, restored or carried. */
  existingSnapshotKeys: Set<string>;
  /** Carried records the output already holds, keyed by URL and timestamp. */
  existingCarriedKeys: Set<string>;
}

/**
 * Classify the input's records into snapshots and carried records, then keep
 * the snapshots the output lacks.
 *
 * Restore targets are keyed by *snapshot* -- the inner URL together with its
 * historical capture time. A single URL captured at several points in the past
 * (e.g. `web/1998/...` and `web/1999/...`) is several distinct resources and
 * each is restored (or carried on failure) independently, rather than
 * collapsing them to the earliest capture.
 *
 * Within one snapshot, the same URL may appear under several modifier routes
 * (bare, `im_`, `cs_`, ...); those are aggregated and restored once.
 *
 * Anything that is NOT a Wayback replay URL is carried over verbatim:
 * screenshots (`urn:thumbnail`/`urn:view`), Wayback queries (site/CDX
 * searches), other archive.org content, and resources from other sites.
 */
export function planRestore(
  input: InputArchive,
  outputFile: string,
): RestorePlan {
  const targetBySnap = new Map<string, WaybackTarget>();
  const modifiersBySnap = new Map<string, Set<string>>();
  const replayUrlBySnap = new Map<string, string>();
  const entriesBySnap = new Map<string, CdxjEntry[]>();
  const carried: CarriedRecord[] = [];

  for (const e of input.entries) {
    const wb = parseWaybackUrl(e.url);
    if (!wb) {
      // Leave as-is: copy the original member bytes and index entry.
      const c = input.carryFromEntry(e);
      if (c) carried.push(c);
      continue;
    }
    if (isArchiveOrgHost(hostOf(wb.innerUrl))) {
      // A replay of archive.org's own pages (its CDX queries, calendar
      // pages, search screens, item pages) is not a capture of the open
      // web. Leave it exactly as the input captured it: restoring it would
      // invent history, and dropping it would lose a record.
      const c = input.carryFromEntry(e);
      if (c) carried.push(c);
      continue;
    }

    const sk = snapshotKey(wb.innerUrl, wb.ts14);

    const mods = modifiersBySnap.get(sk) ?? new Set<string>();
    mods.add(wb.modifier);
    modifiersBySnap.set(sk, mods);

    if (!targetBySnap.has(sk)) {
      targetBySnap.set(sk, wb);
      replayUrlBySnap.set(sk, e.url);
    }
    const list = entriesBySnap.get(sk) ?? [];
    list.push(e);
    entriesBySnap.set(sk, list);
  }

  // Incremental: skip snapshots the output already holds. A restored record's
  // URL is its inner URL and its CDXJ timestamp is the historical capture time
  // (17 digits), so "already restored" means that inner-URL+time pair exists in
  // the output. This preserves B1 (no re-restoring an already-restored
  // snapshot) while letting B3's multiple historical snapshots of one URL each
  // be restored.
  const existing = loadExisting(outputFile);
  const existingEntries = existing
    ? parseCdxj(existing.indexLines.join("\n"))
    : [];
  const existingSnapshotKeys = new Set(
    existingEntries
      .filter((e) => !parseWaybackUrl(e.url)) // ignore carried wayback URLs
      .map((e) => snapshotKey(e.url, e.timestamp.slice(0, 14))),
  );
  // Carried records are identified by URL *and* timestamp (a URL may have
  // been captured several times), so dedupe against the output by that pair.
  const existingCarriedKeys = new Set(
    existingEntries.map((e) => `${e.url}\t${e.timestamp}`),
  );
  const pending = [...targetBySnap.values()]
    .filter((t) => !existingSnapshotKeys.has(snapshotKey(t.innerUrl, t.ts14)))
    .sort((a, b) =>
      a.innerUrl < b.innerUrl ? -1 : a.innerUrl > b.innerUrl ? 1 : 0,
    );

  // Split: a snapshot reached only via `im_`/`id_` has its identity bytes
  // already captured locally; every other snapshot must be re-fetched over the
  // network. Local reuse needs no network, so it still succeeds under
  // `--offline`; only the network fetch path is short-circuited to an instant
  // failure.
  const reuseLocally: WaybackTarget[] = [];
  const targets: WaybackTarget[] = [];
  for (const t of pending) {
    const mods =
      modifiersBySnap.get(snapshotKey(t.innerUrl, t.ts14)) ?? new Set<string>();
    const onlyReusable =
      mods.size > 0 && [...mods].every((m) => REUSABLE_MODIFIERS.has(m));
    if (onlyReusable) reuseLocally.push(t);
    else targets.push(t);
  }

  return {
    pending,
    targetBySnap,
    modifiersBySnap,
    replayUrlBySnap,
    entriesBySnap,
    carried,
    reuseLocally,
    targets,
    existing,
    existingSnapshotKeys,
    existingCarriedKeys,
  };
}
