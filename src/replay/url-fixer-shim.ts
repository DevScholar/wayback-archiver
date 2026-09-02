/**
 * url-fixer-shim.ts
 *
 * The client-side script injected by the url-fixer plugin. It is a from-scratch
 * "wombat" equivalent: a small, zero-dependency runtime shim that patches the
 * browser APIs which produce URLs, so that every request a page makes -- even
 * one constructed dynamically at runtime -- is rewritten to stay inside the
 * replay.
 *
 * It reads its configuration from `window.__urlFixerConfig`, which the plugin
 * injects just before this script. Two modes are supported:
 *
 *   server -- rewrite every URL to a /web/<ts>/<url> route (captive: anything
 *            not in the archive becomes a local 404, so no request leaks to
 *            the live web).
 *   flat   -- rewrite a URL to its exported flat file name via an inline map.
 *
 * The string is deliberately plain ES5 (no template literals, no backticks) so
 * it can be embedded in a template literal and into any document without
 * escaping problems.
 */

export const URL_FIXER_SHIM = `(function () {
  'use strict';
  var cfg = window.__urlFixerConfig;
  if (!cfg || !cfg.pageUrl || window.__urlFixerInstalled) return;
  window.__urlFixerInstalled = true;

  var MODE = cfg.mode || 'server';
  var PAGE_URL = cfg.pageUrl;
  var TS = cfg.ts || '';
  var FLAT = cfg.flatMap || null;

  // ---- URL helpers ------------------------------------------------------
  function lookupKey(raw) {
    var s = String(raw);
    var h = s.indexOf('#');
    if (h >= 0) s = s.slice(0, h);
    var m = /^([a-zA-Z][a-zA-Z0-9+.\\-]*):\\/\\/([^\\/?#]*)/.exec(s);
    if (!m) return s;
    return m[1].toLowerCase() + '://' + m[2].toLowerCase() + s.slice(m[0].length);
  }
  var SKIP = /^(javascript|data|mailto|blob|about):/i;

  function toAbsolute(ref) {
    ref = String(ref).trim();
    if (!ref || ref.charAt(0) === '#' || SKIP.test(ref)) return null;
    // Already a replay route: leave it alone. Rewritten URLs flow back through
    // fixUrl (e.g. when a rewritten <img src> is read and set again, or when
    // innerHTML contains already-rewritten markup); re-resolving them against
    // PAGE_URL would stack a second /web/.../https://host prefix.
    if (/^\/web\/\d+\//.test(ref)) return null;
    try {
      if (ref.indexOf('//') === 0) {
        var b = new URL(PAGE_URL);
        return b.protocol + ref;
      }
      return new URL(ref, PAGE_URL).href;
    } catch (e) { return null; }
  }

  function rewrite(url) {
    var abs = toAbsolute(url);
    if (!abs) return null;
    if (MODE === 'flat') {
      if (!FLAT) return null;
      return FLAT[lookupKey(abs)] || null;
    }
    return '/web/' + TS + '/' + abs;
  }

  function fixUrl(url) {
    var r = rewrite(url);
    return r === null ? url : r;
  }

  // ---- fetch ------------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string') {
        input = fixUrl(input);
      } else if (input && typeof input === 'object' && typeof input.url === 'string' && typeof Request === 'function') {
        input = new Request(fixUrl(input.url), input);
      }
      return origFetch.call(this, input, init);
    };
  }

  // ---- XMLHttpRequest ---------------------------------------------------
  if (typeof XMLHttpRequest !== 'undefined') {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (arguments.length > 1) arguments[1] = fixUrl(url);
      return origOpen.apply(this, arguments);
    };
  }

  // ---- navigator.sendBeacon --------------------------------------------
  if (navigator && typeof navigator.sendBeacon === 'function') {
    var origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      return origBeacon.call(this, fixUrl(url), data);
    };
  }

  // ---- window.open ------------------------------------------------------
  var origWinOpen = window.open;
  if (typeof origWinOpen === 'function') {
    window.open = function (url) {
      if (arguments.length > 0 && url != null) arguments[0] = fixUrl(url);
      return origWinOpen.apply(this, arguments);
    };
  }

  // ---- location ---------------------------------------------------------
  try {
    if (typeof Location !== 'undefined' && Location.prototype) {
      var lh = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (lh && lh.set) {
        Object.defineProperty(Location.prototype, 'href', {
          configurable: true,
          get: lh.get,
          set: function (v) { lh.set.call(this, fixUrl(v)); }
        });
      }
      ['assign', 'replace'].forEach(function (m) {
        if (typeof Location.prototype[m] === 'function') {
          var origLoc = Location.prototype[m];
          Location.prototype[m] = function (url) { return origLoc.call(this, fixUrl(url)); };
        }
      });
    }
  } catch (e) {}

  // ---- element property setters (el.src = ..., el.href = ...) -----------
  function patchProp(proto, name) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set) return;
    var g = d.get, s = d.set;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: d.enumerable,
      get: g,
      set: function (v) { s.call(this, fixUrl(v)); }
    });
  }
  patchProp(typeof HTMLAnchorElement !== 'undefined' ? HTMLAnchorElement.prototype : null, 'href');
  patchProp(typeof HTMLAreaElement !== 'undefined' ? HTMLAreaElement.prototype : null, 'href');
  patchProp(typeof HTMLLinkElement !== 'undefined' ? HTMLLinkElement.prototype : null, 'href');
  patchProp(typeof HTMLImageElement !== 'undefined' ? HTMLImageElement.prototype : null, 'src');
  patchProp(typeof HTMLScriptElement !== 'undefined' ? HTMLScriptElement.prototype : null, 'src');
  patchProp(typeof HTMLIFrameElement !== 'undefined' ? HTMLIFrameElement.prototype : null, 'src');
  patchProp(typeof HTMLFormElement !== 'undefined' ? HTMLFormElement.prototype : null, 'action');
  patchProp(typeof HTMLVideoElement !== 'undefined' ? HTMLVideoElement.prototype : null, 'src');
  patchProp(typeof HTMLAudioElement !== 'undefined' ? HTMLAudioElement.prototype : null, 'src');
  patchProp(typeof HTMLSourceElement !== 'undefined' ? HTMLSourceElement.prototype : null, 'src');

  // ---- setAttribute / setAttributeNS ------------------------------------
  var URL_ATTRS = { href: 1, src: 1, action: 1, background: 1, poster: 1, data: 1, cite: 1, formaction: 1 };
  function fixSrcset(v) {
    // A candidate's URL is non-whitespace; a comma inside a query string is
    // part of the URL. Split only on a comma followed by whitespace or end.
    return String(v).split(/,(?=\\s|$)/).map(function (cand) {
      var m = /^(\\s*)(\\S+)([\\s\\S]*)$/.exec(cand);
      if (!m) return cand;
      var r = fixUrl(m[2]);
      return r === null ? cand : m[1] + r + m[3];
    }).join(',');
  }
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var ln = String(name).toLowerCase();
    if (ln === 'srcset' && value != null) value = fixSrcset(value);
    else if (URL_ATTRS[ln] && value != null) value = fixUrl(value);
    return origSetAttr.call(this, name, value);
  };
  var origSetAttrNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, name, value) {
    var ln = String(name).toLowerCase();
    if ((ln === 'href' || ln === 'xlink:href') && value != null) value = fixUrl(value);
    return origSetAttrNS.call(this, ns, name, value);
  };

  // ---- innerHTML / outerHTML / insertAdjacentHTML -----------------------
  // Many pages build markup from JSON at runtime (e.g. Magento
  // pageOverrides -> <img src>). Setting innerHTML parses the string natively:
  // the browser resolves the URLs without going through setAttribute or the
  // property setters above, so we rewrite URL attributes in the fragment
  // before it is parsed.
  function rewriteHtmlString(html) {
    return String(html)
      .replace(/((?:href|src|action|poster|background|formaction)\\s*=\\s*)(["'])([^"']*)\\2/gi, function (m, pre, q, url) {
        return pre + q + fixUrl(url) + q;
      })
      .replace(/(srcset\\s*=\\s*)(["'])([^"']*)\\2/gi, function (m, pre, q, v) {
        return pre + q + fixSrcset(v) + q;
      });
  }

  function patchHtmlProp(proto, name) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set) return;
    var g = d.get, s = d.set;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: d.enumerable,
      get: g,
      set: function (v) { s.call(this, rewriteHtmlString(v)); }
    });
  }
  patchHtmlProp(Element.prototype, 'innerHTML');
  patchHtmlProp(Element.prototype, 'outerHTML');

  if (typeof Element.prototype.insertAdjacentHTML === 'function') {
    var origInsertAdjacent = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (pos, html) {
      return origInsertAdjacent.call(this, pos, rewriteHtmlString(html));
    };
  }
})();
`;
