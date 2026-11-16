'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('uad', {
    authStatus: () => invoke('auth:status'),
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
    listAssets: () => invoke('assets:list'),
    onListProgress: (fn) => on('assets:progress', fn),
    download: (asset) => invoke('download:start', asset),
    cancel: (id) => invoke('download:cancel', id),
    onDownloadProgress: (fn) => on('download:progress', fn),
    getConfig: () => invoke('config:get'),
    setConfig: (patch) => invoke('config:set', patch),
    chooseDir: () => invoke('config:chooseDir'),
    reveal: (file) => invoke('shell:reveal', file),
    openDir: () => invoke('shell:openDir'),
    openExternal: (url) => invoke('shell:openExternal', url),
});
