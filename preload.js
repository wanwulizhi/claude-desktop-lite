'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  history: (id) => ipcRenderer.invoke('sessions:history', id),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  listCommands: (cwd) => ipcRenderer.invoke('commands:list', cwd),
  listModels: () => ipcRenderer.invoke('models:list'),
  setModel: (model) => ipcRenderer.invoke('chat:setModel', model),
  setPermissionMode: (mode) => ipcRenderer.invoke('chat:setPermissionMode', mode),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  pickImages: () => ipcRenderer.invoke('files:pickImages'),
  toDataUrl: (file) => ipcRenderer.invoke('files:toDataUrl', file),
  // 剪贴板/浏览器拖入的 File 没有磁盘路径，getPathForFile 会返回空（新版 Electron 也可能抛错）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  start: (opts) => ipcRenderer.invoke('chat:start', opts),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  permission: (payload) => ipcRenderer.send('chat:permission', payload),
  stop: () => ipcRenderer.send('chat:stop'),
  onEvent: (cb) => {
    ipcRenderer.on('chat:event', (_e, ev) => cb(ev));
  },
  e2eDone: () => ipcRenderer.send('e2e:done'),
});
