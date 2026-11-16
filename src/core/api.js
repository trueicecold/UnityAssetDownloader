'use strict';
// Thin client for the (undocumented) Unity Asset Store web endpoints – the same
// ones the assetstore.unity.com "My Assets" page uses. Auth is the web session
// cookie obtained by signing in through the normal Unity ID web login.

const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { readPackageInfo, localStatus } = require('./local');

const ORIGIN = 'https://assetstore.unity.com';
const GRAPHQL_URL = `${ORIGIN}/api/graphql/batch`;
const DOWNLOAD_URL = `${ORIGIN}/api/downloads`;
const LOGIN_URL = `${ORIGIN}/auth/login?redirect_to=%2Faccount%2Fassets`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SEARCH_MY_ASSETS = `query SearchMyAssets($page: Int, $pageSize: Int, $q: [String], $tagging: [String!], $assignFrom: [String!], $ids: [String!], $sortBy: Int, $reverse: Boolean) {
  searchMyAssets(page: $page, pageSize: $pageSize, q: $q, tagging: $tagging, assignFrom: $assignFrom, ids: $ids, sortBy: $sortBy, reverse: $reverse) {
    results {
      id
      orderId
      grantTime
      tagging
      product {
        id
        productId
        name
        state
        downloadSize
        mainImage { icon75 icon }
        publisher { id name }
        currentVersion { id name publishedDate }
      }
    }
    total
  }
}`;

class AuthError extends Error {
    constructor(msg = 'Not signed in (or session expired). Run "uad login" or sign in from the app.') {
        super(msg);
        this.name = 'AuthError';
        this.code = 'EAUTH';
    }
}

const isAuthRedirect = (loc) => /oauth2\/authorize|id\.unity\.com|login\.unity\.com|\/auth\/login/.test(loc || '');

function sanitizeFilename(s) {
    return String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'package';
}

function filenameFromDisposition(cd) {
    if (!cd) return null;
    let m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) return decodeURIComponent(m[1].trim());
    m = /filename="?([^";]+)"?/i.exec(cd);
    return m ? decodeURIComponent(m[1].trim()) : null;
}

/** GraphQL returns protocol-relative ("//cdn…") or site-relative image URLs; make them absolute. */
function absoluteUrl(u) {
    if (!u || typeof u !== 'string') return null;
    u = u.trim();
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('/')) return `${ORIGIN}${u}`;
    if (/^http:\/\//i.test(u)) return u.replace(/^http:/i, 'https:');
    if (/^https:\/\//i.test(u)) return u;
    return `https://${u}`;
}

function normalizeAsset(r) {
    const p = r.product || {};
    return {
        id: String(p.id),
        productId: p.productId != null ? String(p.productId) : null,
        name: p.name || `Asset ${p.id}`,
        publisher: (p.publisher && p.publisher.name) || '',
        version: (p.currentVersion && p.currentVersion.name) || '',
        versionId: p.currentVersion && p.currentVersion.id != null ? String(p.currentVersion.id) : null,
        publishedDate: (p.currentVersion && p.currentVersion.publishedDate) || null,
        size: Number(p.downloadSize) || 0,
        icon: absoluteUrl(p.mainImage && (p.mainImage.icon75 || p.mainImage.icon)),
        iconAlt: absoluteUrl(p.mainImage && p.mainImage.icon),
        state: p.state || null,
        grantTime: r.grantTime || null,
        tags: r.tagging || [],
        url: `${ORIGIN}/packages/p/${p.id}`,
    };
}

class AssetStoreClient {
    /**
     * @param {object} opts
     * @param {Record<string,string>} opts.cookies   initial cookie jar (name -> value)
     * @param {(cookies: Record<string,string>) => void} [opts.onCookiesChanged]
     */
    constructor({ cookies = {}, onCookiesChanged } = {}) {
        this.cookies = { ...cookies };
        this.onCookiesChanged = onCookiesChanged || (() => {});
    }

    hasSession() {
        return Object.keys(this.cookies).length > 0;
    }

    cookieHeader() {
        return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /** Keep the jar in sync with Set-Cookie headers (session refresh / rotation). */
    absorb(res) {
        const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        if (!list.length) return;
        let changed = false;
        for (const line of list) {
            const [pair, ...attrs] = line.split(';');
            const eq = pair.indexOf('=');
            if (eq < 1) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            const expired = attrs.some((a) => {
                const [k, v] = a.split('=').map((x) => (x || '').trim().toLowerCase());
                return (k === 'max-age' && Number(v) <= 0) ||
                    (k === 'expires' && Date.parse(v) < Date.now());
            });
            if (expired || value === '') {
                if (name in this.cookies) { delete this.cookies[name]; changed = true; }
            } else if (this.cookies[name] !== value) {
                this.cookies[name] = value;
                changed = true;
            }
        }
        if (changed) this.onCookiesChanged({ ...this.cookies });
    }

    baseHeaders(extra = {}) {
        return {
            'user-agent': USER_AGENT,
            'accept-language': 'en-US,en;q=0.9',
            referer: `${ORIGIN}/`,
            cookie: this.cookieHeader(),
            ...extra,
        };
    }

    /** The GraphQL endpoint wants x-csrf-token == _csrf cookie. Fetch one if missing. */
    async ensureCsrf() {
        if (this.cookies._csrf) return;
        const res = await fetch(`${ORIGIN}/account/assets`, {
            headers: this.baseHeaders(), redirect: 'manual',
        });
        this.absorb(res);
        if (!this.cookies._csrf) throw new Error('Could not obtain a CSRF token from assetstore.unity.com');
    }

    async graphql(operations) {
        if (!this.hasSession()) throw new AuthError();
        await this.ensureCsrf();
        const res = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: this.baseHeaders({
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json;charset=UTF-8',
                origin: ORIGIN,
                'x-csrf-token': this.cookies._csrf,
                'x-requested-with': 'XMLHttpRequest',
                'x-source': 'storefront',
                operations: operations.map((o) => o.operationName).join(','),
            }),
            body: JSON.stringify(operations),
        });
        this.absorb(res);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch {
            if (res.status === 401 || res.status === 403) throw new AuthError();
            throw new Error(`Asset Store returned HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        if (!Array.isArray(json)) json = [json];
        for (const r of json) {
            if (!r.data && r.errors) {
                // Logged-out sessions get {data:null, errors:[GraphqlError]} with HTTP 500.
                if (res.status === 401 || res.status === 403 || res.status === 500) throw new AuthError();
                throw new Error(`GraphQL error: ${JSON.stringify(r.errors).slice(0, 300)}`);
            }
        }
        return json;
    }

    /** One page (0-based) of owned assets. */
    async listPage({ page = 0, pageSize = 100, query = '' } = {}) {
        const [r] = await this.graphql([{
            operationName: 'SearchMyAssets',
            query: SEARCH_MY_ASSETS,
            variables: {
                page, pageSize,
                q: query ? [query] : [],
                tagging: [], assignFrom: [], ids: [],
                sortBy: 7,
            },
        }]);
        const data = r.data.searchMyAssets;
        return { total: data.total || 0, assets: (data.results || []).map(normalizeAsset) };
    }

    /** Every owned asset, following pagination. */
    async listAll({ query = '', pageSize = 100, onProgress } = {}) {
        const first = await this.listPage({ page: 0, pageSize, query });
        const all = [...first.assets];
        const pages = Math.ceil(first.total / pageSize);
        onProgress && onProgress(all.length, first.total);
        for (let page = 1; page < pages; page++) {
            const { assets } = await this.listPage({ page, pageSize, query });
            if (!assets.length) break;
            all.push(...assets);
            onProgress && onProgress(all.length, first.total);
        }
        const seen = new Set();
        return all.filter((a) => !seen.has(a.id) && seen.add(a.id));
    }

    /**
     * Follow the download redirect chain by hand so we can spot the
     * "not signed in -> OAuth" redirect and only send cookies to unity.com.
     */
    async openDownload(id, { rangeStart = 0, signal } = {}) {
        let url = `${DOWNLOAD_URL}/${encodeURIComponent(id)}`;
        for (let hop = 0; hop < 8; hop++) {
            const host = new URL(url).hostname;
            const isUnity = host === 'unity.com' || host.endsWith('.unity.com');
            const headers = isUnity ? this.baseHeaders({ accept: '*/*' }) : { 'user-agent': USER_AGENT, accept: '*/*' };
            if (rangeStart > 0) headers.range = `bytes=${rangeStart}-`;
            const res = await fetch(url, { headers, redirect: 'manual', signal });
            if (host === 'assetstore.unity.com') this.absorb(res);
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location');
                await res.body?.cancel();
                if (!loc) throw new Error(`Redirect without location (HTTP ${res.status})`);
                if (isAuthRedirect(loc)) throw new AuthError();
                url = new URL(loc, url).toString();
                continue;
            }
            if (res.status === 401) throw new AuthError();
            if (res.status === 403) throw new Error('Forbidden – this account does not own this asset (or the Asset Store TOS has not been accepted yet).');
            if (res.status === 404) throw new Error('Asset not found or not downloadable (deprecated / no package uploaded).');
            if (res.status === 416) return { res, complete: true };
            if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
            const ctype = res.headers.get('content-type') || '';
            if (ctype.includes('text/html')) {
                await res.body?.cancel();
                throw new AuthError();
            }
            return { res, complete: false };
        }
        throw new Error('Too many redirects');
    }

    /**
     * Download an owned asset's .unitypackage into `dir`.
     * Resumable (partial data kept in dir/.partial). With `replaceFile`
     * (an outdated local copy) the old file is removed once the new one is in place.
     *
     * @returns {Promise<{status:'downloaded', file:string, bytes:number, version?:string, warning?:string}>}
     */
    async download(asset, { dir, replaceFile, signal, onProgress } = {}) {
        const id = typeof asset === 'object' ? asset.id : String(asset);
        const meta = typeof asset === 'object' ? asset : { id };
        fs.mkdirSync(dir, { recursive: true });
        const index = new DownloadIndex(dir);

        const partialDir = path.join(dir, '.partial');
        fs.mkdirSync(partialDir, { recursive: true });
        const partFile = path.join(partialDir, `${id}.part`);
        let start = 0;
        try { start = fs.statSync(partFile).size; } catch { /* fresh */ }

        let { res, complete } = await this.openDownload(id, { rangeStart: start, signal });
        let total = meta.size || 0;
        let received = start;

        if (!complete) {
            const resumed = res.status === 206;
            if (!resumed) received = 0;
            const cr = res.headers.get('content-range');
            const cl = Number(res.headers.get('content-length')) || 0;
            if (cr && /\/(\d+)/.test(cr)) total = Number(/\/(\d+)/.exec(cr)[1]);
            else if (cl) total = cl + (resumed ? start : 0);

            let last = 0;
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    received += chunk.length;
                    const now = Date.now();
                    if (onProgress && now - last > 150) { last = now; onProgress({ received, total }); }
                    cb(null, chunk);
                },
            });
            await pipeline(
                Readable.fromWeb(res.body),
                counter,
                fs.createWriteStream(partFile, { flags: resumed ? 'a' : 'w' }),
                { signal },
            );
            onProgress && onProgress({ received, total: total || received });
        } else {
            await res.body?.cancel();
        }

        // Pick a final name: server's Content-Disposition, else "Publisher - Name.unitypackage".
        let filename = filenameFromDisposition(res.headers.get('content-disposition'));
        if (!filename || !/\.unitypackage$/i.test(filename)) {
            const base = meta.name ? `${meta.publisher ? meta.publisher + ' - ' : ''}${meta.name}` : `asset-${id}`;
            filename = `${base}.unitypackage`;
        }
        filename = sanitizeFilename(filename);
        const finalPath = path.join(dir, filename);
        fs.renameSync(partFile, finalPath); // overwrites a same-named older copy

        // An update may come with a different file name – drop the outdated copy.
        if (replaceFile && path.resolve(replaceFile) !== path.resolve(finalPath)) {
            try { fs.unlinkSync(replaceFile); } catch { /* already gone */ }
        }

        // A .unitypackage is a gzipped tar with Asset Store metadata in its header.
        let warning;
        const info = readPackageInfo(finalPath);
        const fd = fs.openSync(finalPath, 'r');
        const magic = Buffer.alloc(2);
        fs.readSync(fd, magic, 0, 2, 0);
        fs.closeSync(fd);
        if (!(magic[0] === 0x1f && magic[1] === 0x8b)) {
            warning = 'File does not look like a gzip .unitypackage – it may be encrypted or an error page.';
        }

        const bytes = fs.statSync(finalPath).size;
        const version = (info && info.version) || meta.version || null;
        const versionId = (info && info.versionId) || meta.versionId || null;
        index.set(id, { file: filename, version, versionId, name: meta.name || null, bytes, at: new Date().toISOString() });
        return { status: 'downloaded', file: finalPath, bytes, version, versionId, warning };
    }
}

/**
 * dir/.uad-index.json : asset id -> { file, version, versionId, ... }.
 * Fallback for packages whose header carries no Asset Store metadata.
 */
class DownloadIndex {
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, '.uad-index.json');
    }
    read() {
        try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
    }
    get(id) { return this.read()[id] || null; }
    set(id, entry) {
        const all = this.read();
        all[id] = entry;
        fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    }
    /** Entries with absolute file paths. */
    entries() {
        const out = {};
        for (const [id, e] of Object.entries(this.read())) {
            if (e && e.file) out[id] = { ...e, file: path.resolve(this.dir, e.file) };
        }
        return out;
    }
}

/**
 * What's already in the download folder for each owned asset:
 * id -> { state: 'downloaded'|'outdated', file, version, versionId }
 */
function getLocalStatus(assets, dir) {
    return localStatus(assets, dir, new DownloadIndex(dir).entries());
}

/** Run `fn` over items with at most `n` in flight. */
async function runPool(items, n, fn) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { results[idx] = { ok: true, value: await fn(items[idx], idx) }; } catch (error) { results[idx] = { ok: false, error }; }
        }
    });
    await Promise.all(workers);
    return results;
}

module.exports = {
    AssetStoreClient, AuthError, DownloadIndex, getLocalStatus, runPool,
    ORIGIN, LOGIN_URL, USER_AGENT,
};
