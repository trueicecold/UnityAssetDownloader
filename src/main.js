'use strict';
// Electron entry point.
//   electron .               -> full app
//   electron . --login-only  -> just the Unity sign-in window (used by `uad login`);
//                               exits 0 on success, 1 if the window is closed.

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const store = require('./core/store');
const { AssetStoreClient, AuthError, getLocalStatus, ORIGIN, LOGIN_URL, USER_AGENT } = require('./core/api');

const LOGIN_ONLY = process.argv.includes('--login-only');
const PARTITION = 'persist:unity';

let mainWindow = null;
let client = makeClient();

function makeClient() {
    return new AssetStoreClient({
        cookies: store.loadCookies(),
        onCookiesChanged: (c) => store.saveCookies(c),
    });
}

function unitySession() {
    const ses = session.fromPartition(PARTITION);
    // Google / Apple SSO refuse "Electron" user agents.
    ses.setUserAgent(USER_AGENT);
    return ses;
}

async function cookiesFromSession() {
    const list = await unitySession().cookies.get({ url: ORIGIN });
    return Object.fromEntries(list.map((c) => [c.name, c.value]));
}

let loginInFlight = null; // { win, promise } – only one login window at a time

/** Opens the real Unity ID web login in its own window; resolves true once the Asset Store accepts the session. */
function login() {
    if (loginInFlight && !loginInFlight.win.isDestroyed()) {
        loginInFlight.win.show();
        loginInFlight.win.focus();
        return loginInFlight.promise;
    }
    const win = new BrowserWindow({
        width: 520, height: 760, center: true,
        title: 'Sign in to Unity',
        minimizable: false, fullscreenable: false,
        show: false,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    const promise = new Promise((resolve) => {
        // SSO providers open popups; keep them in the same session.
        win.webContents.setWindowOpenHandler(() => ({
            action: 'allow',
            overrideBrowserWindowOptions: { webPreferences: { partition: PARTITION } },
        }));

        let done = false;
        let checking = false;
        const check = async (url) => {
            if (done || checking) return;
            let u;
            try { u = new URL(url); } catch { return; }
            if (u.hostname !== 'assetstore.unity.com' || u.pathname.startsWith('/auth')) return;
            checking = true;
            try {
                const cookies = await cookiesFromSession();
                const probe = new AssetStoreClient({ cookies });
                await probe.listPage({ pageSize: 1 });
                store.saveCookies(probe.cookies);
                client = makeClient();
                done = true;
                resolve(true);
                win.close();
            } catch (e) {
                // Not signed in yet (landing page before login) – keep waiting.
                if (!(e instanceof AuthError)) console.error('[login] probe failed:', e.message);
            } finally {
                checking = false;
            }
        };
        win.webContents.on('did-navigate', (_e, url) => check(url));
        win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
        win.on('closed', () => {
            loginInFlight = null;
            if (!done) resolve(false);
            // Bring the app back to front after the dialog goes away.
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
        });
        win.loadURL(LOGIN_URL);
    });
    loginInFlight = { win, promise };
    return promise;
}

async function logout() {
    store.clearSession();
    await unitySession().clearStorageData();
    client = makeClient();
}

// ───────────── downloads (queued, cancellable) ─────────────

const active = new Map(); // id -> AbortController
let running = 0;
const waiting = [];

function acquire() {
    const limit = Math.max(1, store.loadConfig().concurrency || 2);
    if (running < limit) { running++; return Promise.resolve(); }
    return new Promise((r) => waiting.push(r));
}
function release() {
    const next = waiting.shift();
    if (next) next(); else running--;
}

async function startDownload(asset) {
    if (active.has(asset.id)) return { status: 'already-running' };
    const ac = new AbortController();
    active.set(asset.id, ac);
    const send = (ch, payload) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(ch, payload);
    send('download:progress', { id: asset.id, state: 'queued' });
    try {
        await acquire();
        try {
            if (ac.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            const dir = store.loadConfig().downloadDir;
            const result = await client.download(asset, {
                dir, signal: ac.signal,
                // "Update": replace the outdated copy the renderer told us about.
                // Only ever delete files inside the download folder.
                replaceFile: asset.replaceFile &&
                    !path.relative(path.resolve(dir), path.resolve(asset.replaceFile)).startsWith('..')
                    ? asset.replaceFile : undefined,
                onProgress: (p) => send('download:progress', { id: asset.id, state: 'downloading', ...p }),
            });
            send('download:progress', { id: asset.id, state: 'done', ...result });
            return result;
        } finally {
            release();
        }
    } catch (e) {
        const cancelled = e.name === 'AbortError' || ac.signal.aborted;
        const payload = { id: asset.id, state: cancelled ? 'cancelled' : 'error', error: e.message, auth: e instanceof AuthError };
        send('download:progress', payload);
        return payload;
    } finally {
        active.delete(asset.id);
    }
}

// ───────────── IPC ─────────────

function registerIpc() {
    const wrap = (fn) => async (...args) => {
        try { return { ok: true, value: await fn(...args) }; } catch (e) {
            return { ok: false, error: e.message, auth: e instanceof AuthError };
        }
    };

    ipcMain.handle('auth:status', wrap(() => ({ loggedIn: client.hasSession() })));
    ipcMain.handle('auth:login', wrap(() => login()));
    ipcMain.handle('auth:logout', wrap(logout));

    ipcMain.handle('assets:list', wrap(async () => {
        const assets = await client.listAll({
            onProgress: (n, total) => mainWindow?.webContents.send('assets:progress', { n, total }),
        });
        const dir = store.loadConfig().downloadDir;
        return { assets, local: getLocalStatus(assets, dir) };
    }));

    ipcMain.handle('download:start', (_e, asset) => startDownload(asset));
    ipcMain.handle('download:cancel', (_e, id) => { active.get(id)?.abort(); return true; });

    ipcMain.handle('config:get', () => store.loadConfig());
    ipcMain.handle('config:set', (_e, patch) => store.saveConfig(patch));
    ipcMain.handle('config:chooseDir', async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: store.loadConfig().downloadDir,
        });
        if (r.canceled || !r.filePaths[0]) return store.loadConfig();
        return store.saveConfig({ downloadDir: r.filePaths[0] });
    });

    ipcMain.handle('shell:reveal', (_e, file) => shell.showItemInFolder(file));
    ipcMain.handle('shell:openDir', () => shell.openPath(store.loadConfig().downloadDir));
    ipcMain.handle('shell:openExternal', (_e, url) => {
        if (/^https:\/\/([a-z0-9-]+\.)*unity\.com\//i.test(url)) shell.openExternal(url);
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1180, height: 800, minWidth: 760, minHeight: 500,
        title: 'Unity Asset Downloader',
        backgroundColor: '#15171c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
        // Closing the main window quits the app (also on macOS), taking any
        // open sign-in window with it.
        app.quit();
    });
}

app.whenReady().then(async () => {
    if (LOGIN_ONLY) {
        const ok = await login();
        if (ok) console.log(`Signed in. Session saved to ${store.SESSION_FILE}`);
        else console.error('Login window closed before sign-in completed.');
        app.exit(ok ? 0 : 1);
        return;
    }
    registerIpc();
    createMainWindow();
});

app.on('window-all-closed', () => {
    if (LOGIN_ONLY) return; // handled by login() resolution
    app.quit();
});
