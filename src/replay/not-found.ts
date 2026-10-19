/**
 * not-found.ts
 *
 * The "this URL was not saved" page, shared by the flat HTML export and the
 * replay server. It is deliberately plain: no CSS, no styling, no images, and
 * no network requests, so it renders the same on an old browser and under
 * `file://`.
 *
 * The flat export writes this page once as `unarchived-message.html` and links
 * to it as `unarchived-message.html?url=<original>`; with no `url` argument the
 * page carries a tiny inline script that reads that query parameter and shows
 * it.
 *
 * The replay server knows the missing URL at request time, so it passes it in
 * and gets the same page with the address filled in directly, no script.
 */

/** Escape text for a UTF-8 HTML document (text content and attribute value). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the "not saved" page. Pass the missing URL to fill it in directly
 * (the server); omit it for the flat export's `?url=` script. */
export function renderNotFoundPage(url?: string): string {
  const shown = url === undefined ? "" : escapeHtml(url);
  const script =
    url !== undefined
      ? ""
      : `
<script type="text/javascript">
(function () {
  var m = /[?&]url=([^&]+)/.exec(location.search);
  var url = '';
  if (m) {
    try { url = decodeURIComponent(m[1].replace(/\\+/g, ' ')); } catch (e) { url = m[1]; }
  }
  var el = document.getElementById('url');
  if (el) {
    el.innerText = url || '(unknown URL)';
  }
})();
</script>`;

  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>URL not saved</title>
</head>
<body>
<h1>This URL was not saved in the archive</h1>
<p>The following address is not present in this archive:</p>
<p id="url">${shown}</p>${script}
</body>
</html>
`;
}
