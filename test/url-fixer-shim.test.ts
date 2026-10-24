import { test } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { URL_FIXER_SHIM } from "../src/replay/url-fixer-shim.js";

// The shim is the only code that rewrites markup a page builds at runtime
// (`innerHTML`, `document.write`). It cannot see the page's original markup,
// because the server has already rewritten that, so its own passes have to
// cover the same syntax the server does -- including an attribute written
// without quotes.

interface ShimSandbox {
  written: string[];
  document: {
    write: (...parts: string[]) => void;
    writeln: (...parts: string[]) => void;
  };
}

/** Run the shim with just enough browser surface for its document.write patch,
 * then hand back the patched `document` and everything written through it. */
function runShim(): ShimSandbox {
  const written: string[] = [];
  const documentObject = {
    write: (...parts: string[]): void => void written.push(...parts),
    writeln: (...parts: string[]): void => void written.push(...parts),
  };
  const sandbox = {
    window: {
      __urlFixerConfig: {
        mode: "server",
        pageUrl: "http://example.com/page.html",
        ts: "20011118070649",
      },
      location: { origin: "http://localhost:8080" },
    },
    document: documentObject,
    navigator: {},
    URL,
    Element: class {
      setAttribute(): void {}
      setAttributeNS(): void {}
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(URL_FIXER_SHIM, sandbox);
  return { written, document: documentObject };
}

test("the shim rewrites an unquoted attribute value", () => {
  const { written, document } = runShim();
  document.write('<img src=/china/windowsxp/mainleft.jpg border=0 alt="x">');
  assert.equal(
    written[0],
    '<img src=/web/20011118070649/http://example.com/china/windowsxp/mainleft.jpg border=0 alt="x">',
  );
});

test("the shim rewrites a quoted attribute and an unquoted srcset", () => {
  const { written, document } = runShim();
  document.write('<a href="/a.html">a</a>');
  document.write("<img srcset=/a.png,/b.png>");
  assert.equal(
    written[0],
    '<a href="/web/20011118070649/http://example.com/a.html">a</a>',
  );
  assert.equal(
    written[1],
    "<img srcset=/web/20011118070649/http://example.com/a.png,/web/20011118070649/http://example.com/b.png>",
  );
});
