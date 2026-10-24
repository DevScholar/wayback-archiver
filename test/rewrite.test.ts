import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteContent, detectContentKind } from "../src/replay/rewrite.js";

const rewrite = (abs: string) => `/web/2026/${abs}`;

test("rewriteContent rewrites HTML href/src/srcset", () => {
  const html =
    '<a href="/a.html">A</a><img src="/img.png"><img srcset="/a.png 1x, /b.png 2x">';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.ok(out.includes('href="/web/2026/http://example.com/a.html"'));
  assert.ok(out.includes('src="/web/2026/http://example.com/img.png"'));
  assert.ok(out.includes("/web/2026/http://example.com/a.png 1x"));
  assert.ok(out.includes("/web/2026/http://example.com/b.png 2x"));
});

test("rewriteContent preserves fragment in href", () => {
  const html = '<a href="/a.html#sec">A</a>';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.ok(out.includes("/web/2026/http://example.com/a.html#sec"));
});

test("rewriteContent skips javascript/data/mailto URLs", () => {
  const html =
    '<a href="javascript:void(0)">x</a><img src="data:image/png;base64,AAA">';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.ok(out.includes('href="javascript:void(0)"'));
  assert.ok(out.includes('src="data:image/png;base64,AAA"'));
});

test("rewriteContent rewrites CSS url() and @import", () => {
  const css = 'body { background: url("/bg.png"); }\n@import "/extra.css";';
  const out = rewriteContent(css, "http://example.com/", rewrite, "css");
  assert.ok(out.includes("url(/web/2026/http://example.com/bg.png)"));
  assert.ok(out.includes('@import "/web/2026/http://example.com/extra.css";'));
});

test("rewriteContent rewrites JS import specifiers but not bare names", () => {
  const js =
    'import x from "./a.js"; import("./b.js"); const s = "from nowhere";';
  const out = rewriteContent(js, "http://example.com/", rewrite, "js");
  assert.ok(out.includes('from "/web/2026/http://example.com/a.js"'));
  assert.ok(out.includes('import("/web/2026/http://example.com/b.js")'));
  // bare string "from" untouched
  assert.ok(out.includes('"from nowhere"'));
});

test("rewriteContent handles comma in srcset query string", () => {
  const html = '<img srcset="/img?op_usm=1.5,0.65 1x, /img2.png 2x">';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  // the comma inside the query must not split the candidate
  assert.ok(
    out.includes("/web/2026/http://example.com/img?op_usm=1.5,0.65 1x"),
  );
  assert.ok(out.includes("/web/2026/http://example.com/img2.png 2x"));
});

test("an unquoted attribute value is rewritten in place", () => {
  // A 2001 microsoft.com page writes its headline images without quotes:
  //   <img src=/china/windowsxp/mainleft.jpg border=0 ...>
  // Leaving that value alone made the browser ask the replay server for
  // /china/windowsxp/mainleft.jpg, which answered 404, so the archived image
  // never showed. An unquoted value ends at whitespace or `>`.
  const html =
    '<img src=/china/windowsxp/mainleft.jpg border=0 alt="x"><a href=/china/press/2001/1109.asp>p</a>';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.equal(
    out,
    '<img src=/web/2026/http://example.com/china/windowsxp/mainleft.jpg border=0 alt="x"><a href=/web/2026/http://example.com/china/press/2001/1109.asp>p</a>',
  );
});

test("an unquoted srcset candidate is rewritten", () => {
  const html = "<img srcset=/a.png,/b.png>";
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.equal(
    out,
    "<img srcset=/web/2026/http://example.com/a.png,/web/2026/http://example.com/b.png>",
  );
});

test("detectContentKind classifies by mime not extension", () => {
  assert.equal(detectContentKind("text/html"), "html");
  assert.equal(detectContentKind("text/css; charset=utf-8"), "css");
  assert.equal(detectContentKind("application/javascript"), "js");
  assert.equal(detectContentKind("image/png"), null);
  assert.equal(detectContentKind(""), null);
});

test("an attribute-looking string inside a <script> body is left alone", () => {
  // The 2001 microsoft.com case: rewriting this string as if it were an
  // attribute turns its spaces into %20 and breaks the script.
  const html =
    "<script>document.write('<a href=\"' + itemUrl + '\" target=_top>x</a>')</script>";
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.equal(out, html);
});

test("a <script src> attribute is still rewritten", () => {
  const html = '<script src="/js/app.js"></script>';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.equal(
    out,
    '<script src="/web/2026/http://example.com/js/app.js"></script>',
  );
});

test("a <style> body still gets CSS rewriting", () => {
  const html = "<style>body { background: url(/bg.png); }</style>";
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.ok(out.includes("url(/web/2026/http://example.com/bg.png)"));
});

test("markup after a <script> block is still rewritten", () => {
  const html = '<script src="/a.js"></script><a href="/b.html">B</a>';
  const out = rewriteContent(html, "http://example.com/", rewrite, "html");
  assert.ok(out.includes('src="/web/2026/http://example.com/a.js"'));
  assert.ok(out.includes('href="/web/2026/http://example.com/b.html"'));
});
