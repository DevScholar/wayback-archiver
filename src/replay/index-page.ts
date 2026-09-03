/**
 * index-page.ts
 *
 * Renders the collection index page as HTML 4.01 (table layout, no CSS3) so
 * it can be viewed in legacy browsers, matching the project's "XP era" spirit.
 */

export interface IndexRow {
    /** Where the name cell links to (may be a file name or a replay route). */
    href: string;
    /** Text shown in the "File Name" column. */
    name: string;
    /** Text shown in the "Timestamp" column. */
    timestamp: string;
    /** Text shown in the "Original URL" column. */
    url: string;
    /** Optional preview image URL (relative), rendered in a leading column. */
    thumbnail?: string;
}

function escapeHtml(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const DEFAULT_HEADERS: [string, string, string] = ['File Name', 'Timestamp', 'Original URL'];

export function renderIndexPage(
    title: string,
    rows: IndexRow[],
    headers: [string, string, string] = DEFAULT_HEADERS,
): string {
    // A "Preview" column is added only when at least one row carries a
    // thumbnail, so archives without screenshots keep the classic 3-column
    // layout. The fixed-width timestamp column shifts right by one in that case.
    const hasThumbs = rows.some((r) => r.thumbnail);
    const tsIndex = hasThumbs ? 2 : 1;
    const headerRow = (hasThumbs ? ['Preview', ...headers] : [...headers])
        .map((h, i) => `<th${i === tsIndex ? ' width="180"' : ''}>${escapeHtml(h)}</th>`)
        .join('\n        ');

    const body = rows
        .map(
            (r, i) => {
                const cls = i % 2 === 0 ? 'row-norm' : 'row-alt';
                const thumbCell = hasThumbs
                    ? `<td>${r.thumbnail
                        ? `<a href="${escapeHtml(r.href)}"><img src="${escapeHtml(r.thumbnail)}" width="160" alt="" border="0"></a>`
                        : '&nbsp;'}</td>\n        `
                    : '';
                return `    <tr class="${cls}">
        ${thumbCell}<td><a href="${escapeHtml(r.href)}">${escapeHtml(r.name)}</a></td>
        <td class="sml">${escapeHtml(r.timestamp)}</td>
        <td class="sml">${escapeHtml(r.url)}</td>
    </tr>`;
            },
        )
        .join('\n');

    return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${escapeHtml(title)}</title>
<style type="text/css">
    body { background-color: #FFFFFF; font-family: Verdana, Tahoma, Arial, sans-serif; font-size: 11px; margin: 15px; color: #000000; }
    h1 { font-size: 16px; color: #003399; border-bottom: 2px solid #003399; padding-bottom: 5px; margin-bottom: 15px; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #999999; }
    th { background-color: #ECE9D8; border: 1px solid #999999; padding: 4px; text-align: left; font-weight: bold; color: #333333; }
    td { border: 1px solid #999999; padding: 3px 5px; vertical-align: middle; }
    .row-alt { background-color: #F7F7F7; }
    .row-norm { background-color: #FFFFFF; }
    tr.row-norm:hover, tr.row-alt:hover { background-color: #FFFFCC; }
    a { color: #0000CC; text-decoration: none; }
    a:hover { text-decoration: underline; color: #FF0000; }
    .sml { color: #666666; font-size: 10px; }
    .footer { margin-top: 15px; font-size: 10px; color: #999999; text-align: center; border-top: 1px solid #CCCCCC; padding-top: 5px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)} (${rows.length} Pages)</h1>
<table cellpadding="0" cellspacing="0">
    <tr>
        ${headerRow}
    </tr>
${body}
</table>
<div class="footer">Generated on ${escapeHtml(new Date().toUTCString())}</div>
</body>
</html>
`;
}

/**
 * Build the index-page rows from the archive's pages. The replay server and the
 * flat export share everything about this step except how a page's URL becomes
 * the link target: the server points at a `/web/<ts>/<url>` replay route, the
 * export at a flat file name. That difference is passed in as `hrefFor`; it
 * returns null for a page that should be omitted (e.g. one the export wrote no
 * file for).
 */
export function buildPageRows(
    pages: { url: string; ts: string; title?: string }[],
    hrefFor: (url: string, ts: string) => string | null,
    thumbFor?: (url: string, ts: string) => string | null,
): IndexRow[] {
    const rows: IndexRow[] = [];
    for (const p of pages) {
        const href = hrefFor(p.url, p.ts);
        if (href === null) continue;
        const thumbnail = thumbFor ? thumbFor(p.url, p.ts) : null;
        rows.push({
            href,
            name: p.title || p.url,
            timestamp: p.ts,
            url: p.url,
            thumbnail: thumbnail ?? undefined,
        });
    }
    return rows;
}
