/**
 * wacz-append.ts
 *
 * Helpers for reading an existing WACZ and appending records to it, shared by
 * the downloader and the Wayback restorer. Both tools support incremental
 * output: if the destination file already exists it is read back, its records
 * are carried over byte-for-byte, and only new records are appended. These
 * routines load that existing archive and build the CDXJ/resource metadata the
 * two writers emit identically.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { ZipReader } from './zip.js';
import { surtKey } from '../lib/url.js';

/** The `software` token written to the `warcinfo` record and datapackage.json,
 * in WARC 1.1's own `ProductToken/Version` form. */
export const SOFTWARE = 'WaybackArchiver/1.0.0';

/** MIME types that represent a web page (HTML) rather than a subresource. */
export function isHtmlMime(mime: string): boolean {
    const m = mime.toLowerCase();
    return m.includes('text/html') || m.includes('application/xhtml+xml');
}

/** Everything needed from an existing WACZ to append to it. */
export interface ExistingArchive {
    title: string;
    warcGz: Buffer;
    indexLines: string[];
    pagesText: string;
    datapackage: Record<string, unknown>;
}

/** Load an existing WACZ for appending, or null when the file is absent. */
export function loadExisting(filePath: string): ExistingArchive | null {
    if (!fs.existsSync(filePath)) return null;
    const z = ZipReader.open(filePath);
    const names = z.names();

    const warcNames = names.filter((n) => n.endsWith('.warc') || n.endsWith('.warc.gz'));
    if (warcNames.length !== 1) {
        throw new Error(
            `${filePath} is not a single-WARC archive (found ${warcNames.length} archive entries); append is unsupported.`,
        );
    }
    const indexName = names.find((n) => n.endsWith('.cdx') && !n.endsWith('.cdx.gz'))
        || names.find((n) => n.endsWith('.cdx'));
    if (!indexName) {
        throw new Error(`${filePath} exists but has no CDX index — not a WACZ.`);
    }

    let datapackage: Record<string, unknown> = {};
    try {
        datapackage = JSON.parse(z.readEntry('datapackage.json').toString('utf8'));
    } catch {
        /* datapackage.json is optional */
    }

    const warcGz = z.readEntry(warcNames[0]);
    const indexLines = z.readEntry(indexName).toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    let pagesText = '';
    try {
        pagesText = z.readEntry('pages/pages.jsonl').toString('utf8');
    } catch {
        /* pages.jsonl is optional */
    }

    return {
        title: typeof datapackage.title === 'string' ? datapackage.title : '',
        warcGz,
        indexLines,
        pagesText,
        datapackage,
    };
}

/** A datapackage.json `resources` entry: name, path, sha256 hash, and byte size. */
export function resource(name: string, p: string, data: Buffer): Record<string, unknown> {
    return {
        name,
        path: p,
        hash: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
    };
}

/** A CDXJ index line: SURT key, 17-digit timestamp, and the JSON locating the
 * record within `data.warc.gz`. */
export function indexLine(url: string, ts: string, status: number, mime: string, digest: string, offset: number, length: number): string {
    const json = {
        url,
        digest,
        mime,
        offset,
        length,
        status,
        filename: 'data.warc.gz',
    };
    return `${surtKey(url)} ${ts} ${JSON.stringify(json)}`;
}
