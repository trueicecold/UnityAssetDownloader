'use strict';
// Shared on-disk state for the GUI and the CLI:
//   ~/.unity-asset-downloader/session.json  – Asset Store cookies (mode 0600)
//   ~/.unity-asset-downloader/config.json   – user settings (download dir, …)

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.UAD_HOME || path.join(os.homedir(), '.unity-asset-downloader');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
    downloadDir: path.join(os.homedir(), 'Downloads', 'UnityAssets'),
    concurrency: 2,          // parallel downloads (1-8)
    layout: 'flat',          // 'flat' | 'publisher' (one subfolder per publisher)
    keepOldVersions: false,  // on update: keep the previous file renamed "<name> (v1.2)"
    notify: true,            // desktop notification when a batch of downloads finishes
    theme: 'system',         // 'system' | 'light' | 'dark'
};

/** Coerce / clamp user-supplied settings; unknown keys are dropped. */
function validateConfig(c) {
    const out = { ...DEFAULT_CONFIG };
    if (typeof c.downloadDir === 'string' && c.downloadDir.trim()) out.downloadDir = path.resolve(c.downloadDir.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
    const n = parseInt(c.concurrency, 10);
    if (Number.isFinite(n)) out.concurrency = Math.min(8, Math.max(1, n));
    if (['flat', 'publisher'].includes(c.layout)) out.layout = c.layout;
    const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
    if (c.keepOldVersions !== undefined) out.keepOldVersions = bool(c.keepOldVersions);
    if (c.notify !== undefined) out.notify = bool(c.notify);
    if (['system', 'light', 'dark'].includes(c.theme)) out.theme = c.theme;
    return out;
}

function ensureDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, data, mode) {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
    fs.renameSync(tmp, file);
}

/** @returns {Record<string,string>} cookie name -> value */
function loadCookies() {
    return readJson(SESSION_FILE, {}).cookies || {};
}

function saveCookies(cookies) {
    writeJson(SESSION_FILE, { cookies, updatedAt: new Date().toISOString() }, 0o600);
}

function clearSession() {
    try { fs.unlinkSync(SESSION_FILE); } catch { /* already gone */ }
}

function loadConfig() {
    return validateConfig(readJson(CONFIG_FILE, {}));
}

function saveConfig(patch) {
    const next = validateConfig({ ...loadConfig(), ...patch });
    writeJson(CONFIG_FILE, next, 0o644);
    return next;
}

module.exports = {
    CONFIG_DIR, SESSION_FILE, CONFIG_FILE,
    DEFAULT_CONFIG, loadCookies, saveCookies, clearSession, loadConfig, saveConfig,
};
