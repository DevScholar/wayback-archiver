/**
 * rewrite.ts
 *
 * Rewrites URL references inside text resources so they point at local content
 * instead of the live web. Three dialects are handled, selected by `kind`:
 *
 *   html -- HTML attributes (href/src/action/background), CSS url() and @import
 *          found inside <style> blocks, and any inline markup.
 *   css  -- CSS url() and @import.
 *   js   -- ES module specifiers: `import 'x'`, `import("x")`, and
 *          `import/export ... from "x"`. These are the URLs a browser's module
 *          loader resolves *before* any page JavaScript runs, so the runtime
 *          shim cannot rewrite them -- they must be rewritten here, in the
 *          source, at serve time.
 *
 * The caller supplies a single `rewrite` callback: absolute URL -> new string
 * or null (null leaves the reference untouched). This keeps the byte-level
 * rewriting independent of the two consumers (the replay server's /web/ route
 * and the export-to-html tool's flat-file naming).
 */

export type UrlRewriter = (absUrl: string) => string | null;

export type ContentKind = 'html' | 'css' | 'js';

const SKIP_SCHEME = /^(javascript|data|mailto|blob|about):/i;

/** Decode the HTML entities that realistically show up inside a URL in an
 * attribute value (`&amp;` being the common one); everything else is left
 * untouched. */
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'");
}

/** Resolve any URL reference (absolute, root-relative, or relative) to an
 * absolute URL, using the resource's own URL as the base. Returns null when
 * the reference cannot or should not be rewritten. */
function toAbsolute(ref: string, baseUrl: string): string | null {
    const r = ref.trim();
    if (!r) return null;
    if (r.startsWith('#') || SKIP_SCHEME.test(r)) return null;

    if (r.startsWith('//')) {
        const b = new URL(baseUrl);
        return b.protocol + r;
    }

    try {
        return new URL(r, baseUrl).href;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * Rewrite a srcset value correctly. Per the HTML spec, a candidate's URL is a
 * run of non-whitespace characters, so a comma *inside* a query string (e.g.
 * `?op_usm=1.5,0.65`) is part of the URL -- only a comma at a candidate
 * boundary (followed by whitespace, or at end) separates candidates. A naive
 * split-on-comma corrupts URLs with commas in their query, which is exactly
 * how the hero `srcset` above broke.
 */
function rewriteSrcset(value: string, baseUrl: string, rewrite: UrlRewriter): string {
    // Split candidates on a comma that is at end-of-string or followed by
    // whitespace (the delimiter the spec's parsing algorithm actually uses).
    const candidates = value.split(/,(?=\s|$)/);
    const out = candidates.map((cand) => {
        // A candidate is `[leading-ws] URL [descriptor]`. URL = first non-ws token.
        const m = cand.match(/^(\s*)(\S+)(.*)$/s);
        if (!m) return cand;
        const abs = toAbsolute(m[2], baseUrl);
        if (abs === null) return cand;
        const r = rewrite(abs);
        if (r === null) return cand;
        return m[1] + r + m[3];
    });
    return out.join(',');
}

function rewriteHtml(content: string, baseUrl: string, rewrite: UrlRewriter): string {
    // Attributes whose value is a URL.
    const ATTR_RE = /(href|src|action|background|poster)\s*=\s*(["'])(.*?)\2/gi;
    content = content.replace(ATTR_RE, (match, attr: string, quote: string, ref: string) => {
        const abs = toAbsolute(ref, baseUrl);
        if (abs === null) return match;

        const hashIdx = abs.indexOf('#');
        const clean = hashIdx >= 0 ? abs.slice(0, hashIdx) : abs;
        const hash = hashIdx >= 0 ? abs.slice(hashIdx) : '';

        const out = rewrite(clean);
        if (out === null) return match;
        return `${attr}=${quote}${out}${hash}${quote}`;
    });

    // srcset: a comma-separated list of `URL [descriptor]` candidates (e.g.
    // `img.webp 1x, img.png 2x`). Each URL is rewritten in place, descriptors
    // are left untouched. This is what makes <picture> WebP sources -- which the
    // crawler archives under their `?basic=.webp` variant -- resolve locally.
    const SRCSET_RE = /srcset\s*=\s*(["'])(.*?)\1/gi;
    content = content.replace(SRCSET_RE, (match, quote: string, value: string) => {
        return `srcset=${quote}${rewriteSrcset(value, baseUrl, rewrite)}${quote}`;
    });

    // CSS url() references inside <style> blocks.
    const URL_RE = /url\(\s*["']?(.*?)["']?\s*\)/gi;
    content = content.replace(URL_RE, (match, ref: string) => {
        const abs = toAbsolute(ref, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        if (out === null) return match;
        return `url(${out})`;
    });

    // CSS @import inside <style> blocks.
    const IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(.+?)["']?\s*\)?\s*;/gi;
    content = content.replace(IMPORT_RE, (match, ref: string) => {
        const clean = ref.replace(/['"]/g, '').trim();
        const abs = toAbsolute(clean, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        if (out === null) return match;
        return `@import "${out}";`;
    });

    // <meta http-equiv="refresh" content="...; URL=...">: a client-side redirect
    // whose target lives in the `content` attribute, not in href/src. It fires
    // as soon as the head is parsed -- before any runtime shim can touch it -- so
    // it must be rewritten here or the page jumps straight to the live web.
    //
    // Non-standard `<meta>` fields (Open Graph, Twitter Card, schema.org) are
    // deliberately left untouched: they only matter to social-media crawlers
    // and online search engines, so rewriting their URLs buys nothing for a
    // local archive and would mangle markup we don't own.
    const META_RE = /<meta\b[^>]*>/gi;
    content = content.replace(META_RE, (tag) => {
        if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) return tag;
        return tag.replace(/(content\s*=\s*)(["'])([\s\S]*?)\2/i, (whole, name: string, quote: string, value: string) => {
            // `url=` is the last field of the content value, so the URL is
            // everything after it to the end. Do NOT split on `;`: an HTML
            // entity like `&amp;` ends in `;` and would truncate the URL there.
            const m = /^(.*?\burl\s*=\s*)([\s\S]*)$/is.exec(value);
            if (!m) return whole;
            const abs = toAbsolute(decodeHtmlEntities(m[2].trim()), baseUrl);
            if (abs === null) return whole;
            const out = rewrite(abs);
            if (out === null) return whole;
            // Re-encode `&` so a rewritten query stays a valid attribute value.
            return `${name}${quote}${m[1]}${out.replace(/&/g, '&amp;')}${quote}`;
        });
    });

    return content;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function rewriteCss(content: string, baseUrl: string, rewrite: UrlRewriter): string {
    const URL_RE = /url\(\s*["']?(.*?)["']?\s*\)/gi;
    content = content.replace(URL_RE, (match, ref: string) => {
        const abs = toAbsolute(ref, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        if (out === null) return match;
        return `url(${out})`;
    });

    const IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(.+?)["']?\s*\)?\s*;/gi;
    content = content.replace(IMPORT_RE, (match, ref: string) => {
        const clean = ref.replace(/['"]/g, '').trim();
        const abs = toAbsolute(clean, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        if (out === null) return match;
        return `@import "${out}";`;
    });

    return content;
}

// ---------------------------------------------------------------------------
// JavaScript (ES module specifiers)
// ---------------------------------------------------------------------------

/** A module specifier is only worth rewriting if it resolves to a real URL:
 * relative (./ ../), root-relative (/), protocol-relative (//), or absolute
 * (scheme://). Bare names ("react") and non-URL fragments ("+m+") are left
 * alone -- rewriting them would corrupt ordinary code (e.g. the English word
 * "from" inside a string) and bare package names aren't archivable URLs. */
function isUrlSpecifier(ref: string): boolean {
    const r = ref.trim();
    if (!r) return false;
    if (r.startsWith('./') || r.startsWith('../') || r.startsWith('/')) return true;
    if (r.startsWith('//')) return true;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(r);
}

function rewriteJs(content: string, baseUrl: string, rewrite: UrlRewriter): string {
    // Dynamic import: import('x') / import("x")
    content = content.replace(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (match, q: string, ref: string) => {
        if (!isUrlSpecifier(ref)) return match;
        const abs = toAbsolute(ref, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        return out === null ? match : `import(${q}${out}${q})`;
    });

    // Static side-effect import at a statement boundary: `import 'x';`
    content = content.replace(/(^|[;{}])\s*(import)\s+(['"])([^'"]+)\3\s*;?/g,
        (match, pre: string, kw: string, q: string, ref: string) => {
            if (!isUrlSpecifier(ref)) return match;
            const abs = toAbsolute(ref, baseUrl);
            if (abs === null) return match;
            const out = rewrite(abs);
            return out === null ? match : `${pre}${kw} ${q}${out}${q};`;
        });

    // import ... from 'x'; export ... from 'x';
    content = content.replace(/\b(from)\s+(['"])([^'"]+)\2/g, (match, kw: string, q: string, ref: string) => {
        if (!isUrlSpecifier(ref)) return match;
        const abs = toAbsolute(ref, baseUrl);
        if (abs === null) return match;
        const out = rewrite(abs);
        return out === null ? match : `${kw} ${q}${out}${q}`;
    });

    return content;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function rewriteContent(
    content: string,
    baseUrl: string,
    rewrite: UrlRewriter,
    kind: ContentKind,
): string {
    if (kind === 'js') return rewriteJs(content, baseUrl, rewrite);
    if (kind === 'css') return rewriteCss(content, baseUrl, rewrite);
    return rewriteHtml(content, baseUrl, rewrite);
}

/** Classify a resource as html/css/js for rewriting, or null if it is not
 * text we should rewrite (binary, JSON, plain text, ...).
 *
 * The decision rests on the archive's own content-type -- the mime already
 * resolved at ingest (the restorer falls back to the record's HTTP
 * content-type, then the CDXJ mime). The URL's extension is deliberately not
 * consulted: a `.php`/`.asp`/`.jsp`/`.cgi` path was server-rendered to HTML
 * *before* it was archived, so the extension describes the template, not the
 * bytes. The mime is what the response actually was. */
export function detectContentKind(mime: string): ContentKind | null {
    const m = (mime || '').toLowerCase();
    if (/html/.test(m)) return 'html';
    if (/css/.test(m)) return 'css';
    if (/javascript|ecmascript/.test(m)) return 'js';
    return null;
}
