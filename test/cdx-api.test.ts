import { test } from "node:test";
import assert from "node:assert/strict";

import { handleCdxQuery } from "../src/replay/cdx-api.js";
import { surtKey } from "../src/lib/url.js";
import type { CdxjEntry } from "../src/archive/cdxj.js";

const SHA1 = "W5UJTYTMS5GSAL4RLLDYFW67L3VBHBBR";

function entry(overrides: {
  url: string;
  timestamp: string;
  status?: number | null;
  mime?: string;
  digest?: string | null;
  offset?: number;
  length?: number;
}): CdxjEntry {
  const offset = overrides.offset ?? 0;
  const length = overrides.length ?? 1000;
  const json = {
    url: overrides.url,
    offset,
    length,
    status: overrides.status === undefined ? 200 : overrides.status,
    mime: overrides.mime ?? "text/html",
    digest: overrides.digest ?? null,
    filename: "data.warc.gz",
  };
  return {
    key: surtKey(overrides.url),
    timestamp: overrides.timestamp,
    url: overrides.url,
    mime: overrides.mime ?? "text/html",
    status: overrides.status === undefined ? 200 : overrides.status,
    offset,
    length,
    digest: overrides.digest ?? null,
    filename: "data.warc.gz",
    json,
  };
}

const ENTRIES: CdxjEntry[] = [
  entry({
    url: "http://msn.com/",
    timestamp: "19961022175327000",
    digest: `sha1:${SHA1}`,
    offset: 164124,
    length: 2844,
  }),
  entry({
    url: "http://msn.com/access/allinone.asp",
    timestamp: "19961022175334000",
    digest:
      "sha-256:3295d085fe3b4c971e34d31aa56d34272f69f545893d25621b1401b41d0ab950",
    offset: 3206370,
    length: 6366,
  }),
  entry({
    url: "http://www.msn.com/",
    timestamp: "19961025123620000",
    digest:
      "sha-256:7cc0d5d0c4fca7cb0f4f1e2b5a1b9e6d3c2f1a0b9e8d7c6b5a4938271605f4e3",
    offset: 500,
    length: 700,
  }),
  entry({
    url: "http://example.com/",
    timestamp: "20200101000000000",
    digest: `sha1:${SHA1}`,
    offset: 900,
    length: 800,
  }),
];

async function query(
  search: string,
  options?: {
    resolveSha1?: (e: CdxjEntry) => Promise<string | null>;
    entries?: CdxjEntry[];
  },
) {
  const params = new URLSearchParams(search);
  return handleCdxQuery(options?.entries ?? ENTRIES, params, {
    resolveSha1: options?.resolveSha1 ?? (async () => null),
  });
}

test("text output prints the seven Wayback fields in order", async () => {
  const response = await query("url=http://msn.com/");
  assert.equal(response.status, 200);
  assert.match(response.contentType, /^text\/plain/);
  const line = response.body.trim();
  assert.equal(
    line,
    `com,msn)/ 19961022175327000 http://msn.com/ text/html 200 ${SHA1} 2844`,
  );
});

test("json output puts the field names in the first row", async () => {
  const response = await query("url=http://msn.com/&output=json");
  const rows = JSON.parse(response.body) as string[][];
  assert.deepEqual(rows[0], [
    "urlkey",
    "timestamp",
    "original",
    "mimetype",
    "statuscode",
    "digest",
    "length",
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][5], SHA1);
});

test("a sha1 digest is answered from the index without reading a record", async () => {
  let calls = 0;
  const response = await query("url=http://msn.com/", {
    resolveSha1: async () => {
      calls++;
      return null;
    },
  });
  assert.equal(calls, 0);
  assert.match(response.body, new RegExp(SHA1));
});

test("a query that does not ask for the digest reads no records", async () => {
  let calls = 0;
  const response = await query(
    "url=http://msn.com/access/allinone.asp&fl=timestamp,original",
    {
      resolveSha1: async () => {
        calls++;
        return SHA1;
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(
    response.body.trim(),
    "19961022175334000 http://msn.com/access/allinone.asp",
  );
});

test("a filter on the digest pays for the digest", async () => {
  let calls = 0;
  const response = await query(
    "url=http://msn.com/access/allinone.asp&filter=digest:" + SHA1,
    {
      resolveSha1: async () => {
        calls++;
        return SHA1;
      },
    },
  );
  assert.equal(calls, 1);
  assert.match(response.body, /allinone\.asp/);
});

test("a sha256-only index has its sha1 recomputed through the resolver", async () => {
  const response = await query("url=http://msn.com/access/allinone.asp", {
    resolveSha1: async () => SHA1,
  });
  const line = response.body.trimEnd();
  assert.match(line, new RegExp(` ${SHA1} 6366$`));
});

test("an unresolvable digest is printed empty, never as sha256", async () => {
  const response = await query("url=http://msn.com/access/allinone.asp", {
    resolveSha1: async () => null,
  });
  const fields = response.body.trim().split(" ");
  assert.equal(fields[5], "");
  assert.ok(!response.body.includes("sha-256"));
});

test("prefix match returns descendants in index order", async () => {
  const response = await query("url=http://msn.com/&matchType=prefix");
  const lines = response.body.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("http://msn.com/ "));
  assert.ok(lines[1].includes("allinone.asp"));
});

test("a trailing star means prefix", async () => {
  const response = await query("url=http://msn.com/*");
  assert.equal(response.body.trim().split("\n").length, 2);
});

test("domain match includes subdomains", async () => {
  const response = await query("url=msn.com&matchType=domain");
  const lines = response.body.trim().split("\n");
  assert.equal(lines.length, 3);
});

test("from and to bound the timestamp range", async () => {
  const response = await query(
    "url=msn.com&matchType=domain&from=19961022&to=19961023",
  );
  assert.equal(response.body.trim().split("\n").length, 2);
});

test("fl chooses and orders the columns", async () => {
  const response = await query("url=http://msn.com/&fl=timestamp,original");
  assert.equal(response.body.trim(), "19961022175327000 http://msn.com/");
});

test("host match stays on one hostname and excludes subdomains", async () => {
  const response = await query("url=http://msn.com/&matchType=host");
  const lines = response.body.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(line.includes("msn.com/"), line);
    assert.ok(!line.includes("www.msn.com"), line);
  }
});

test("host match ignores a default port in the index key", async () => {
  const entries: CdxjEntry[] = [
    entry({
      url: "http://msn.com:80/",
      timestamp: "19961022175327000",
      digest: `sha1:${SHA1}`,
    }),
  ];
  const response = await query("url=http://msn.com/&matchType=host", {
    entries,
  });
  assert.equal(response.body.trim().split("\n").length, 1);
});

test("filter excludes with the negation modifier", async () => {
  const response = await query(
    "url=msn.com&matchType=domain&filter=!statuscode:200",
  );
  assert.equal(response.body.trim(), "");
});

test("filter keeps rows whose field matches", async () => {
  const response = await query(
    "url=msn.com&matchType=domain&filter=mimetype:html",
  );
  assert.equal(response.body.trim().split("\n").length, 3);
});

test("collapse=urlkey keeps one row per url key", async () => {
  // Two captures of the same URL: without collapse both are listed, with it
  // only the first survives.
  const entries: CdxjEntry[] = [
    entry({
      url: "http://example.com/",
      timestamp: "20200101000000000",
      digest: `sha1:${SHA1}`,
      offset: 1,
    }),
    entry({
      url: "http://example.com/",
      timestamp: "20210101000000000",
      digest: `sha1:${SHA1}`,
      offset: 2,
    }),
  ];
  const plain = await query("url=http://example.com/", { entries });
  assert.equal(plain.body.trim().split("\n").length, 2);

  const collapsed = await query("url=http://example.com/&collapse=urlkey", {
    entries,
  });
  assert.equal(collapsed.body.trim().split("\n").length, 1);
});

test("limit truncates the result", async () => {
  const response = await query("url=msn.com&matchType=domain&limit=1");
  assert.equal(response.body.trim().split("\n").length, 1);
});

test("sort=reverse flips the order", async () => {
  const response = await query("url=msn.com&matchType=domain&sort=reverse");
  const lines = response.body.trim().split("\n");
  assert.ok(lines[0].includes("www.msn.com"));
});

test("cdxj output labels the digest with sha1", async () => {
  const response = await query("url=http://msn.com/&output=cdxj");
  assert.match(response.body, /"digest":"sha1:W5UJ/);
});

test("a query without url is a 400", async () => {
  const response = await query("");
  assert.equal(response.status, 400);
  assert.match(response.body, /url is required/);
});

test("an unsupported output is a 400 that lists what works", async () => {
  const response = await query("url=http://msn.com/&output=link");
  assert.equal(response.status, 400);
  assert.match(response.body, /text, cdx, cdxj, json/);
});
