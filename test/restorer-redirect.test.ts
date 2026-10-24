import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRedirectUrl } from "../src/restore/fetch.js";

// A redirect found while restoring must stay inside the archive: a historical
// Location is re-fetched through Wayback at the same capture time, never
// followed to the live web, while a playback Location is already a replay route
// and is followed unchanged.

test("a historical redirect is followed through Wayback, never to the live web", () => {
  const current =
    "https://web.archive.org/web/19961022175327id_/http://a.example/x";
  assert.equal(
    resolveRedirectUrl("http://b.example/y", current),
    "https://web.archive.org/web/19961022175327id_/http://b.example/y",
  );
  // A relative Location resolves against the captured URL, not against the
  // Wayback route.
  assert.equal(
    resolveRedirectUrl("/next", current),
    "https://web.archive.org/web/19961022175327id_/http://a.example/next",
  );
  // A playback Location is already a Wayback route and is followed unchanged,
  // whether it arrives absolute or relative to the Wayback host.
  assert.equal(
    resolveRedirectUrl(
      "https://web.archive.org/web/19980101000000id_/http://a.example/x",
      current,
    ),
    "https://web.archive.org/web/19980101000000id_/http://a.example/x",
  );
  assert.equal(
    resolveRedirectUrl(
      "/web/19980101000000id_/http://a.example/x",
      current,
      true,
    ),
    "https://web.archive.org/web/19980101000000id_/http://a.example/x",
  );
  assert.equal(
    resolveRedirectUrl("/web/19980101000000id_/http://a.example/x", current),
    "https://web.archive.org/web/19980101000000id_/http://a.example/x",
  );
  assert.equal(resolveRedirectUrl("mailto:someone@example.com", current), null);
});
