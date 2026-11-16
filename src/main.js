'use strict';
// Electron entry point.
//   electron .               -> full app
//   electron . --login-only  -> just the Unity sign-in window (used by `uad login`);
//                               exits 0 on success, 1 if the window is closed.

const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeTheme, Notification } = require('electron');
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
let batch = { done: 0, failed: 0, names: [] }; // for the "finished" notification

/** Start queued downloads while there is room (also called when concurrency changes). */
function pump() {
    const limit = store.loadConfig().concurrency;
    while (waiting.length && running < limit) {
        running++;
        waiting.shift()();
    }
}
function acquire(signal) {
    return new Promise((resolve, reject) => {
        const go = () => { signal.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = () => {
            const i = waiting.indexOf(go);
            if (i >= 0) {
                waiting.splice(i, 1);
                reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(go);
        pump();
    });
}
function release() {
    running--;
    pump();
}

// Keep shown notifications referenced: if the JS object is garbage-collected,
// macOS may drop the notification and its click handler.
const liveNotifications = new Set();

function notify(title, body) {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title, body, silent: false });
    liveNotifications.add(n);
    const forget = () => liveNotifications.delete(n);
    n.on('click', () => { forget(); if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.on('close', forget);
    n.on('failed', (_e, err) => { forget(); console.error('[notify] failed:', err); });
    setTimeout(forget, 5 * 60 * 1000);
    n.show();
    return true;
}

function batchFinished() {
    const { done, failed, names } = batch;
    batch = { done: 0, failed: 0, names: [] };
    if (!store.loadConfig().notify || done + failed === 0) return;
    const title = failed ? `Downloads finished – ${failed} failed` : 'Downloads finished';
    const body = done === 1 && !failed ? names[0] : `${done} downloaded${failed ? `, ${failed} failed` : ''}`;
    notify(title, body);
    // Extra nudge on macOS when the app is in the background.
    if (process.platform === 'darwin' && app.dock && !(mainWindow && mainWindow.isFocused())) app.dock.bounce('informational');
}

function applyTheme(theme) {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
}

async function startDownload(asset) {
    if (active.has(asset.id)) return { status: 'already-running' };
    const ac = new AbortController();
    active.set(asset.id, ac);
    const send = (ch, payload) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(ch, payload);
    send('download:progress', { id: asset.id, state: 'queued' });
    try {
        await acquire(ac.signal);
        try {
            if (ac.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            const cfg = store.loadConfig();
            const dir = cfg.downloadDir;
            const result = await client.download(asset, {
                dir, signal: ac.signal,
                subfolder: cfg.layout === 'publisher' ? (asset.publisher || 'Unknown publisher') : undefined,
                keepOld: cfg.keepOldVersions,
                // "Update": replace the outdated copy the renderer told us about.
                // Only ever delete files inside the download folder.
                replaceFile: asset.replaceFile &&
                    !path.relative(path.resolve(dir), path.resolve(asset.replaceFile)).startsWith('..')
                    ? asset.replaceFile : undefined,
                onProgress: (p) => send('download:progress', { id: asset.id, state: 'downloading', ...p }),
            });
            send('download:progress', { id: asset.id, state: 'done', ...result });
            batch.done++;
            batch.names.push(asset.name);
            return result;
        } finally {
            release();
        }
    } catch (e) {
        const cancelled = e.name === 'AbortError' || ac.signal.aborted;
        const payload = { id: asset.id, state: cancelled ? 'cancelled' : 'error', error: e.message, auth: e instanceof AuthError };
        if (!cancelled) batch.failed++;
        send('download:progress', payload);
        return payload;
    } finally {
        active.delete(asset.id);
        if (active.size === 0) batchFinished();
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
    ipcMain.handle('config:set', (_e, patch) => {
        const cfg = store.saveConfig(patch);
        applyTheme(cfg.theme);
        pump(); // concurrency may have gone up
        return cfg;
    });
    ipcMain.handle('config:defaults', () => store.DEFAULT_CONFIG);
    ipcMain.handle('app:info', () => ({
        version: app.getVersion(), configDir: store.CONFIG_DIR,
        notificationsSupported: Notification.isSupported(),
    }));
    ipcMain.handle('shell:openConfigDir', () => shell.openPath(store.CONFIG_DIR));
    ipcMain.handle('notify:test', () => ({
        shown: notify('Unity Asset Downloader', 'Notifications are working.'),
        // Under `npm start` macOS sees the generic Electron binary, not this app.
        appName: process.platform === 'darwin' && !app.isPackaged ? 'Electron' : app.getName(),
        platform: process.platform,
    }));
    ipcMain.handle('notify:openSystemSettings', () => {
        if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
        else if (process.platform === 'win32') shell.openExternal('ms-settings:notifications');
    });
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
    applyTheme(store.loadConfig().theme);
    registerIpc();
    createMainWindow();
});

app.on('window-all-closed', () => {
    if (LOGIN_ONLY) return; // handled by login() resolution
    app.quit();
});
