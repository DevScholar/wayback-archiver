/**
 * rewrite-js.ts
 *
 * ES module specifiers: `import 'x'`, `import("x")`, and
 * `import`/`export ... from "x"`. These are the URLs a browser's module loader
 * resolves *before* any page JavaScript runs, so the runtime shim cannot
 * rewrite them -- they must be rewritten here, in the source, at serve time.
 */

import { toAbsolute, type UrlRewriter } from "./rewrite-common.js";

/** A module specifier is only worth rewriting if it resolves to a real URL:
 * relative (./ ../), root-relative (/), protocol-relative (//), or absolute
 * (scheme://). Bare names ("react") and non-URL fragments ("+m+") are left
 * alone -- rewriting them would corrupt ordinary code (e.g. the English word
 * "from" inside a string) and bare package names aren't archivable URLs. */
function isUrlSpecifier(ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (r.startsWith("./") || r.startsWith("../") || r.startsWith("/"))
    return true;
  if (r.startsWith("//")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(r);
}

/** Rewrite the module specifiers in a JavaScript body. */
export function rewriteJs(
  content: string,
  baseUrl: string,
  rewrite: UrlRewriter,
): string {
  // Dynamic import: import('x') / import("x")
  content = content.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (match, q: string, ref: string) => {
      if (!isUrlSpecifier(ref)) return match;
      const abs = toAbsolute(ref, baseUrl);
      if (abs === null) return match;
      const out = rewrite(abs);
      return out === null ? match : `import(${q}${out}${q})`;
    },
  );

  // Static side-effect import at a statement boundary: `import 'x';`
  content = content.replace(
    /(^|[;{}])\s*(import)\s+(['"])([^'"]+)\3\s*;?/g,
    (match, pre: string, kw: string, q: string, ref: string) => {
      if (!isUrlSpecifier(ref)) return match;
      const abs = toAbsolute(ref, baseUrl);
      if (abs === null) return match;
      const out = rewrite(abs);
      return out === null ? match : `${pre}${kw} ${q}${out}${q};`;
    },
  );

  // import ... from 'x'; export ... from 'x';
  content = content.replace(
    /\b(from)\s+(['"])([^'"]+)\2/g,
    (match, kw: string, q: string, ref: string) => {
      if (!isUrlSpecifier(ref)) return match;
      const abs = toAbsolute(ref, baseUrl);
      if (abs === null) return match;
      const out = rewrite(abs);
      return out === null ? match : `${kw} ${q}${out}${q}`;
    },
  );

  return content;
}
