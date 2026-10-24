/**
 * links.ts
 *
 * The lookup a flat export's rewriter uses to turn a URL reference into the
 * name of an exported file: exact key first, then same path with any query,
 * then a case-insensitive path. Redirects (301/302/...) resolve to the file of
 * their final target, so a link to a redirect source still lands on content.
 */

import type { Wacz, ResolvedRecord } from "../archive/wacz.js";
import type { CdxjEntry } from "../archive/cdxj.js";
import {
  lookupKey,
  lookupVariants,
  lookupPathKey,
  lookupKeyCi,
} from "../lib/url.js";
import { captureKey } from "./naming.js";

export interface FlatLinks {
  /** `lookupKey(url)` -> file name, including www/protocol variants. */
  byKey: Map<string, string>;
  /** scheme/host/port/path -> file name, any query: the fallback that makes a
   * cache-busted reference (theme.css?v=2) resolve to the stored variant. */
  byPath: Map<string, string>;
  /** `lookupKeyCi(url)` -> file name: case-insensitive path fallback, tried
   * last so a differently-cased reference still resolves on legacy servers
   * (old IIS) where the page and the capture disagree on path case. */
  byKeyCi: Map<string, string>;
}

/** Build the flat-file lookup for the captures that are exported. */
export function buildFlatLinks(
  wacz: Wacz,
  exported: CdxjEntry[],
  unique: CdxjEntry[],
  flatName: Map<string, string>,
): FlatLinks {
  const byKey = new Map<string, string>();
  const byPath = new Map<string, string>();
  const byKeyCi = new Map<string, string>();

  for (const e of exported) {
    const name = flatName.get(captureKey(e.url, e.timestamp.slice(0, 14)));
    if (!name) continue;
    for (const v of lookupVariants(e.url)) {
      const k = lookupKey(v);
      if (!byKey.has(k)) byKey.set(k, name);
    }
    const pk = lookupPathKey(e.url);
    if (!byPath.has(pk)) byPath.set(pk, name);
    const ck = lookupKeyCi(e.url);
    if (!byKeyCi.has(ck)) byKeyCi.set(ck, name);
  }

  // Redirects (301/302/...): the crawler stored a redirect record with a
  // `Location` header, not the final bytes. Map each redirect source URL to
  // the flat file of its final 200 target, following chains, so a link to
  // the source resolves locally instead of 404ing. The source itself is not
  // written as a file -- the browser would have followed it to the target.
  const redirectByKey = new Map<string, string>(); // lookupKey(src) -> abs target (one hop)
  for (const e of unique) {
    const s = e.status;
    if (typeof s !== "number" || s < 300 || s >= 400) continue;
    let rec: ResolvedRecord | null;
    try {
      rec = wacz.resolveRecord(e.url);
    } catch {
      continue;
    }
    if (!rec) continue;
    const loc = rec.record.httpHeaders.get("location");
    if (!loc) continue;
    let target: string;
    try {
      target = new URL(loc, e.url).href;
    } catch {
      continue;
    }
    redirectByKey.set(lookupKey(e.url), target);
  }
  const resolveRedirectChain = (url: string): string => {
    let cur = url;
    for (let i = 0; i < 8; i++) {
      const next = redirectByKey.get(lookupKey(cur));
      if (!next) break;
      cur = next;
    }
    return cur;
  };
  for (const e of unique) {
    const s = e.status;
    if (typeof s !== "number" || s < 300 || s >= 400) continue;
    const final = resolveRedirectChain(e.url);
    const name = byKey.get(lookupKey(final));
    if (!name) continue;
    for (const v of lookupVariants(e.url)) {
      const k = lookupKey(v);
      if (!byKey.has(k)) byKey.set(k, name);
    }
    const pk = lookupPathKey(e.url);
    if (!byPath.has(pk)) byPath.set(pk, name);
  }

  return { byKey, byPath, byKeyCi };
}
