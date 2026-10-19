import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlaybackRedirect,
  isWaybackErrorPage,
  parseWaybackUrl,
} from "../src/lib/wayback.js";

// Wayback's own redirects and error pages are 2026 retrieval artifacts, not
// historical material. These checks decide what the restorer must skip.

test("only capture routes parse as Wayback targets", () => {
  const sample = parseWaybackUrl(
    "https://web.archive.org/web/20200101000000if_/http://a.example/x",
  );
  assert.equal(sample?.ts14, "20200101000000");
  assert.equal(sample?.modifier, "if_");
  assert.equal(sample?.innerUrl, "http://a.example/x");

  assert.ok(
    parseWaybackUrl(
      "https://web.archive.org/web/20200101000000/http://a.example/x",
    ),
  );
  assert.ok(
    parseWaybackUrl(
      "https://web.archive.org/web/20200101000000im_/http://a.example/x",
    ),
  );
  assert.ok(
    parseWaybackUrl(
      "https://web.archive.org/web/20200101000000mp_/http://a.example/x",
    ),
  );
  assert.ok(
    parseWaybackUrl(
      "https://web.archive.org/web/20200101000000fr_/http://a.example/x",
    ),
  );
  // A partial timestamp (year, month, day) is still a capture request.
  assert.ok(
    parseWaybackUrl("https://web.archive.org/web/2020/http://a.example/x"),
  );

  // Everything else web.archive.org serves is not a capture: CDX queries,
  // calendar and search screens (the `*` segment), timegates, timemaps, the
  // playback API, thumbnails, and the rest of archive.org.
  for (const url of [
    "https://web.archive.org/cdx/search/cdx?url=example.com",
    "https://web.archive.org/web/2020*/http://a.example/x",
    "https://web.archive.org/web/20200101000000*/http://a.example/x",
    "https://web.archive.org/web/*/example.com",
    "https://web.archive.org/web/http://a.example/x",
    "https://web.archive.org/web/timemap/link/http://a.example/x",
    "https://web.archive.org/__wb/sparkline?output=json&url=http%3A%2F%2Fa.example%2F",
    "https://web.archive.org/thumb/a.example?generate=1",
    "https://archive.org/details/example",
    "https://archive.org/services/img/example",
  ]) {
    assert.equal(parseWaybackUrl(url), null, url);
  }
});

test("isPlaybackRedirect recognises absolute Wayback replay locations", () => {
  assert.equal(
    isPlaybackRedirect(
      "https://web.archive.org/web/19961022175327id_/http://a.example/x",
      "https://web.archive.org/",
    ),
    true,
  );
  assert.equal(
    isPlaybackRedirect(
      "https://web.archive.org/web/19961022175327/http://a.example/x",
      "https://web.archive.org/",
    ),
    true,
  );
});

test("isPlaybackRedirect resolves a relative location against its base", () => {
  assert.equal(
    isPlaybackRedirect(
      "/web/19961026001900id_/http://a.example/x",
      "https://web.archive.org/web/19961022175327id_/http://a.example/x",
    ),
    true,
  );
});

test("isPlaybackRedirect keeps era redirects to ordinary hosts", () => {
  assert.equal(
    isPlaybackRedirect("http://a.example/next", "https://web.archive.org/"),
    false,
  );
  assert.equal(
    isPlaybackRedirect("https://web.archive.org/", "https://web.archive.org/"),
    false,
  );
  assert.equal(
    isPlaybackRedirect("not a url", "https://web.archive.org/"),
    false,
  );
});

test("isWaybackErrorPage recognises the frontend error page", () => {
  const body = Buffer.from(
    "<!DOCTYPE html><html><head><title>Wayback Machine</title></head></html>",
  );
  assert.equal(
    isWaybackErrorPage(404, [["content-type", "text/html"]], body),
    true,
  );
  assert.equal(isWaybackErrorPage(503, [], body), true);
});

test("isWaybackErrorPage leaves real captures alone", () => {
  const body = Buffer.from(
    "<!DOCTYPE html><html><head><title>Wayback Machine</title></head></html>",
  );
  // A 200 page that happens to be about the Wayback Machine is not an error.
  assert.equal(isWaybackErrorPage(200, [], body), false);
  // A historical error page comes with the original headers.
  assert.equal(
    isWaybackErrorPage(
      404,
      [["x-archive-orig-server", "Apache/1.2"]],
      Buffer.from("<title>Wayback Machine</title>"),
    ),
    false,
  );
  // A historical 404 without that title is a capture, not the frontend.
  assert.equal(
    isWaybackErrorPage(
      404,
      [],
      Buffer.from("<html><title>404 Not Found</title></html>"),
    ),
    false,
  );
  assert.equal(isWaybackErrorPage(404, [], Buffer.alloc(0)), false);
});
