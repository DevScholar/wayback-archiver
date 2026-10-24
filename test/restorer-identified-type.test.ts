import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentifiedTypeMap } from "../src/restore/records.js";
import type { WarcRecord } from "../src/archive/warc.js";
import { cdxEntry, warcRecord } from "./restorer-fixture.js";

// The charset a restored page declares, per snapshot, read from the input
// capture: Wayback's own guess wins over ArchiveWeb.page's identified type,
// whichever route recorded it first.

test("Wayback guessed charset wins over the ArchiveWeb.page identified type", () => {
  const bareUrl =
    "https://web.archive.org/web/19961022175327/http://a.example/page";
  const idUrl =
    "https://web.archive.org/web/19961022175327id_/http://a.example/page";
  const records = new Map<string, WarcRecord>([
    [idUrl, warcRecord({ identified: "text/html; charset=windows-1250" })],
    [
      bareUrl,
      warcRecord({
        identified: "text/html; charset=windows-1250",
        guessedType: "text/html",
        guessedCharset: "maccentraleurope",
      }),
    ],
  ]);
  const key = "http://a.example/page\t19961022175327";

  // The identified-type route comes first, then the route with Wayback's
  // guess; the guess must still win.
  const idFirst = buildIdentifiedTypeMap(
    [cdxEntry(idUrl, "19961022175327"), cdxEntry(bareUrl, "19961022175327")],
    records,
  );
  assert.equal(idFirst.get(key), "text/html; charset=maccentraleurope");

  // The same in the opposite route order.
  const bareFirst = buildIdentifiedTypeMap(
    [cdxEntry(bareUrl, "19961022175327"), cdxEntry(idUrl, "19961022175327")],
    records,
  );
  assert.equal(bareFirst.get(key), "text/html; charset=maccentraleurope");
});

test("the ArchiveWeb.page identified type is the fallback when Wayback guessed nothing", () => {
  const url =
    "https://web.archive.org/web/19961022175327id_/http://a.example/page";
  const map = buildIdentifiedTypeMap(
    [cdxEntry(url, "19961022175327")],
    new Map([
      [url, warcRecord({ identified: "text/html; charset=windows-1250" })],
    ]),
  );
  assert.equal(
    map.get("http://a.example/page\t19961022175327"),
    "text/html; charset=windows-1250",
  );
});

test("a guessed charset on a non-text snapshot is ignored by the map", () => {
  const url =
    "https://web.archive.org/web/19961022175327id_/http://a.example/pixel.gif";
  const map = buildIdentifiedTypeMap(
    [cdxEntry(url, "19961022175327")],
    new Map([
      [
        url,
        warcRecord({
          contentType: "image/gif",
          guessedType: "image/gif",
          guessedCharset: "utf-8",
        }),
      ],
    ]),
  );
  assert.equal(
    map.get("http://a.example/pixel.gif\t19961022175327"),
    undefined,
  );
});
