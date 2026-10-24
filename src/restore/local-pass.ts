/**
 * local-pass.ts
 *
 * Restoring snapshots whose identity bytes are already captured in the input,
 * with no network request. `im_`/`oe_`/`id_` bodies are the original bytes, so
 * each is resolved through its redirect/revisit chain in the captured records
 * and written out directly.
 *
 * A record whose resolved MIME is a text type Wayback would have rewritten (an
 * HTML error page served for a missing image, say) is NOT safe to reuse, and
 * neither is a snapshot with no local body: both are promoted to the network
 * fetch, which can still serve the capture or shift to the nearest one.
 */

import { parseWaybackUrl, type WaybackTarget } from "../lib/wayback.js";
import { cdxjTsToRfc3339 } from "../lib/time.js";
import { isHtmlMime } from "../archive/wacz-append.js";
import type { WarcRecord } from "../archive/warc.js";
import type { RunLog } from "../lib/run-log.js";
import { recordFromLocal, isRewritableMime, snapshotKey } from "./records.js";
import { resolveLocalChain } from "./local-reuse.js";
import { carryFailedSnapshot, type RunState } from "./state.js";
import type { InputArchive } from "./input.js";
import type { RestorePlan } from "./plan.js";

export interface LocalPassResult {
  /** Snapshots written from their local bytes. */
  reusedLocally: number;
  /** Snapshots with no safe local body, to re-fetch over the network. */
  promoted: WaybackTarget[];
}

/** Restore every snapshot the input already holds the identity bytes for. */
export function restoreLocalTargets(opts: {
  input: InputArchive;
  plan: RestorePlan;
  state: RunState;
  log: RunLog;
}): LocalPassResult {
  const { input, plan, state, log } = opts;
  const promoted: WaybackTarget[] = [];
  let reusedLocally = 0;

  /** Write the record a local chain resolved to, under the URL and capture time
   * that chain ended on. */
  const storeLocalRecord = (
    innerUrl: string,
    ts14: string,
    record: WarcRecord,
  ): void => {
    const keptRecord = recordFromLocal(innerUrl, ts14, record);
    // Wayback's guess (from any route of this snapshot) wins over the
    // ArchiveWeb.page type the local record itself carries.
    keptRecord.identifiedPayloadType =
      input.identifiedTypeBySnapshot.get(snapshotKey(innerUrl, ts14)) ??
      keptRecord.identifiedPayloadType;
    state.kept.push(keptRecord);
    if (isHtmlMime(keptRecord.mime)) {
      state.keptPages.push({
        url: innerUrl,
        ts: cdxjTsToRfc3339((ts14 + "000").slice(0, 17)),
        title: input.titleByInnerUrl.get(innerUrl) || innerUrl,
      });
    }
  };

  for (const t of plan.reuseLocally) {
    const requestedKey = snapshotKey(t.innerUrl, t.ts14);
    const replayUrl = plan.replayUrlBySnap.get(requestedKey);
    const start = replayUrl ?? t.idUrl;
    const resolved = resolveLocalChain(start, input.recordsByReplayUrl);
    const rec = resolved.record;
    const finalTarget = parseWaybackUrl(resolved.finalUrl);
    const finalInnerUrl = finalTarget?.innerUrl ?? t.innerUrl;
    const finalTs14 = finalTarget?.ts14 ?? t.ts14;
    const localKey = snapshotKey(finalInnerUrl, finalTs14);
    log.note(
      `REUSE PROBE ${t.innerUrl} ts=${t.ts14} start=${start} -> ${resolved.finalUrl} record=${rec ? `${rec.warcType}/${rec.httpStatus ?? "no-status"}/${rec.body.length}B` : "none"}${resolved.stopReason ? ` stop=${resolved.stopReason}` : ""}`,
    );
    if (!rec || rec.body.length === 0) {
      // Nothing local to reuse. Try the identity route over the network
      // instead of giving up: Wayback can still serve the capture (or
      // shift to the nearest one), while `--offline` fails and leaves the
      // snapshot as-is exactly as before.
      promoted.push(t);
      log.line(`NO LOCAL BODY ${t.innerUrl} (fetching id_)`);
      log.note(
        `  no local body: ${resolved.stopReason ?? `${rec ? rec.warcType : "record"} at ${resolved.finalUrl} has no body`}` +
          (rec && rec.warcType === "revisit"
            ? `; it refers to ${rec.headers.get("warc-refers-to-target-uri") ?? "(no URI)"} at ${rec.headers.get("warc-refers-to-date") ?? "(no date)"}`
            : ""),
      );
      continue;
    }
    const rawCtype = (rec.httpHeaders.get("content-type") || "")
      .split(";")[0]
      .trim();
    if (isRewritableMime(rawCtype)) {
      promoted.push(t);
      log.line(
        `REUSE SKIP ${t.innerUrl} (local body is ${rawCtype || "untyped"}, Wayback rewrote it)`,
      );
      continue;
    }

    if (localKey !== requestedKey) {
      // The recorded chain ends on another capture time (or URL): a playback
      // redirect the crawler met, not a capture of the requested snapshot.
      // The bytes are kept at their own time and the requested snapshot is
      // left as-is, exactly as the network path treats a SHIFT.
      state.shifted++;
      carryFailedSnapshot(state, input, plan, t);
      if (!state.storedKeys.has(localKey)) {
        state.storedKeys.add(localKey);
        storeLocalRecord(finalInnerUrl, finalTs14, rec);
      }
      log.line(
        `SHIFT ${rec.httpStatus ?? 200} ${t.innerUrl} (no capture at ${t.ts14}; recorded playback redirect leads to ${finalTs14} at ${finalInnerUrl}) (left as-is)`,
      );
      log.note(
        `  local shift: requested ${requestedKey} -> stored ${localKey}`,
      );
      continue;
    }

    if (state.storedKeys.has(requestedKey)) {
      // A redirect chain this run already stored this snapshot; the bytes
      // are the same resource, so reuse it without a second record.
      state.ok++;
      reusedLocally++;
      log.line(
        `REUSE OK ${rec.httpStatus ?? 200} ${t.innerUrl} (already stored)`,
      );
      continue;
    }
    state.storedKeys.add(requestedKey);
    storeLocalRecord(finalInnerUrl, finalTs14, rec);
    state.ok++;
    reusedLocally++;
    log.line(`REUSE OK ${rec.httpStatus ?? 200} ${t.innerUrl}`);
    if (resolved.finalUrl !== start) {
      log.note(
        `  reuse followed a local redirect: ${start} -> ${resolved.finalUrl}`,
      );
    }
  }

  return { reusedLocally, promoted };
}
