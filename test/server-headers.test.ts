import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import {
  buildReplayHeaders,
  canonicalHeaderName,
} from "../src/replay/headers.js";
import { isNavigationRequest } from "../src/replay/navigation.js";
import type { WarcRecord } from "../src/archive/warc.js";
import type { CdxjEntry } from "../src/archive/cdxj.js";

// Two replay rules decide whether an archived page can run at all:
//
//   1. an archived response answers with this server's headers, and the
//      archived ones are reported as X-Archive-Orig-* (the Wayback Machine's
//      rule), so an archived Content-Security-Policy cannot block the replay;
//   2. only a page navigation may be redirected to another timestamp, because a
//      subresource URL is the identity of the file (a second URL for one script
//      means the script runs twice).

function recordWith(headers: Record<string, string>): WarcRecord {
  // The WARC parser stores response header names lowercased; mirror that.
  const httpHeaders = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    httpHeaders.set(name.toLowerCase(), value);
  }
  return {
    warcType: "response",
    headers: new Map<string, string>(),
    targetUri: null,
    date: null,
    contentType: null,
    httpStatus: 200,
    httpStatusText: "OK",
    httpHeaders,
    body: Buffer.alloc(0),
  };
}

function entryAt(timestamp: string): CdxjEntry {
  return {
    key: "example.com)/",
    timestamp,
    url: "https://example.com/",
    mime: "text/html",
    status: 200,
    offset: 0,
    length: 0,
    digest: null,
    filename: "archive/data.warc.gz",
    json: {},
  };
}

function replayHeaders(
  headers: Record<string, string>,
  url = "https://example.com/",
  ts = "19960101000000",
  body = Buffer.from("<html></html>"),
  status = 200,
  captureTs = "19960101000000123",
) {
  return buildReplayHeaders(
    recordWith(headers),
    entryAt(captureTs),
    url,
    ts,
    "text/html",
    body,
    status,
  );
}

test("the archived content type is replayed", () => {
  const headers = replayHeaders({ "Content-Type": "text/html" });
  assert.equal(headers["content-type"], "text/html; charset=utf-8");
});

test("an archived Content-Security-Policy is not replayed", () => {
  const headers = replayHeaders({
    "Content-Type": "text/html",
    "Content-Security-Policy": "script-src https://example.com/",
  });
  assert.equal(headers["Content-Security-Policy"], undefined);
  assert.equal(headers["content-security-policy"], undefined);
  assert.equal(
    headers["X-Archive-Orig-Content-Security-Policy"],
    "script-src https://example.com/",
  );
});

test("a report-only Content-Security-Policy is not replayed either", () => {
  const headers = replayHeaders({
    "Content-Type": "text/html",
    "Content-Security-Policy-Report-Only": "script-src 'self'",
  });
  assert.equal(headers["Content-Security-Policy-Report-Only"], undefined);
  assert.equal(
    headers["X-Archive-Orig-Content-Security-Policy-Report-Only"],
    "script-src 'self'",
  );
});

test("the origin's own headers are reported, not replayed", () => {
  const headers = replayHeaders({
    "Content-Type": "text/html",
    Server: "Microsoft-IIS/2.0",
    Date: "Tue, 22 Oct 1996 17:53:31 GMT",
    "Cache-Control": "private",
    Expires: "Tue, 22 Oct 1996 17:53:30 GMT",
    "Last-Modified": "Wed, 02 Oct 1996 23:34:26 GMT",
    ETag: '"d46aa268ffe2c01:861"',
    "X-Powered-By": "ASP.NET",
    "Strict-Transport-Security": "max-age=15724800",
    "Set-Cookie": "DENALISESSIONID=JQORAGFMMUWELGRI; path=/",
    "Content-Length": "28640",
    Connection: "Keep-Alive",
    "Transfer-Encoding": "chunked",
    "Content-Encoding": "gzip",
  });

  for (const name of [
    "server",
    "date",
    "cache-control",
    "expires",
    "last-modified",
    "etag",
    "x-powered-by",
    "strict-transport-security",
    "set-cookie",
    "connection",
    "transfer-encoding",
    "content-encoding",
  ]) {
    assert.equal(headers[name], undefined, name + " must not be replayed");
  }

  assert.equal(headers["X-Archive-Orig-Server"], "Microsoft-IIS/2.0");
  assert.equal(headers["X-Archive-Orig-Date"], "Tue, 22 Oct 1996 17:53:31 GMT");
  assert.equal(headers["X-Archive-Orig-Cache-Control"], "private");
  assert.equal(headers["X-Archive-Orig-ETag"], '"d46aa268ffe2c01:861"');
  assert.equal(
    headers["X-Archive-Orig-Set-Cookie"],
    "DENALISESSIONID=JQORAGFMMUWELGRI; path=/",
  );
  // The encoding uses the short prefix, the spelling the Wayback Machine uses.
  assert.equal(headers["X-Orig-Content-Encoding"], "gzip");
  assert.equal(headers["X-Archive-Orig-Content-Encoding"], undefined);
  // Our own numbers, not the archived ones.
  assert.equal(headers["content-length"], String("<html></html>".length));
  assert.equal(headers["accept-ranges"], "bytes");
});

test("a header captured from an earlier replay keeps its own name", () => {
  // An archive captured through a replay stores that replay's own reporting
  // headers, so replaying it must not add a second prefix.
  const headers = replayHeaders({
    "Content-Type": "text/html",
    "X-Archive-Orig-Server": "Microsoft-IIS/2.0",
    "x-orig-content-encoding": "gzip",
  });
  assert.equal(headers["X-Archive-Orig-Server"], "Microsoft-IIS/2.0");
  assert.equal(headers["X-Orig-Content-Encoding"], "gzip");
  assert.equal(headers["X-Archive-Orig-X-Archive-Orig-Server"], undefined);
  assert.equal(headers["X-Archive-Orig-X-Orig-Content-Encoding"], undefined);
});

test("an archived redirect target is reported, and the live one is rewritten", () => {
  const headers = replayHeaders(
    { Location: "/next.html" },
    "https://example.com/a/page.html",
    "19960101000000",
    Buffer.alloc(0),
    302,
  );
  assert.equal(headers["X-Archive-Orig-Location"], "/next.html");
  assert.equal(
    headers["location"],
    "/web/19960101000000/https://example.com/next.html",
  );
});

test("the response reports which capture it serves", () => {
  const headers = replayHeaders(
    { "Content-Type": "text/html" },
    "https://example.com/",
    "19960101000000",
    Buffer.from("<html></html>"),
    200,
    "19961022175331000",
  );
  assert.equal(headers["memento-datetime"], "Tue, 22 Oct 1996 17:53:31 GMT");
  assert.equal(headers["link"], '<https://example.com/>; rel="original"');
  assert.equal(headers["x-archive-src"], "archive/data.warc.gz");
});

test("a bodyless response carries no content length", () => {
  const headers = replayHeaders(
    { "Content-Type": "text/html" },
    "https://example.com/",
    "19960101000000",
    Buffer.alloc(0),
    204,
  );
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["accept-ranges"], undefined);
});

test("header names are spelled out in their canonical form", () => {
  assert.equal(canonicalHeaderName("etag"), "ETag");
  assert.equal(canonicalHeaderName("p3p"), "P3P");
  assert.equal(canonicalHeaderName("x-frame-options"), "X-Frame-Options");
  assert.equal(
    canonicalHeaderName("content-security-policy"),
    "Content-Security-Policy",
  );
});

test("a control character in an archived value cannot break the response", () => {
  // Node's HTTP layer throws on a control character in a header value, and a
  // crawl can store whatever the origin sent.
  const headers = replayHeaders({
    "Content-Type": "text/html",
    "X-Odd": "a\u0000b\nc\td",
  });
  assert.equal(headers["X-Archive-Orig-X-Odd"], "a b c\td");
});

test("a code point above U+00FF in an archived value cannot break the response", () => {
  // Node's HTTP layer rejects a header value that is not bytes, so a Chinese
  // filename in an archived Content-Disposition would crash the response.
  const headers = replayHeaders({
    "Content-Type": "text/html",
    "Content-Disposition": 'inline; filename="指南.html"',
  });
  assert.equal(
    headers["X-Archive-Orig-Content-Disposition"],
    'inline; filename="%E6%8C%87%E5%8D%97.html"',
  );
});

test("a URL with characters above U+00FF is percent-encoded in the reporting headers", () => {
  // This archive keeps the Chinese characters of a page's URL in the URL
  // itself. One request for that page killed the replay server, because the
  // `link` header carried the characters straight into Node's HTTP layer.
  const url =
    "http://register.microsoft.com/regsys/decisionpoint.asp?lcid=2052&MSCOMTB=MS_Microsoft 指南";
  const headers = replayHeaders({ "Content-Type": "text/html" }, url);
  assert.equal(
    headers["link"],
    '<http://register.microsoft.com/regsys/decisionpoint.asp?lcid=2052&MSCOMTB=MS_Microsoft%20%E6%8C%87%E5%8D%97>; rel="original"',
  );
});

test("an archived redirect target above U+00FF is percent-encoded", () => {
  const headers = replayHeaders(
    { Location: "/指 南.html" },
    "https://example.com/a/page.html",
    "19960101000000",
    Buffer.alloc(0),
    302,
  );
  assert.equal(
    headers["location"],
    "/web/19960101000000/https://example.com/%E6%8C%87%20%E5%8D%97.html",
  );
  // The archived value is still reported, with its characters encoded.
  assert.ok(!/[^\u0000-\u00ff]/.test(headers["X-Archive-Orig-Location"]!));
});

function fakeRequest(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

test("a top-level page load is a navigation", () => {
  assert.equal(
    isNavigationRequest(
      fakeRequest({
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
      }),
    ),
    true,
  );
});

test("a frame load is a navigation", () => {
  assert.equal(
    isNavigationRequest(
      fakeRequest({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }),
    ),
    true,
  );
});

test("a script, style or fetch request is not a navigation", () => {
  assert.equal(
    isNavigationRequest(fakeRequest({ "sec-fetch-dest": "script" })),
    false,
  );
  assert.equal(
    isNavigationRequest(fakeRequest({ "sec-fetch-dest": "style" })),
    false,
  );
  assert.equal(
    isNavigationRequest(
      fakeRequest({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }),
    ),
    false,
  );
});

test("a client that sends no Fetch Metadata headers is not a navigation", () => {
  assert.equal(isNavigationRequest(fakeRequest({})), false);
});
