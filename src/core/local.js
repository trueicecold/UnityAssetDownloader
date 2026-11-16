'use strict';
// Detect .unitypackage files in the download folder and work out whether
// they are up to date. Asset Store packages carry their metadata (id, version,
// version_id, title, publisher, …) as JSON in a gzip FEXTRA subfield "A$",
// so any package is identifiable regardless of where it came from.

const fs = require('fs');
const path = require('path');

/** Read the Asset Store metadata embedded in a .unitypackage, or null. */
function readPackageInfo(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(12);
        if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
        if (head[0] !== 0x1f || head[1] !== 0x8b || !(head[3] & 0x04)) return null; // gzip + FEXTRA
        const xlen = head.readUInt16LE(10);
        const extra = Buffer.alloc(xlen);
        fs.readSync(fd, extra, 0, xlen, 12);
        for (let i = 0; i + 4 <= xlen;) {
            const id = extra.toString('latin1', i, i + 2);
            const len = extra.readUInt16LE(i + 2);
            if (id === 'A$') {
                const j = JSON.parse(extra.toString('utf8', i + 4, i + 4 + len));
                return {
                    id: j.id != null ? String(j.id) : (j.link && String(j.link.id)) || null,
                    version: j.version || null,
                    versionId: j.version_id != null ? String(j.version_id) : null,
                    title: j.title || null,
                    publisher: (j.publisher && j.publisher.label) || null,
                    pubdate: j.pubdate || null,
                };
            }
            i += 4 + len;
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

// path -> { mtimeMs, size, info } so rescans only re-read changed files.
const cache = new Map();

function* walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth > 0) yield* walk(p, depth - 1); } else if (/\.unitypackage$/i.test(e.name)) yield p;
    }
}

/**
 * Scan folders for .unitypackage files.
 * @returns {Array<{file, size, mtimeMs, id, version, versionId, title, publisher}>}
 */
function scanPackages(dirs, { maxDepth = 6 } = {}) {
    const out = [];
    const seen = new Set();
    for (const dir of dirs) {
        for (const file of walk(dir, maxDepth)) {
            const real = path.resolve(file);
            if (seen.has(real)) continue;
            seen.add(real);
            let st;
            try { st = fs.statSync(real); } catch { continue; }
            let c = cache.get(real);
            if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
                c = { mtimeMs: st.mtimeMs, size: st.size, info: readPackageInfo(real) };
                cache.set(real, c);
            }
            out.push({ file: real, size: st.size, mtimeMs: st.mtimeMs, ...(c.info || {}) });
        }
    }
    return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Is the remote asset newer than the local copy? */
function isOutdated(asset, local) {
    // Same version id is conclusive. Otherwise prefer the human version name
    // (the GraphQL version id may not share an id space with the header's).
    if (asset.versionId && local.versionId && asset.versionId === local.versionId) return false;
    if (asset.version && local.version) return asset.version.trim() !== local.version.trim();
    if (asset.versionId && local.versionId) return Number(asset.versionId) > Number(local.versionId);
    return false; // can't tell – assume fine
}

/** Prefer the newest copy when several exist. */
function better(a, b) {
    if (!a) return b;
    if (a.versionId && b.versionId && a.versionId !== b.versionId) return Number(b.versionId) > Number(a.versionId) ? b : a;
    return b.mtimeMs > a.mtimeMs ? b : a;
}

/**
 * Match owned assets against local packages.
 * @param assets  owned assets (from AssetStoreClient.listAll)
 * @param dir     download folder to scan
 * @param index   optional DownloadIndex entries (id -> {file, version, versionId}) for files without metadata
 * @returns {Record<string, {state:'downloaded'|'outdated', file, version, versionId, copies}>}
 */
function localStatus(assets, dir, index = {}) {
    const pkgs = scanPackages([dir]);
    const byId = new Map();
    const byName = new Map();
    const count = new Map();
    for (const p of pkgs) {
        if (p.id) {
            byId.set(p.id, better(byId.get(p.id), p));
            count.set(p.id, (count.get(p.id) || 0) + 1);
        } else {
            // No metadata – remember by file name for a weak fallback match.
            byName.set(norm(path.basename(p.file, '.unitypackage')), p);
        }
    }

    const out = {};
    for (const a of assets) {
        let local = byId.get(a.id) || (a.productId && byId.get(a.productId));
        if (!local) {
            const ix = index[a.id];
            if (ix && ix.file && fs.existsSync(ix.file)) local = { file: ix.file, version: ix.version, versionId: ix.versionId };
        }
        if (!local) {
            const p = byName.get(norm(a.name));
            if (p) local = { file: p.file, version: null, versionId: null };
        }
        if (!local) continue;
        out[a.id] = {
            state: isOutdated(a, local) ? 'outdated' : 'downloaded',
            file: local.file,
            version: local.version || null,
            versionId: local.versionId || null,
            copies: count.get(a.id) || 1,
        };
    }
    return out;
}

module.exports = { readPackageInfo, scanPackages, localStatus, isOutdated };
