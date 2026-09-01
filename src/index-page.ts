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
    const body = rows
        .map(
            (r, i) => {
                const cls = i % 2 === 0 ? 'row-norm' : 'row-alt';
                return `    <tr class="${cls}">
        <td><a href="${escapeHtml(r.href)}">${escapeHtml(r.name)}</a></td>
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
        <th>${escapeHtml(headers[0])}</th>
        <th width="180">${escapeHtml(headers[1])}</th>
        <th>${escapeHtml(headers[2])}</th>
    </tr>
${body}
</table>
<div class="footer">Generated on ${escapeHtml(new Date().toUTCString())}</div>
</body>
</html>
`;
}
