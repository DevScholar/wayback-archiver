import { test } from "node:test";
import assert from "node:assert/strict";
import { build, target, hop, historicalHeaders } from "./restorer-fixture.js";
import { snapshotKey } from "../src/restore/records.js";

// The restorer's per-chain record building. These run offline on synthetic hops
// shaped like Wayback's `id_` responses: one plain capture, several historical
// snapshots of one URL, a playback (timestamp-shift) redirect, an era redirect,
// and Wayback's own error page.

test("two historical snapshots of one URL are both stored", () => {
  const storedKeys = new Set<string>();
  const first = build(
    target("http://a.example/x", "19980101000000"),
    [
      hop({
        url: "https://web.archive.org/web/19980101000000id_/http://a.example/x",
        body: Buffer.from("one"),
      }),
    ],
    storedKeys,
  );
  const second = build(
    target("http://a.example/x", "19990101000000"),
    [
      hop({
        url: "https://web.archive.org/web/19990101000000id_/http://a.example/x",
        body: Buffer.from("two"),
      }),
    ],
    storedKeys,
  );

  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 1);
  assert.equal(first.records[0].ts17, "19980101000000000");
  assert.equal(second.records[0].ts17, "19990101000000000");
  assert.equal(first.records[0].body.toString(), "one");
  assert.equal(second.records[0].body.toString(), "two");
  assert.equal(storedKeys.size, 2);
});

test("a second chain for the same URL and timestamp is not stored twice", () => {
  const storedKeys = new Set<string>();
  const same = () => [
    hop({
      url: "https://web.archive.org/web/19980101000000id_/http://a.example/x",
      headers: historicalHeaders("Apache/1.3"),
    }),
  ];

  const first = build(
    target("http://a.example/x", "19980101000000"),
    same(),
    storedKeys,
  );
  const second = build(
    target("http://a.example/x", "19980101000000"),
    same(),
    storedKeys,
  );

  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 0);
  assert.equal(second.wroteTarget, true); // the snapshot is present, just not written again
  assert.equal(second.skippedAlreadyStored, 1);
});

test("a playback redirect is followed but never archived", () => {
  const hops = [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/x",
      status: 302,
      statusText: "Found",
      headers: [
        [
          "location",
          "https://web.archive.org/web/19961026001900id_/http://a.example/x",
        ],
        ["x-archive-redirect-reason", "found capture at 19961026001900"],
        ["server", "nginx"],
      ],
      body: Buffer.alloc(0),
    }),
    hop({
      url: "https://web.archive.org/web/19961026001900id_/http://a.example/x",
      headers: historicalHeaders("Apache/1.3"),
      body: Buffer.from("JPEG"),
    }),
  ];

  const result = build(target("http://a.example/x", "19961022175327"), hops);

  assert.equal(result.skippedPlaybackRedirects, 1);
  assert.equal(result.records.length, 1);
  // Stored under the real capture time the redirect named, not the requested
  // timestamp that redirected to it.
  assert.equal(result.records[0].ts17, "19961026001900000");
  assert.equal(result.records[0].innerUrl, "http://a.example/x");
  assert.equal(result.lastTs14, "19961026001900");
  assert.equal(result.wroteTarget, false);
  // Wayback's own framing never reaches the record.
  const names = result.records[0].headers.map(([name]) => name.toLowerCase());
  assert.ok(!names.includes("location"));
  assert.ok(!names.includes("x-archive-redirect-reason"));
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "server",
    )?.[1],
    "Apache/1.3",
  );
  // The request record documents the id_ fetch, attached to the stored hop.
  assert.ok(result.records[0].requestRecord);
  assert.match(
    result.records[0].requestRecord!.toString("latin1"),
    /WARC-Target-URI: https:\/\/web\.archive\.org\/web\/19961022175327id_\/http:\/\/a\.example\/x/,
  );
});

test("an era redirect is kept as the historical response", () => {
  const hops = [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/old",
      status: 302,
      statusText: "Found",
      headers: [
        ["x-archive-orig-location", "http://a.example/new"],
        ["x-archive-orig-server", "Apache/1.2"],
        ["content-type", "text/html"],
      ],
      body: Buffer.alloc(0),
    }),
    hop({
      url: "http://a.example/new",
      headers: [
        ["x-archive-orig-server", "Apache/1.2"],
        ["content-type", "text/html"],
      ],
      body: Buffer.from("new page"),
    }),
  ];

  const result = build(target("http://a.example/old", "19961022175327"), hops);

  assert.equal(result.skippedPlaybackRedirects, 0);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].status, 302);
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1],
    "http://a.example/new",
  );
  assert.equal(result.records[1].innerUrl, "http://a.example/new");
  assert.equal(result.wroteTarget, true);
});

test("an era redirect is kept even when its visible location is a playback URL", () => {
  const result = build(target("http://a.example/old", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/old",
      status: 302,
      statusText: "Found",
      headers: [
        [
          "location",
          "https://web.archive.org/web/19961022175327id_/http://a.example/old",
        ],
        ["x-archive-orig-location", "http://a.example/new"],
        ["x-archive-orig-server", "Apache/1.2"],
      ],
      body: Buffer.alloc(0),
    }),
  ]);

  assert.equal(result.skippedPlaybackRedirects, 0);
  assert.equal(result.records.length, 1);
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1],
    "http://a.example/new",
  );
});

test("a followed non-Wayback hop is stored under its own URL", () => {
  const hops = [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/old",
      status: 302,
      statusText: "Found",
      headers: [["x-archive-orig-location", "http://b.example/page"]],
      body: Buffer.alloc(0),
    }),
    hop({
      url: "http://b.example/page",
      headers: [["x-archive-orig-server", "Apache/1.2"]],
      body: Buffer.from("destination"),
    }),
  ];

  const result = build(target("http://a.example/old", "19961022175327"), hops);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].innerUrl, "http://b.example/page");
  assert.equal(result.records[1].body.toString(), "destination");
  // The destination keeps the chain's capture time.
  assert.equal(result.records[1].ts17, "19961022175327000");
});

test("Wayback error pages are not archived", () => {
  const result = build(target("http://a.example/x", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/x",
      status: 404,
      statusText: "Not Found",
      headers: [
        ["content-type", "text/html"],
        ["server", "nginx"],
      ],
      body: Buffer.from(
        "<!DOCTYPE html><title>Wayback Machine</title><p>not archived",
      ),
    }),
  ]);

  assert.equal(result.skippedErrorPages, 1);
  assert.equal(result.records.length, 0);
  assert.equal(result.wroteTarget, false);
});

test("an archived 404 with historical headers is kept", () => {
  const result = build(target("http://a.example/missing", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/missing",
      status: 404,
      statusText: "Not Found",
      headers: [
        ["x-archive-orig-server", "Apache/1.2"],
        ["x-archive-orig-date", "Tue, 22 Oct 1996 17:53:27 GMT"],
        ["content-type", "text/html"],
      ],
      body: Buffer.from("<html><title>Not Found</title></html>"),
    }),
  ]);

  assert.equal(result.skippedErrorPages, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 404);
  assert.equal(result.wroteTarget, true);
});

test("a historical 301 keeps its target when Wayback rewrote the Location", () => {
  // This is the shape the real archive has: a captured 301 whose Location was
  // rewritten to a replay route, with the historical headers under
  // X-Archive-Orig-* and no X-Archive-Orig-Location.
  const result = build(
    target("http://www.microsoft.com/ie/images/iebar.gif", "20110328233623"),
    [
      hop({
        url: "https://web.archive.org/web/20110328233623/http://www.microsoft.com/ie/images/iebar.gif",
        status: 301,
        statusText: "Moved Permanently",
        headers: [
          ["x-archive-orig-server", "Microsoft-IIS/7.5"],
          ["x-archive-orig-date", "Mon, 28 Mar 2011 23:36:22 GMT"],
          ["x-archive-orig-content-length", "0"],
          [
            "location",
            "https://web.archive.org/web/20110328233623/http://www.microsoft.com/windows/ie/images/iebar.gif",
          ],
          ["server", "nginx"],
        ],
        body: Buffer.alloc(0),
      }),
    ],
  );

  assert.equal(result.skippedPlaybackRedirects, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 301);
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1],
    "http://www.microsoft.com/windows/ie/images/iebar.gif",
  );
  // Wayback framing never leaks in.
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "server",
    )?.[1],
    "Microsoft-IIS/7.5",
  );
});

test("a historical 302 with ordinary headers and location is kept", () => {
  const result = build(target("http://a.example/old", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/old",
      status: 302,
      statusText: "Found",
      headers: [
        ["server", "Apache/1.2"],
        ["date", "Tue, 22 Oct 1996 17:53:27 GMT"],
        ["location", "http://b.example/new"],
        ["content-type", "text/html"],
      ],
      body: Buffer.alloc(0),
    }),
  ]);

  assert.equal(result.skippedPlaybackRedirects, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 302);
  assert.equal(
    result.records[0].headers.find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1],
    "http://b.example/new",
  );
});

test("a headerless playback redirect is still recognised from its location", () => {
  const result = build(target("http://a.example/x", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/x",
      status: 302,
      statusText: "Found",
      headers: [
        [
          "location",
          "https://web.archive.org/web/19961026001900id_/http://a.example/x",
        ],
      ],
      body: Buffer.alloc(0),
    }),
  ]);

  assert.equal(result.skippedPlaybackRedirects, 1);
  assert.equal(result.records.length, 0);
});

test("a redirect to a capture already in the archive counts as a shift", () => {
  const storedKeys = new Set([
    snapshotKey("http://a.example/x", "19961026001900"),
  ]);
  const result = build(
    target("http://a.example/x", "19961022175327"),
    [
      hop({
        url: "https://web.archive.org/web/19961022175327id_/http://a.example/x",
        status: 302,
        statusText: "Found",
        headers: [
          [
            "location",
            "https://web.archive.org/web/19961026001900id_/http://a.example/x",
          ],
          ["x-archive-redirect-reason", "found capture at 19961026001900"],
        ],
        body: Buffer.alloc(0),
      }),
      hop({
        url: "https://web.archive.org/web/19961026001900id_/http://a.example/x",
        headers: historicalHeaders("Apache/1.3"),
        body: Buffer.from("JPEG"),
      }),
    ],
    storedKeys,
  );

  assert.equal(result.records.length, 0);
  assert.equal(result.wroteTarget, false);
  assert.equal(result.skippedPlaybackRedirects, 1);
  assert.equal(result.skippedAlreadyStored, 1);
  assert.equal(result.alreadyStoredTs14, "19961026001900");
});

test("pages are listed only for HTML captures", () => {
  const result = build(target("http://a.example/p", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/p",
      headers: [["x-archive-orig-content-type", "text/html"]],
    }),
  ]);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].url, "http://a.example/p");
});

test("the input crawler charset guess becomes WARC-Identified-Payload-Type", () => {
  const identified = new Map([
    ["http://msn.com/\t19961022175327", "text/html; charset=windows-1250"],
  ]);
  const result = build(
    target("http://msn.com/", "19961022175327"),
    [
      hop({
        url: "https://web.archive.org/web/19961022175327id_/http://msn.com/",
        headers: [["content-type", "text/html"]],
      }),
    ],
    new Set(),
    identified,
  );
  assert.equal(
    result.records[0].identifiedPayloadType,
    "text/html; charset=windows-1250",
  );
});

test("Wayback guessed charset is used when the WARC header is absent", () => {
  const result = build(target("http://a.example/page", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/page",
      headers: [
        ["content-type", "text/html"],
        ["x-archive-guessed-content-type", "text/html"],
        ["x-archive-guessed-charset", "maccentraleurope"],
      ],
    }),
  ]);
  assert.equal(
    result.records[0].identifiedPayloadType,
    "text/html; charset=maccentraleurope",
  );
});

test("a guessed charset on a non-text type is ignored", () => {
  const result = build(target("http://a.example/pixel.gif", "19961022175327"), [
    hop({
      url: "https://web.archive.org/web/19961022175327id_/http://a.example/pixel.gif",
      headers: [
        ["content-type", "image/gif"],
        ["x-archive-guessed-content-type", "image/gif"],
        ["x-archive-guessed-charset", "utf-8"],
      ],
      body: Buffer.from("GIF89a"),
    }),
  ]);
  assert.equal(result.records[0].identifiedPayloadType, undefined);
});

test("the live Wayback guess wins over the input identified type", () => {
  const identified = new Map([
    [
      "http://a.example/page\t19961022175327",
      "text/html; charset=windows-1250",
    ],
  ]);
  const result = build(
    target("http://a.example/page", "19961022175327"),
    [
      hop({
        url: "https://web.archive.org/web/19961022175327id_/http://a.example/page",
        headers: [
          ["content-type", "text/html"],
          ["x-archive-guessed-content-type", "text/html"],
          ["x-archive-guessed-charset", "utf-8"],
        ],
      }),
    ],
    new Set(),
    identified,
  );
  assert.equal(
    result.records[0].identifiedPayloadType,
    "text/html; charset=utf-8",
  );
});
