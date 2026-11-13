'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deid', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  expandPaths: (paths) => ipcRenderer.invoke('expand-paths', paths),
  chooseOutDir: () => ipcRenderer.invoke('choose-outdir'),
  process: (paths, options) => ipcRenderer.invoke('process-files', paths, options),
  saveAll: (payload, outDir) => ipcRenderer.invoke('save-all', payload, outDir),
  loadDictionaryCsv: () => ipcRenderer.invoke('dictionary-csv'),
  saveDictionaryTemplate: () => ipcRenderer.invoke('dictionary-template'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  restore: (text, map) => ipcRenderer.invoke('restore', text, map),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  onProgress: (cb) => {
    ipcRenderer.on('progress', (event, data) => cb(data));
  },
  // Electron 32+ removed File.path; webUtils is the supported way to get it.
  pathFor: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (_) { /* older Electron */ }
    return file && file.path ? file.path : '';
  }
});
