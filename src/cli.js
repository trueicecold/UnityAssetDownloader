#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const store = require('./core/store');
const { AssetStoreClient, AuthError, getLocalStatus, runPool } = require('./core/api');

const HELP = `Unity Asset Downloader – CLI

Usage: uad <command> [options]

Commands
  login                      Sign in through the Unity web login window
  login --cookie "<str>"     Headless: use a Cookie header copied from a signed-in
                             assetstore.unity.com browser request
  logout                     Forget the saved session
  status                     Show whether the saved session is valid
  list [search]              List owned assets with local download state
      --updates              Only assets whose downloaded copy is outdated
      --json                 Machine-readable output
  download <id|name>...      Download .unitypackage files
      --all                  Every owned asset (optionally narrowed by --search)
      --updates              Every asset whose downloaded copy is outdated
      --search <text>        Only assets matching text (with --all)
      --out <dir>            Destination (default: config downloadDir)
      -j, --jobs <n>         Parallel downloads (default: config concurrency)
      --force                Re-download even if the copy is already up to date
  config [key] [value]       Show / set settings (shared with the app):
                               downloadDir      folder path
                               concurrency      1-8
                               layout           flat | publisher
                               keepOldVersions  true | false
                               notify           true | false (app only)
                               theme            system | light | dark (app only)
  gui                        Launch the desktop app

Packages in the download folder are recognised by the Asset Store metadata
embedded in each .unitypackage. Up-to-date ones are skipped, outdated ones are
replaced by the new version, and interrupted downloads resume. Session: ${store.SESSION_FILE}
`;

// ───────── tiny arg parser ─────────

function parseArgs(argv) {
    const out = { _: [] };
    const aliases = { j: 'jobs', h: 'help' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && isNaN(Number(a)))) {
            let [k, v] = a.replace(/^--?/, '').split(/=(.*)/s);
            k = aliases[k] || k;
            if (v === undefined) {
                const flagOnly = ['json', 'all', 'force', 'help', 'updates'].includes(k);
                v = flagOnly || i + 1 >= argv.length || argv[i + 1].startsWith('-') ? true : argv[++i];
            }
            out[k] = v;
        } else {
            out._.push(a);
        }
    }
    return out;
}

// ───────── helpers ─────────

const fmtSize = (n) => {
    if (!n) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
};
const pad = (s, n) => {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
};

function client() {
    return new AssetStoreClient({
        cookies: store.loadCookies(),
        onCookiesChanged: (c) => store.saveCookies(c),
    });
}

function parseCookieString(str) {
    const cookies = {};
    for (const part of String(str).replace(/^cookie:\s*/i, '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return cookies;
}

// Inside a packaged build the CLI is run by the app's own executable in Node
// mode (see bin/uad, bin/uad.cmd), so the GUI is just process.execPath.
const PACKAGED = !!process.versions.electron && __dirname.includes('app.asar');

function electronBinary() {
    if (PACKAGED) return process.execPath;
    try {
        return require('electron'); // resolves to the binary path when required from Node
    } catch {
        throw new Error('Electron is not installed. Run "npm install" in the project, or use: uad login --cookie "<cookie header>"');
    }
}

function runElectron(args) {
    return new Promise((resolve, reject) => {
        // VS Code (and other Electron hosts) export ELECTRON_RUN_AS_NODE, which
        // would make the Electron binary behave like plain Node.
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const appArgs = PACKAGED ? args : [path.join(__dirname, '..'), ...args];
        const child = spawn(electronBinary(), appArgs, { stdio: 'inherit', env });
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
    });
}

// ───────── commands ─────────

async function cmdLogin(opts) {
    if (opts.cookie) {
        const cookies = parseCookieString(opts.cookie);
        const c = new AssetStoreClient({ cookies });
        const { total } = await c.listPage({ pageSize: 1 });
        store.saveCookies(c.cookies);
        console.log(`Signed in – ${total} assets on this account.`);
        return 0;
    }
    console.log('Opening the Unity sign-in window…');
    const code = await runElectron(['--login-only']);
    if (code === 0) {
        const { total } = await client().listPage({ pageSize: 1 });
        console.log(`${total} assets on this account.`);
    }
    return code;
}

async function cmdStatus() {
    const c = client();
    if (!c.hasSession()) {
        console.log('Not signed in. Run: uad login');
        return 2;
    }
    const { total } = await c.listPage({ pageSize: 1 });
    console.log(`Signed in – ${total} assets on this account.`);
    console.log(`Download folder: ${store.loadConfig().downloadDir}`);
    return 0;
}

async function cmdList(opts) {
    const query = opts._.join(' ');
    const assets = await client().listAll({
        query,
        onProgress: (n, t) => process.stderr.isTTY && process.stderr.write(`\rFetching… ${n}/${t}`),
    });
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

    const dir = store.loadConfig().downloadDir;
    const local = getLocalStatus(assets, dir);
    const shown = opts.updates ? assets.filter((a) => local[a.id]?.state === 'outdated') : assets;
    if (opts.json) {
        console.log(JSON.stringify(shown.map((a) => ({ ...a, local: local[a.id] || null })), null, 2));
        return 0;
    }
    const localLabel = (a) => {
        const l = local[a.id];
        if (!l) return '';
        const have = l.version ? `v${l.version}` : '?';
        return l.state === 'outdated' ? `UPDATE ${have} -> v${a.version}` : `have ${have}`;
    };
    console.log(`${pad('ID', 8)} ${pad('NAME', 46)} ${pad('PUBLISHER', 24)} ${pad('VERSION', 10)} ${pad('SIZE', 8)} LOCAL`);
    for (const a of shown) {
        console.log(`${pad(a.id, 8)} ${pad(a.name, 46)} ${pad(a.publisher, 24)} ${pad(a.version, 10)} ${pad(fmtSize(a.size), 8)} ${localLabel(a)}`);
    }
    const nDl = Object.values(local).length;
    const nOut = Object.values(local).filter((l) => l.state === 'outdated').length;
    console.log(`\n${shown.length} assets · ${nDl} downloaded · ${nOut} with updates (uad download --updates)`);
    return 0;
}

async function cmdDownload(opts) {
    const cfg = store.loadConfig();
    const dir = path.resolve(opts.out || cfg.downloadDir);
    const jobs = Math.max(1, Number(opts.jobs) || cfg.concurrency || 2);
    const c = client();

    if (!opts.all && !opts.updates && !opts._.length) {
        console.error('Specify asset IDs / names, --all or --updates. See: uad help');
        return 1;
    }

    process.stderr.write('Fetching your asset list…');
    const owned = await c.listAll({ query: opts.all && typeof opts.search === 'string' ? opts.search : '' });
    process.stderr.write('\r\x1b[K');
    const byId = new Map(owned.map((a) => [a.id, a]));
    const local = getLocalStatus(owned, dir);

    let targets = [];
    if (opts.updates) {
        targets = owned.filter((a) => local[a.id]?.state === 'outdated');
    } else if (opts.all) {
        targets = owned;
    } else {
        for (const term of opts._) {
            if (/^\d+$/.test(term)) {
                targets.push(byId.get(term) || { id: term, name: `asset-${term}` });
                continue;
            }
            const t = term.toLowerCase();
            const hits = owned.filter((a) => a.name.toLowerCase().includes(t));
            if (!hits.length) { console.error(`No owned asset matches "${term}"`); return 1; }
            const exact = hits.filter((a) => a.name.toLowerCase() === t);
            if (hits.length > 1 && exact.length !== 1) {
                console.error(`"${term}" is ambiguous:`);
                hits.slice(0, 20).forEach((a) => console.error(`  ${a.id}  ${a.name}  (${a.publisher})`));
                console.error('Use the numeric ID instead.');
                return 1;
            }
            targets.push(exact[0] || hits[0]);
        }
    }
    // Skip up-to-date copies unless --force.
    const upToDate = targets.filter((a) => local[a.id]?.state === 'downloaded');
    if (!opts.force) {
        for (const a of upToDate) console.log(`= ${a.name} (up to date${local[a.id].version ? `, v${local[a.id].version}` : ''})`);
        targets = targets.filter((a) => local[a.id]?.state !== 'downloaded');
    }
    if (!targets.length) { console.log('Nothing to download.'); return 0; }

    console.log(`Downloading ${targets.length} asset(s) to ${dir} (${jobs} at a time)`);

    // Live progress line (TTY only).
    const live = new Map();
    let finished = 0;
    const tty = process.stdout.isTTY;
    const draw = () => {
        if (!tty) return;
        const parts = [...live.entries()].map(([name, p]) =>
            `${pad(name, 28).trim()} ${p.total ? Math.floor((p.received / p.total) * 100) + '%' : fmtSize(p.received)}`);
        const line = `[${finished}/${targets.length}] ${parts.join(' | ')}`;
        process.stdout.write(`\r\x1b[K${line.slice(0, (process.stdout.columns || 120) - 1)}`);
    };
    const log = (msg) => { if (tty) process.stdout.write('\r\x1b[K'); console.log(msg); draw(); };

    const ac = new AbortController();
    process.on('SIGINT', () => { ac.abort(); log('\nInterrupted – partial downloads will resume next time.'); });

    let authFailed = false;
    const results = await runPool(targets, jobs, async (a) => {
        if (authFailed || ac.signal.aborted) throw new Error('skipped');
        live.set(a.name, { received: 0, total: a.size });
        draw();
        try {
            const l = local[a.id];
            const r = await c.download(a, {
                dir, signal: ac.signal,
                subfolder: cfg.layout === 'publisher' ? (a.publisher || 'Unknown publisher') : undefined,
                keepOld: cfg.keepOldVersions,
                replaceFile: l ? l.file : undefined, // update / re-download replaces the old copy
                onProgress: (p) => { live.set(a.name, p); draw(); },
            });
            finished++;
            live.delete(a.name);
            const what = l && l.state === 'outdated' ? `updated ${l.version ? `v${l.version} ` : ''}→ v${r.version || a.version}` : fmtSize(r.bytes);
            log(`✓ ${a.name}  ${what}  → ${path.basename(r.file)}${r.warning ? `\n  ! ${r.warning}` : ''}`);
            return r;
        } catch (e) {
            finished++;
            live.delete(a.name);
            if (e instanceof AuthError) authFailed = true;
            if (!ac.signal.aborted) log(`✗ ${a.name} (${a.id}): ${e.message}`);
            throw e;
        }
    });
    if (tty) process.stdout.write('\r\x1b[K');

    const failed = results.filter((r) => !r.ok).length;
    const dl = results.filter((r) => r.ok).length;
    const sk = opts.force ? 0 : upToDate.length;
    console.log(`Done: ${dl} downloaded, ${sk} up to date, ${failed} failed.`);
    if (authFailed) { console.error('Session expired – run: uad login'); return 2; }
    return failed ? 1 : 0;
}

function cmdConfig(opts) {
    const [key, value] = opts._;
    const cfg = store.loadConfig();
    if (!key) { console.log(JSON.stringify(cfg, null, 2)); return 0; }
    if (!(key in store.DEFAULT_CONFIG)) {
        console.error(`Unknown setting "${key}". Known: ${Object.keys(store.DEFAULT_CONFIG).join(', ')}`);
        return 1;
    }
    if (value === undefined) { console.log(cfg[key]); return 0; }
    const next = store.saveConfig({ [key]: value });
    if (String(next[key]) !== String(value) && key !== 'downloadDir') {
        console.error(`"${value}" is not valid for ${key}; it is now ${next[key]}.`);
        return 1;
    }
    console.log(`${key} = ${next[key]}`);
    return 0;
}

// ───────── main ─────────

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const opts = parseArgs(rest);
    switch (cmd) {
        case 'login': return cmdLogin(opts);
        case 'logout': store.clearSession(); console.log('Signed out.'); return 0;
        case 'status': return cmdStatus();
        case 'list': case 'ls': return cmdList(opts);
        case 'download': case 'dl': return cmdDownload(opts);
        case 'config': return cmdConfig(opts);
        case 'gui': return runElectron([]);
        case undefined: case 'help': case '-h': case '--help': console.log(HELP); return 0;
        default: console.error(`Unknown command "${cmd}"\n`); console.log(HELP); return 1;
    }
}

main().then((code) => process.exit(code), (e) => {
    if (e instanceof AuthError) { console.error(e.message); process.exit(2); }
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
