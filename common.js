/**
 * common.js
 * Shared helpers used by downloader.js, indexer.js and server.js.
 *
 * IMPORTANT: sanitizeSegment() must stay byte-for-byte identical between the
 * downloader (which names files on disk) and the server (which looks them up).
 * Keeping the single implementation here is what guarantees that.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// === Config loader ===

/** Resolve the platform-specific user documents directory. */
function getUserDocumentsDir() {
    const platform = os.platform();
    const home = os.homedir();
    if (platform === 'win32') {
        // On Windows, "My Documents" is typically under the user profile.
        // We try the env var first, then fall back to the well-known path.
        if (process.env.USERPROFILE) {
            const doc = path.join(process.env.USERPROFILE, 'Documents');
            if (fs.existsSync(doc)) return doc;
        }
        return path.join(home, 'Documents');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Documents');
    }
    // Linux / other Unix
    return path.join(home, 'Documents');
}

/**
 * Read config.json and resolve the `currentSaveLocation` field.
 * Replaces the `__USER_DOCUMENTS__` placeholder with the actual path.
 */
function loadConfig() {
    const configPath = path.join(__dirname, 'user-private', 'config.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const userDocs = getUserDocumentsDir();
    const resolved = raw.currentSaveLocation.replace('__USER_DOCUMENTS__', userDocs);
    return { currentSaveLocation: resolved };
}

// Max length before a path segment gets truncated + hashed.
const MAX_SEGMENT_LEN = 200;

/**
 * Turn one URL path segment into a filesystem-safe name.
 * - Replaces characters illegal on Windows/Linux with '_'.
 * - Collapses very long names to "first150_<md5-8><ext>" so we don't blow the
 *   255-char filename limit.
 * Case is preserved (JAPAN stays JAPAN, not Japan).
 */
function sanitizeSegment(name) {
    let safe = String(name).replace(/[<>:"/\\|?*]/g, '_');
    if (safe.length > MAX_SEGMENT_LEN) {
        const ext = path.extname(safe);
        const hash = crypto.createHash('md5').update(safe).digest('hex').substring(0, 8);
        safe = safe.substring(0, 150) + `_${hash}${ext}`;
    }
    return safe;
}

/** Escape a string for safe interpolation into HTML text or attributes. */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * True if `child` resolves to `parent` or a path inside it.
 * Used to keep request handling from escaping the archive root.
 */
function isPathInside(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { sanitizeSegment, escapeHtml, isPathInside, loadConfig, getUserDocumentsDir, MAX_SEGMENT_LEN };
