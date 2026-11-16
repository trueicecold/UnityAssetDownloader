'use strict';
/* global uad */

const $ = (s) => document.querySelector(s);
const state = {
    assets: [],
    local: {},   // id -> { state: 'downloaded'|'outdated', file }
    dl: {},      // id -> live download state from main
    config: null,
    selected: new Set(), // asset ids
};
let lastChecked = null; // id of the last clicked checkbox, for shift-click ranges
const rows = new Map(); // id -> { li, action }

const fmtSize = (n) => {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function show(screen) {
    $('#signin').classList.toggle('hidden', screen !== 'signin');
    $('#app').classList.toggle('hidden', screen !== 'app');
}

function setStatus(msg, isError) {
    const el = $('#status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
}

// ───────── auth ─────────

async function doLogin() {
    $('#btn-login').disabled = true;
    $('#signin-msg').textContent = 'Complete sign-in in the Unity window…';
    const r = await uad.login();
    $('#btn-login').disabled = false;
    if (r.ok && r.value) {
        $('#signin-msg').textContent = '';
        show('app');
        loadAssets();
    } else {
        $('#signin-msg').textContent = r.ok ? 'Sign-in window closed.' : r.error;
    }
}

function handleAuthLost() {
    show('signin');
    $('#signin-msg').textContent = 'Your session expired – please sign in again.';
}

// ───────── list ─────────

async function loadAssets() {
    rows.clear();
    $('#list').replaceChildren();
    setStatus('Loading your assets…');
    $('#count').textContent = '';
    const off = uad.onListProgress(({ n, total }) => setStatus(`Loading your assets… ${n} / ${total}`));
    const r = await uad.listAssets();
    off();
    if (!r.ok) {
        if (r.auth) return handleAuthLost();
        return setStatus(`Failed to load assets: ${r.error}`, true);
    }
    state.assets = r.value.assets;
    // Keep the selection across refreshes, minus assets that disappeared.
    const ids = new Set(state.assets.map((a) => a.id));
    for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    state.local = r.value.local;
    setStatus(state.assets.length ? '' : 'No assets found on this account.');
    updateOutdatedButton();
    render();
}

function visibleAssets() {
    const q = $('#search').value.trim().toLowerCase();
    const filter = $('#filter').value;
    const sort = $('#sort').value;
    let list = state.assets.filter((a) => {
        if (q && !(`${a.name} ${a.publisher}`.toLowerCase().includes(q))) return false;
        const local = localState(a.id);
        if (filter === 'new') return !local;
        if (filter === 'downloaded') return local === 'downloaded';
        if (filter === 'outdated') return local === 'outdated';
        return true;
    });
    const by = {
        name: (a, b) => a.name.localeCompare(b.name),
        publisher: (a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name),
        size: (a, b) => b.size - a.size,
        updated: (a, b) => String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')),
        recent: (a, b) => String(b.grantTime || '').localeCompare(String(a.grantTime || '')),
    }[sort];
    if (by) list = [...list].sort(by);
    return list;
}

function localState(id) {
    return state.local[id] ? state.local[id].state : null;
}

function render() {
    const list = visibleAssets();
    $('#count').textContent = `${list.length}${list.length !== state.assets.length ? ` of ${state.assets.length}` : ''}`;
    const frag = document.createDocumentFragment();
    for (const a of list) frag.appendChild(rowFor(a).li);
    $('#list').replaceChildren(frag);
    updateSelectionUI(list);
    if (state.assets.length && !list.length) setStatus('Nothing matches the current filter.');
    else if (state.assets.length) setStatus('');
}

function rowFor(a) {
    let r = rows.get(a.id);
    if (r) return r;
    const li = document.createElement('li');
    li.className = 'row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pick';
    check.title = 'Select (shift-click to select a range)';
    check.onclick = (e) => {
        const on = check.checked;
        const list = visibleAssets();
        if (e.shiftKey && lastChecked && lastChecked !== a.id) {
            const i = list.findIndex((x) => x.id === lastChecked);
            const j = list.findIndex((x) => x.id === a.id);
            if (i >= 0 && j >= 0) {
                for (const x of list.slice(Math.min(i, j), Math.max(i, j) + 1)) setSelected(x.id, on);
            }
        }
        setSelected(a.id, on);
        lastChecked = a.id;
        updateSelectionUI(list);
    };
    check.checked = state.selected.has(a.id);
    li.classList.toggle('selected', check.checked);

    let img;
    if (a.icon) {
        img = document.createElement('img');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.onerror = () => {
            // Try the larger icon once, then fall back to the placeholder.
            if (a.iconAlt && img.src !== a.iconAlt) { img.src = a.iconAlt; return; }
            img.onerror = null;
            img.removeAttribute('src');
            img.className = 'noimg';
        };
        img.src = a.icon;
    } else {
        img = document.createElement('div');
        img.className = 'noimg';
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.name;
    name.title = 'Open on the Asset Store';
    name.onclick = () => uad.openExternal(a.url);
    const pub = document.createElement('div');
    pub.className = 'pub';
    pub.textContent = a.publisher + (a.state && a.state !== 'published' ? ` · ${a.state}` : '');
    meta.append(name, pub);

    const ver = document.createElement('div');
    ver.className = 'ver';
    ver.textContent = a.version ? `v${a.version}` : '';
    ver.title = a.publishedDate ? `Published ${new Date(a.publishedDate).toLocaleDateString()}` : '';
    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = fmtSize(a.size);

    const action = document.createElement('div');
    action.className = 'action';

    li.append(check, img, meta, ver, size, action);
    r = { li, action, name, check, asset: a };
    rows.set(a.id, r);
    updateAction(a.id);
    return r;
}

function updateAction(id) {
    const r = rows.get(id);
    if (!r) return;
    const a = r.asset;
    const d = state.dl[id];
    const local = state.local[id];
    const box = r.action;
    box.replaceChildren();

    const btns = document.createElement('div');
    btns.className = 'btns';
    const btn = (label, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.onclick = fn;
        btns.appendChild(b);
        return b;
    };
    const msg = (text, cls) => {
        const m = document.createElement('div');
        m.className = `pmsg ${cls || ''}`;
        m.textContent = text;
        m.title = text;
        box.appendChild(m);
    };

    // badge next to the name
    r.name.querySelector('.badge')?.remove();
    const ls = localState(id);
    if (ls) {
        const b = document.createElement('span');
        b.className = `badge ${ls === 'outdated' ? 'warn' : 'ok'}`;
        const have = local.version ? `v${local.version}` : 'older version';
        b.textContent = ls === 'outdated'
            ? `update: ${have} → v${a.version}`
            : `downloaded${local.version ? ` v${local.version}` : ''}`;
        b.title = local.file;
        r.name.appendChild(b);
    }

    if (d && (d.state === 'queued' || d.state === 'downloading')) {
        const bar = document.createElement('div');
        bar.className = 'progress';
        const fill = document.createElement('div');
        bar.appendChild(fill);
        if (d.state === 'downloading' && d.total) fill.style.width = `${Math.min(100, (d.received / d.total) * 100)}%`;
        else bar.classList.add('indeterminate');
        btn('Cancel', () => uad.cancel(id));
        box.append(btns, bar);
        msg(d.state === 'queued' ? 'Queued…' : `${fmtSize(d.received)} / ${fmtSize(d.total)}`);
        return;
    }

    const file = (d && d.file) || (local && local.file);
    if (ls === 'downloaded' && file) {
        btn('Show', () => uad.reveal(file));
        btn('Re-download', () => startDownload(a));
    } else if (ls === 'outdated') {
        btn('Show', () => uad.reveal(file));
        btn('Update', () => startDownload(a), 'primary');
    } else {
        btn('Download', () => startDownload(a), 'primary');
    }
    box.appendChild(btns);
    if (d && d.state === 'error') msg(d.error, 'error');
    else if (d && d.state === 'cancelled') msg('Cancelled (partial data kept, will resume)');
    else if (d && d.state === 'done' && d.warning) msg(d.warning, 'error');
    else if (d && d.state === 'done') msg(d.wasUpdate ? `Updated to v${d.version || a.version}` : `Saved ${fmtSize(d.bytes)}`, 'ok');
}

// ───────── selection ─────────

function setSelected(id, on) {
    if (on) state.selected.add(id); else state.selected.delete(id);
    const r = rows.get(id);
    if (r) {
        r.check.checked = on;
        r.li.classList.toggle('selected', on);
    }
}

function updateSelectionUI(list = visibleAssets()) {
    const n = state.selected.size;
    const visibleSel = list.filter((a) => state.selected.has(a.id)).length;
    const all = $('#select-all');
    all.checked = list.length > 0 && visibleSel === list.length;
    all.indeterminate = visibleSel > 0 && visibleSel < list.length;
    $('#sel-count').textContent = n ? `${n} selected${n !== visibleSel ? ` (${n - visibleSel} hidden by filter)` : ''}` : 'Select all shown';
    const btn = $('#btn-dl-selected');
    btn.disabled = !n;
    btn.textContent = n ? `Download selected (${n})` : 'Download selected';
    $('#btn-clear-sel').classList.toggle('hidden', !n);
}

function downloadSelected() {
    let picked = state.assets.filter((a) => state.selected.has(a.id) &&
        !['queued', 'downloading'].includes(state.dl[a.id]?.state));
    const current = picked.filter((a) => localState(a.id) === 'downloaded');
    if (current.length && current.length < picked.length) {
        if (!confirm(`${current.length} of the selected assets are already up to date.\n\nOK: re-download them too\nCancel: skip them`)) {
            picked = picked.filter((a) => localState(a.id) !== 'downloaded');
        }
    }
    if (!picked.length) return;
    const total = picked.reduce((s, a) => s + (a.size || 0), 0);
    if (picked.length > 5 && !confirm(`Download ${picked.length} assets (${fmtSize(total)})?`)) return;
    picked.forEach((a) => startDownload(a));
    for (const id of [...state.selected]) setSelected(id, false);
    updateSelectionUI();
}

async function startDownload(a) {
    if (['queued', 'downloading'].includes(state.dl[a.id]?.state)) return;
    // Re-download / update replaces the existing local copy.
    const existing = state.local[a.id];
    state.dl[a.id] = { state: 'queued', wasUpdate: existing?.state === 'outdated' };
    updateAction(a.id);
    updateQueueInfo();
    const res = await uad.download({ ...a, replaceFile: existing ? existing.file : undefined });
    if (res && res.auth) handleAuthLost();
}

function updateOutdatedButton() {
    const n = state.assets.filter((a) => localState(a.id) === 'outdated').length;
    const b = $('#btn-update-all');
    b.classList.toggle('hidden', !n);
    b.textContent = `Update all (${n})`;
}

function updateQueueInfo() {
    const vals = Object.values(state.dl);
    const running = vals.filter((d) => d.state === 'downloading').length;
    const queued = vals.filter((d) => d.state === 'queued').length;
    $('#queue-info').textContent = running || queued ? `${running} downloading · ${queued} queued` : '';
}

uad.onDownloadProgress((p) => {
    state.dl[p.id] = { ...(state.dl[p.id] || {}), ...p };
    if (p.state === 'done') {
        state.local[p.id] = { state: 'downloaded', file: p.file, version: p.version || rows.get(p.id)?.asset.version, versionId: p.versionId };
        updateOutdatedButton();
        if ($('#filter').value !== 'all') render();
    }
    updateAction(p.id);
    updateQueueInfo();
});

// ───────── wiring ─────────

async function refreshFolder() {
    state.config = await uad.getConfig();
    $('#btn-folder').textContent = state.config.downloadDir;
    $('#btn-folder').title = 'Change download folder';
}

$('#btn-login').onclick = doLogin;
$('#btn-logout').onclick = async () => {
    await uad.logout();
    state.assets = [];
    show('signin');
};
$('#btn-refresh').onclick = loadAssets;
$('#btn-folder').onclick = async () => {
    const prevDir = state.config && state.config.downloadDir;
    await uad.chooseDir();
    await refreshFolder();
    if (state.config.downloadDir !== prevDir) loadAssets(); // badges depend on folder
};
$('#btn-open-folder').onclick = () => uad.openDir();
$('#select-all').onchange = () => {
    const list = visibleAssets();
    const on = $('#select-all').checked;
    for (const a of list) setSelected(a.id, on);
    updateSelectionUI(list);
};
$('#btn-dl-selected').onclick = downloadSelected;
$('#btn-clear-sel').onclick = () => {
    for (const id of [...state.selected]) setSelected(id, false);
    updateSelectionUI();
};
$('#btn-update-all').onclick = () => {
    state.assets.filter((a) => localState(a.id) === 'outdated').forEach((a) => startDownload(a));
};
$('#btn-dl-visible').onclick = () => {
    // Not downloaded yet, or outdated.
    const todo = visibleAssets().filter((a) => localState(a.id) !== 'downloaded' &&
        !['queued', 'downloading'].includes(state.dl[a.id]?.state));
    if (!todo.length) return;
    if (todo.length > 5 && !confirm(`Download ${todo.length} assets (${fmtSize(todo.reduce((s, a) => s + a.size, 0))})?`)) return;
    todo.forEach((a) => startDownload(a));
};
let searchTimer;
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); };
$('#filter').onchange = render;
$('#sort').onchange = render;

// ───────── settings dialog ─────────

function fillSettings(cfg) {
    $('#set-dir').textContent = cfg.downloadDir;
    $('#set-dir').title = cfg.downloadDir;
    $('#set-concurrency').value = cfg.concurrency;
    $('#set-concurrency-val').textContent = cfg.concurrency;
    $('#set-layout').value = cfg.layout;
    document.querySelectorAll('input[name=keepOld]').forEach((r) => { r.checked = r.value === String(cfg.keepOldVersions); });
    $('#set-notify').checked = cfg.notify;
    $('#set-theme').value = cfg.theme;
}

async function saveSetting(patch) {
    const prevDir = state.config && state.config.downloadDir;
    state.config = await uad.setConfig(patch);
    fillSettings(state.config);
    await refreshFolder();
    if (state.config.downloadDir !== prevDir && state.assets.length) loadAssets(); // badges depend on folder
}

async function openSettings() {
    fillSettings(await uad.getConfig());
    const info = await uad.appInfo();
    $('#set-version').textContent = `v${info.version}`;
    $('#set-notify').disabled = !info.notificationsSupported;
    $('#settings').showModal();
}

$('#btn-settings').onclick = openSettings;
$('#set-dir-change').onclick = async () => {
    const prevDir = state.config && state.config.downloadDir;
    state.config = await uad.chooseDir();
    fillSettings(state.config);
    await refreshFolder();
    if (state.config.downloadDir !== prevDir && state.assets.length) loadAssets();
};
$('#set-dir-open').onclick = () => uad.openDir();
$('#set-concurrency').oninput = () => { $('#set-concurrency-val').textContent = $('#set-concurrency').value; };
$('#set-concurrency').onchange = () => saveSetting({ concurrency: Number($('#set-concurrency').value) });
$('#set-layout').onchange = () => saveSetting({ layout: $('#set-layout').value });
document.querySelectorAll('input[name=keepOld]').forEach((r) => { r.onchange = () => saveSetting({ keepOldVersions: r.value === 'true' }); });
$('#set-notify').onchange = () => saveSetting({ notify: $('#set-notify').checked });
$('#set-theme').onchange = () => saveSetting({ theme: $('#set-theme').value });
$('#set-configdir').onclick = () => uad.openConfigDir();
$('#set-notify-test').onclick = async () => {
    const r = await uad.testNotification();
    const help = $('#set-notify-help');
    help.replaceChildren();
    if (!r.shown) {
        help.textContent = 'Notifications are not supported on this system.';
    } else {
        const where = r.platform === 'darwin' ? 'System Settings → Notifications'
            : r.platform === 'win32' ? 'Settings → System → Notifications' : 'your notification settings';
        help.append(`Sent. Didn't see it? Allow notifications for “${r.appName}” in ${where}, and check that Focus / Do Not Disturb is off. `);
        if (r.platform === 'darwin' || r.platform === 'win32') {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'link';
            b.textContent = 'Open notification settings';
            b.onclick = () => uad.openNotificationSettings();
            help.append(b);
        }
    }
    help.classList.remove('hidden');
};
$('#set-reset').onclick = async () => {
    if (!confirm('Reset all settings (including the download folder) to defaults?')) return;
    const d = await uad.getDefaults();
    await saveSetting(d);
};
// Click on the backdrop closes the dialog.
$('#settings').addEventListener('click', (e) => { if (e.target === $('#settings')) $('#settings').close(); });
// Cmd/Ctrl + , opens settings.
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',' && !$('#app').classList.contains('hidden')) {
        e.preventDefault();
        openSettings();
    }
});

(async function init() {
    await refreshFolder();
    const r = await uad.authStatus();
    if (r.ok && r.value.loggedIn) {
        show('app');
        loadAssets();
    } else {
        show('signin');
    }
})();
