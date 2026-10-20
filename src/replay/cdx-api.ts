/**
 * cdx-api.ts
 *
 * A Wayback-compatible view over a WACZ's CDXJ index.
 *
 * The shape follows the Internet Archive's CDX server: seven fields in the
 * order Wayback prints them (`urlkey timestamp original mimetype statuscode
 * digest length`), space-separated text by default, `output=json` as an array
 * of arrays whose first row names the fields, and the usual
 * `url` / `matchType` / `from` / `to` / `limit` / `fl` / `filter` / `collapse`
 * parameters.
 *
 * The one deliberate rule is the `digest` column. The Wayback Machine prints a
 * bare 32-character Base32 SHA-1 there, so that is what this emits: never a
 * SHA-256 value, which no Wayback client expects. When the index only carries
 * a SHA-256 digest, the caller supplies a resolver that recomputes SHA-1 from
 * the record's payload. When even that is impossible the column is empty,
 * because printing a SHA-256 value under a SHA-1 column would be a lie.
 */

import { lookupKey, surtKey } from "../lib/url.js";
import { waybackDigestOf } from "../lib/digest.js";
import type { CdxjEntry } from "../archive/cdxj.js";

/** Field names in the order the Wayback Machine prints them. */
export const CDX_FIELDS = [
  "urlkey",
  "timestamp",
  "original",
  "mimetype",
  "statuscode",
  "digest",
  "length",
] as const;

export type CdxField = (typeof CDX_FIELDS)[number];

export interface CdxQueryOptions {
  /**
   * The 32-character Base32 SHA-1 of the entry's payload, or null when it
   * cannot be determined. Called only when the index does not already carry a
   * SHA-1 digest, so such an index is answered with no record reads.
   */
  resolveSha1: (entry: CdxjEntry) => Promise<string | null>;
}

export interface CdxResponse {
  status: number;
  contentType: string;
  body: string;
}

const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

function badRequest(message: string): CdxResponse {
  return { status: 400, contentType: TEXT, body: `${message}\n` };
}

/** Wayback accepts a bare host (`example.com`) as `http://example.com/`. */
function normalizeTarget(raw: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return "http://" + raw;
}

/** Pad a `from` bound up and a `to` bound down to a 14-digit timestamp, the
 * way Wayback does, so `from=1996` means the first instant of 1996. */
function boundTimestamp(value: string | null, fill: "0" | "9"): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  return digits.padEnd(14, fill).slice(0, 14);
}

/** The parts of a query target that do not change from row to row, computed
 * once so a scan over every index entry does not re-parse the same URL. */
interface MatchTarget {
  /** The URL as given, after scheme normalization. */
  url: string;
  /** Its normalized lookup key, for an entry whose line carries no key. */
  lookup: string;
  /** Its SURT key. */
  surt: string;
  /** Its hostname reversed the way a SURT key reverses it, port removed. */
  reversedHost: string;
}

/** Strip a `:port` from the end of a reversed hostname. Reversed labels
 * themselves never contain a colon, and an IPv6 host in brackets keeps its
 * colons inside the brackets. */
function stripPort(reversed: string): string {
  return reversed.replace(/:\d+$/, "");
}

function reversedHostOfSurt(key: string): string {
  const paren = key.indexOf(")");
  return paren > 0 ? stripPort(key.slice(0, paren)) : "";
}

function prepareTarget(raw: string): MatchTarget {
  return {
    url: raw,
    lookup: lookupKey(raw),
    surt: surtKey(raw),
    reversedHost: reversedHostOfSurt(surtKey(raw)),
  };
}

/**
 * Apply `matchType`.
 *
 * Every comparison reads the index line's own SURT key rather than re-parsing
 * its URL, because this runs once per entry. `exact` is a string comparison for
 * the same reason: the key is the URL. `domain` includes every subdomain, the
 * way Wayback's does, which in reversed form means the label sequence starts
 * with the target's.
 */
function matchesTarget(
  entry: CdxjEntry,
  target: MatchTarget,
  matchType: string,
): boolean {
  switch (matchType) {
    case "prefix":
      return entry.url.startsWith(target.url);
    case "host":
      return reversedHostOfSurt(entry.key) === target.reversedHost;
    case "domain": {
      const host = reversedHostOfSurt(entry.key);
      return (
        host === target.reversedHost ||
        host.startsWith(target.reversedHost + ",")
      );
    }
    case "exact":
    default:
      if (entry.key) return entry.key === target.surt;
      return lookupKey(entry.url) === target.lookup;
  }
}

/** Field values for one index entry. `digest` is empty when unknown. */
function fieldValue(
  field: CdxField,
  entry: CdxjEntry,
  sha1: string | null,
): string {
  switch (field) {
    case "urlkey":
      return entry.key;
    case "timestamp":
      return entry.timestamp;
    case "original":
      return entry.url;
    case "mimetype":
      return entry.mime;
    case "statuscode":
      return entry.status === null ? "-" : String(entry.status);
    case "digest":
      return sha1 ?? "";
    case "length":
      return String(entry.length);
  }
}

/** Parse `fl=timestamp,original` into a validated field list. */
function parseFields(spec: string | null): CdxField[] | string {
  if (!spec) return [...CDX_FIELDS];
  const requested = spec
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return [...CDX_FIELDS];
  const known = new Set<string>(CDX_FIELDS);
  const unknown = requested.filter((f) => !known.has(f));
  if (unknown.length > 0) {
    return `unsupported field(s) in fl: ${unknown.join(", ")}. Supported: ${CDX_FIELDS.join(", ")}`;
  }
  return requested as CdxField[];
}

interface Filter {
  field: CdxField;
  negate: boolean;
  mode: "contains" | "exact" | "regex";
  expression: string;
}

/** Parse one filter clause.
 *
 * Two spellings are accepted, because the two CDX servers in circulation use
 * different ones. The Internet Archive writes `[!]field:expression`, so
 * `!statuscode:200` means "not 200". pywb writes the modifier before the
 * field, so `=mime:text/html` and `!~mime:.*html` mean exact and "not
 * matching". An optional `=` or `~` after the colon works in both.
 */
function parseFilter(spec: string): Filter | string {
  const text = spec.trim();
  let negate = false;
  let fieldName = "";
  let mode: Filter["mode"] = "contains";
  let expression = "";

  const iaStyle = /^(!)?([a-zA-Z]+):([=~])?(.*)$/.exec(text);
  if (iaStyle) {
    negate = iaStyle[1] === "!";
    fieldName = iaStyle[2];
    mode =
      iaStyle[3] === "=" ? "exact" : iaStyle[3] === "~" ? "regex" : "contains";
    expression = iaStyle[4] ?? "";
  } else {
    const pywbStyle = /^(!)?([=~])([a-zA-Z]+):(.*)$/.exec(text);
    if (!pywbStyle) return `could not parse filter: ${spec}`;
    negate = pywbStyle[1] === "!";
    mode = pywbStyle[2] === "=" ? "exact" : "regex";
    fieldName = pywbStyle[3];
    expression = pywbStyle[4] ?? "";
  }

  const field = fieldName.toLowerCase() as CdxField;
  if (!CDX_FIELDS.includes(field)) {
    return `unsupported filter field: ${fieldName}. Supported: ${CDX_FIELDS.join(", ")}`;
  }
  return { field, negate, mode, expression };
}

function applyFilter(row: Record<CdxField, string>, filter: Filter): boolean {
  const value = row[filter.field];
  let hit: boolean;
  switch (filter.mode) {
    case "exact":
      hit = value === filter.expression;
      break;
    case "regex":
      try {
        hit = new RegExp(filter.expression).test(value);
      } catch {
        hit = false;
      }
      break;
    default:
      hit = value.includes(filter.expression);
  }
  return filter.negate ? !hit : hit;
}

/**
 * Answer a CDX query over `entries`.
 *
 * `entries` must be in index order (SURT key, then timestamp); the result
 * preserves that order unless `sort=reverse` is asked for.
 */
export async function handleCdxQuery(
  entries: CdxjEntry[],
  params: URLSearchParams,
  options: CdxQueryOptions,
): Promise<CdxResponse> {
  const output = (params.get("output") ?? "text").toLowerCase();
  if (!["text", "cdx", "cdxj", "json"].includes(output)) {
    return badRequest(
      `unsupported output=${output}. Supported: text, cdx, cdxj, json.`,
    );
  }

  const rawUrl = params.get("url");
  if (!rawUrl) {
    return badRequest("url is required");
  }

  // A trailing `*` is Wayback's shorthand for a prefix match.
  const wildcard = rawUrl.endsWith("*");
  const trimmed = wildcard ? rawUrl.slice(0, -1) : rawUrl;
  const target = normalizeTarget(trimmed);
  const matchType = (
    params.get("matchType") ?? (wildcard ? "prefix" : "exact")
  ).toLowerCase();
  if (!["exact", "prefix", "host", "domain"].includes(matchType)) {
    return badRequest(
      `unsupported matchType=${matchType}. Supported: exact, prefix, host, domain.`,
    );
  }

  const fields = parseFields(params.get("fl"));
  if (typeof fields === "string") return badRequest(fields);

  const from = boundTimestamp(params.get("from"), "0");
  const to = boundTimestamp(params.get("to"), "9");

  const filters: Filter[] = [];
  for (const spec of params.getAll("filter")) {
    const parsed = parseFilter(spec);
    if (typeof parsed === "string") return badRequest(parsed);
    filters.push(parsed);
  }

  const collapse = (params.get("collapse") ?? "").toLowerCase();
  if (collapse && !["urlkey", "digest"].includes(collapse)) {
    return badRequest(
      `unsupported collapse=${collapse}. Supported: urlkey, digest.`,
    );
  }

  const sort = (params.get("sort") ?? "").toLowerCase();
  if (sort && sort !== "reverse") {
    return badRequest(`unsupported sort=${sort}. Supported: reverse.`);
  }

  let limit = Number.POSITIVE_INFINITY;
  const limitParam = params.get("limit");
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      return badRequest("limit must be a positive integer");
    }
    limit = parsed;
  }

  const matchTarget = prepareTarget(target);
  let selected = entries.filter((entry) => {
    if (!matchesTarget(entry, matchTarget, matchType)) return false;
    if (from !== null && entry.timestamp.slice(0, 14) < from) return false;
    if (to !== null && entry.timestamp.slice(0, 14) > to) return false;
    return true;
  });
  if (sort === "reverse") selected = [...selected].reverse();

  // The digest is the only column whose value can cost a record read, so work
  // out whether this query needs it before paying for it. A query that asks
  // only for timestamps and URLs reads nothing at all.
  const needsDigest =
    output === "cdxj" ||
    fields.includes("digest") ||
    filters.some((filter) => filter.field === "digest") ||
    collapse === "digest";

  const rows: { entry: CdxjEntry; sha1: string | null }[] = [];
  for (const entry of selected) {
    // An index that already stores the SHA-1 answers from itself; anything
    // else pays for one record read here.
    const sha1 = needsDigest
      ? (waybackDigestOf(entry.digest) ?? (await options.resolveSha1(entry)))
      : null;
    rows.push({ entry, sha1 });
  }

  const asRecord = (row: { entry: CdxjEntry; sha1: string | null }) =>
    Object.fromEntries(
      CDX_FIELDS.map((field) => [
        field,
        fieldValue(field, row.entry, row.sha1),
      ]),
    ) as Record<CdxField, string>;

  let filtered = filters.length
    ? rows.filter((row) => {
        const record = asRecord(row);
        return filters.every((filter) => applyFilter(record, filter));
      })
    : rows;

  if (collapse) {
    const seen = new Set<string>();
    const kept: typeof filtered = [];
    for (const row of filtered) {
      const key =
        collapse === "urlkey"
          ? row.entry.key
          : (row.sha1 ?? `@${row.entry.offset}`);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(row);
    }
    filtered = kept;
  }

  if (Number.isFinite(limit)) filtered = filtered.slice(0, limit);

  if (output === "json") {
    const out: string[][] = [[...fields]];
    for (const row of filtered) {
      out.push(fields.map((field) => fieldValue(field, row.entry, row.sha1)));
    }
    return { status: 200, contentType: JSON_TYPE, body: JSON.stringify(out) };
  }

  if (output === "cdxj") {
    const lines = filtered.map((row) => {
      const json: Record<string, unknown> = { ...row.entry.json };
      // The CDXJ digest keeps its algorithm label; only the algorithm changes.
      if (row.sha1) json.digest = `sha1:${row.sha1}`;
      return `${row.entry.key} ${row.entry.timestamp} ${JSON.stringify(json)}`;
    });
    return {
      status: 200,
      contentType: TEXT,
      body: lines.join("\n") + (lines.length ? "\n" : ""),
    };
  }

  // text and cdx are the same space-separated form Wayback prints by default.
  const lines = filtered.map((row) =>
    fields.map((field) => fieldValue(field, row.entry, row.sha1)).join(" "),
  );
  return {
    status: 200,
    contentType: TEXT,
    body: lines.join("\n") + (lines.length ? "\n" : ""),
  };
}
