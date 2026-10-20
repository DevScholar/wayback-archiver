import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { buildReplayHeaders, isNavigationRequest } from "../src/cli/server.js";
import type { WarcRecord } from "../src/archive/warc.js";

// Two replay rules that decide whether an archived page can run at all:
//
//   1. an archived Content-Security-Policy names the original origin as the
//      only source of scripts and styles, so it must not be replayed;
//   2. only a page navigation may be redirected to another timestamp, because
//      a subresource URL is the identity of the file (a second URL for one
//      script means the script runs twice).

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

test("an archived Content-Security-Policy is not replayed", () => {
  const headers = buildReplayHeaders(
    recordWith({
      "Content-Type": "text/html",
      "Content-Security-Policy": "script-src https://archive.org/",
    }),
    "https://archive.org/",
    "20261018024628",
    "text/html",
    Buffer.from("<html></html>"),
    200,
  );
  assert.equal(headers["Content-Security-Policy"], undefined);
  assert.equal(headers["content-security-policy"], undefined);
  assert.equal(
    headers["X-Archive-Orig-Content-Security-Policy"],
    "script-src https://archive.org/",
  );
});

test("a report-only Content-Security-Policy is not replayed either", () => {
  const headers = buildReplayHeaders(
    recordWith({
      "Content-Type": "text/html",
      "Content-Security-Policy-Report-Only": "script-src 'self'",
    }),
    "https://example.com/",
    "19960101000000",
    "text/html",
    Buffer.from("<html></html>"),
    200,
  );
  assert.equal(headers["Content-Security-Policy-Report-Only"], undefined);
  assert.equal(
    headers["X-Archive-Orig-Content-Security-Policy-Report-Only"],
    "script-src 'self'",
  );
});

test("an unrelated archived header still passes through", () => {
  const headers = buildReplayHeaders(
    recordWith({
      "Content-Type": "text/html",
      "X-Frame-Options": "SAMEORIGIN",
    }),
    "https://example.com/",
    "19960101000000",
    "text/html",
    Buffer.from("<html></html>"),
    200,
  );
  assert.equal(headers["x-frame-options"], "SAMEORIGIN");
});

test("an archived redirect target points at the request's timestamp", () => {
  const headers = buildReplayHeaders(
    recordWith({ Location: "/next.html" }),
    "https://example.com/a/page.html",
    "19960101000000",
    "text/html",
    Buffer.alloc(0),
    302,
  );
  assert.equal(
    headers["location"],
    "/web/19960101000000/https://example.com/next.html",
  );
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
