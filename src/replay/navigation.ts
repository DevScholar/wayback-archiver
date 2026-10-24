/**
 * navigation.ts
 *
 * Telling a page navigation apart from a subresource request. Only a navigation
 * may be redirected to the capture's own timestamp: the address bar shows that
 * URL to the visitor, so it should name the capture being served. A subresource
 * URL is an identity instead.
 */

import type { IncomingMessage } from "http";

/**
 * Whether a request asks for a page to be navigated to, rather than for a
 * resource that page uses.
 *
 * Only a navigation may be redirected to a different timestamp: the address bar
 * shows that URL to the visitor, so it should name the capture being served. A
 * subresource URL is an identity instead. Giving one file two URLs makes a
 * script load twice, and for an ES module that means two module instances, so
 * its top-level code runs twice and a repeated `customElements.define(...)`
 * throws. Keeping every subresource at the timestamp the page already uses
 * keeps one URL per file.
 *
 * The Fetch Metadata headers answer this exactly: a navigation is the only
 * request whose destination is a document ("document", or "iframe" for a frame)
 * and whose mode is "navigate". Browsers that send neither (or a command-line
 * client that sends no such header) get the body directly, which is harmless
 * because they have no address bar to keep faithful.
 */
export function isNavigationRequest(req: IncomingMessage): boolean {
  const destination = req.headers["sec-fetch-dest"];
  const mode = req.headers["sec-fetch-mode"];
  if (typeof destination === "string" || typeof mode === "string") {
    return (
      destination === "document" ||
      destination === "iframe" ||
      mode === "navigate"
    );
  }
  return false;
}
