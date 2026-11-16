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
    concurrency: 2,
};

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
    return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
}

function saveConfig(patch) {
    const next = { ...loadConfig(), ...patch };
    writeJson(CONFIG_FILE, next, 0o644);
    return next;
}

module.exports = {
    CONFIG_DIR, SESSION_FILE, CONFIG_FILE,
    loadCookies, saveCookies, clearSession, loadConfig, saveConfig,
};
