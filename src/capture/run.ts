/**
 * run.ts
 *
 * One download run: read the URL list, skip what the archive already holds,
 * fetch the rest at the requested concurrency, and package the result.
 */

import * as path from "path";
import * as crypto from "crypto";
import { buildWarcRecord, payloadDigest } from "../archive/warc-writer.js";
import { nowTs17, cdxjTsToRfc3339 } from "../lib/time.js";
import { parseCdxj } from "../archive/cdxj.js";
import {
  parseWaybackUrl,
  restoreWaybackHeaders,
  type WaybackTarget,
} from "../lib/wayback.js";
import {
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT,
  DEFAULT_ACCEPT_LANGUAGE,
  buildRequestRecord,
} from "../lib/http.js";
import { isHtmlMime, loadExisting } from "../archive/wacz-append.js";
import { parseArgs, readUrlList } from "./args.js";
import { fetchUrl } from "./fetch.js";
import { extractTitle } from "./title.js";
import { writeWacz, type HopRecord, type NewRecord } from "./package.js";

/**
 * Crawl the url list into a WACZ, appending to the output if it already exists.
 *
 * Each URL is fetched once and written as a WARC 1.1 `request`/`response` pair
 * into `archive/data.warc.gz`. The `request` record records how the URL was
 * fetched -- the client identity the headers actually sent -- and the
 * `response` record carries the archived payload; the two are linked by
 * `WARC-Concurrent-To`. `indexes/index.cdx` maps SURT-key + timestamp to each
 * response record's offset/length (the request records are unindexed
 * annotations), and `pages/pages.jsonl` lists every fetched URL as an entry
 * point. Redirects are followed transparently; each hop is archived under the
 * URL that answered it.
 *
 * Incremental: if the output already exists it is treated as the existing
 * archive. URLs already captured in it are skipped (not re-fetched), and only
 * new URLs are appended -- the existing records, their offsets and timestamps
 * are preserved byte-for-byte.
 */
export async function runDownloader(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const urls = readUrlList(path.resolve(args.urlList));
  const outputFile = path.resolve(args.outputFile);
  const basename = path.basename(outputFile).replace(/\.wacz$/i, "");

  // In --wayback mode each url-list line is a Wayback replay URL; parse it to
  // its inner identity URL and the `id_` form to fetch. The "already archived"
  // check and the stored record are keyed on the inner URL (a replay URL and
  // its inner identity are the same capture), so a later incremental run over
  // the same replay list still dedupes.
  const waybackByUrl = new Map<string, WaybackTarget>();
  if (args.wayback) {
    for (const u of urls) {
      const t = parseWaybackUrl(u);
      if (t) waybackByUrl.set(u, t);
      else console.log(`warn: not a Wayback replay URL, skipping: ${u}`);
    }
  }

  const existing = loadExisting(outputFile);
  const existingUrls = new Set(
    existing ? parseCdxj(existing.indexLines.join("\n")).map((e) => e.url) : [],
  );
  const toFetch = urls.filter((u) => {
    if (args.wayback && !waybackByUrl.has(u)) return false;
    const key = args.wayback ? waybackByUrl.get(u)!.innerUrl : u;
    return !existingUrls.has(key);
  });
  const skipped = urls.length - toFetch.length;
  const title =
    args.title ?? (existing && existing.title ? existing.title : basename);
  const userAgent = args.userAgent || DEFAULT_USER_AGENT;
  const accept = args.accept || DEFAULT_ACCEPT;
  const acceptLanguage = args.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;

  console.log("=== WACZ Downloader ===");
  console.log("URL list:  " + args.urlList);
  console.log(
    "Output:    " + outputFile + (existing ? " (appending)" : " (new)"),
  );
  console.log("Title:     " + title);
  console.log("User-Agent: " + userAgent);
  console.log("Accept: " + accept);
  console.log("Accept-Language: " + acceptLanguage);
  if (args.wayback) console.log("Mode:      wayback (id_ identity capture)");
  console.log(
    `${skipped} already archived, fetching ${toFetch.length} URL(s) (concurrency ${args.concurrency})...\n`,
  );

  const newRecords: NewRecord[] = [];
  let cursor = 0;
  let ok = 0;
  let failed = 0;

  const worker = async (id: number): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= toFetch.length) break;
      const url = toFetch[i];

      // In --wayback mode `url` is a Wayback replay URL: fetch its `id_`
      // form and store the original bytes under the inner URL, stamped at
      // the *historical* capture time rather than the wall clock. The
      // request record documents the `id_` URL that was actually fetched;
      // the response records carry the inner identity.
      const target = args.wayback ? waybackByUrl.get(url) : undefined;
      const fetchTarget = target ? target.idUrl : url;
      const storeUrl = target ? target.innerUrl : url;
      const ts = target ? target.ts14 + "000" : nowTs17();
      const dateRfc3339 = cdxjTsToRfc3339(ts);

      try {
        const resp = await fetchUrl(
          fetchTarget,
          userAgent,
          accept,
          acceptLanguage,
        );
        // One response record per hop, keyed to its own URL. Generate the
        // IDs up front so the request record can reference the first hop.
        const ids = resp.hops.map(() => `<urn:uuid:${crypto.randomUUID()}>`);
        const requestRecord = buildRequestRecord(
          fetchTarget,
          ids[0],
          dateRfc3339,
          userAgent,
          accept,
          acceptLanguage,
        );
        const hops: HopRecord[] = resp.hops.map((hop, j) => {
          const rawCtype = (
            hop.headers.find(
              ([n]) => n.toLowerCase() === "content-type",
            )?.[1] || ""
          )
            .split(";")[0]
            .trim();
          // In --wayback mode the hop URL is a Wayback replay URL we
          // unwrap back to the inner identity, and its headers are
          // rebuilt from the historical `X-Archive-Orig-*` values.
          let hopUrl = hop.url;
          let headers = hop.headers;
          if (target) {
            hopUrl = parseWaybackUrl(hop.url)?.innerUrl ?? storeUrl;
            headers = restoreWaybackHeaders(
              hop.headers,
              rawCtype || "application/octet-stream",
              hop.body,
            );
          }
          const ctype = (
            headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ||
            rawCtype ||
            "application/octet-stream"
          )
            .split(";")[0]
            .trim();
          const mime = ctype || "application/octet-stream";
          const responseRecord = buildWarcRecord({
            recordId: ids[j],
            targetUri: hopUrl,
            dateRfc3339,
            response: {
              status: hop.status,
              statusText: hop.statusText,
              headers,
              body: hop.body,
            },
          });
          return {
            url: hopUrl,
            status: hop.status,
            mime,
            digest: payloadDigest(hop.body),
            responseRecord,
          };
        });
        const finalHop = resp.hops[resp.hops.length - 1];
        const finalMime = hops[hops.length - 1].mime;
        newRecords.push({
          url: storeUrl,
          ts,
          title: isHtmlMime(finalMime)
            ? extractTitle(finalHop.body)
            : undefined,
          requestRecord,
          hops,
        });
        ok++;
        console.log(`[${id}] OK ${finalHop.status} ${storeUrl}`);
      } catch (e) {
        failed++;
        // A failed fetch is not archived: the WARC record vocabulary has
        // no standard field for a capture error, so writing one would
        // mean inventing a non-standard extension (e.g. a `fetchError`
        // field) or borrowing an unrelated standard field's meaning.
        // Nothing is written for the URL, matching ArchiveWeb.page.
        let error = (e as Error)?.message || "";
        if (
          (!error || error === "AggregateError") &&
          (e as AggregateError)?.errors?.length
        ) {
          error = (e as AggregateError).errors
            .map((err) => (err as Error)?.message || String(err))
            .join("; ");
        }
        if (!error) error = String(e) || "fetch failed";
        console.log(`[${id}] FAIL ${error} | ${url}`);
      }
    }
  };

  const threads: Promise<void>[] = [];
  for (let i = 0; i < args.concurrency; i++) threads.push(worker(i + 1));
  await Promise.all(threads);

  // Workers finish out of order; sort by URL so pages.jsonl, record order,
  // and the resulting CDXJ are stable across runs (timestamps are still
  // wall-clock, but the ordering is deterministic).
  newRecords.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  console.log(`\n${ok} captured, ${failed} failed`);

  if (toFetch.length === 0) {
    if (existing && args.title === undefined) {
      console.log(
        "All URLs already archived and no title change \u2014 nothing to do.",
      );
      return;
    }
    if (!existing) {
      console.error("No URLs to archive.");
      process.exit(1);
    }
  }

  writeWacz({ outputFile, title, existing, newRecords });
  console.log("\n=== Done ===");
  console.log("Wrote " + outputFile);
}
