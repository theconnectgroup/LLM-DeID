'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { processFiles, EXTENSIONS, safeName } = require('./src/engine');
const { createEngine } = require('./src/redact');

const FILTERS = [
  { name: 'Documents', extensions: EXTENSIONS.map((e) => e.replace('.', '')) },
  { name: 'All files', extensions: ['*'] }
];

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0f1115',
    title: 'LLM DeID ' + app.getVersion(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function walk(dir, out, depth) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '_llm_safe' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, out, depth + 1);
    } else if (EXTENSIONS.includes(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add files',
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return [];
  return walk(r.filePaths[0], [], 0);
});

ipcMain.handle('expand-paths', async (event, paths) => {
  const out = [];
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, out, 0);
      else if (EXTENSIONS.includes(path.extname(p).toLowerCase())) out.push(p);
    } catch { /* skip unreadable */ }
  }
  return out;
});

ipcMain.handle('choose-outdir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should the payloads go?', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('process-files', async (event, paths, options) => {
  const result = await processFiles(paths, options, (progress) => {
    if (win && !win.isDestroyed()) win.webContents.send('progress', progress);
  });
  return result;
});

ipcMain.handle('save-all', async (event, payload, outDir) => {
  if (!outDir) return { ok: false, error: 'No output folder chosen.' };
  try {
    fs.mkdirSync(outDir, { recursive: true });

    const written = [];
    for (const item of payload.items || []) {
      if (!item.payload) continue;
      const name = safeName(item.payloadName || (item.kind + '.llm.md'));
      fs.writeFileSync(path.join(outDir, name), item.payload, 'utf8');
      written.push(name);
    }

    if (payload.combined && payload.combinedName) {
      const combinedName = safeName(payload.combinedName);
      fs.writeFileSync(path.join(outDir, combinedName), payload.combined, 'utf8');
      written.push(combinedName);
    }

    if (payload.map) {
      fs.writeFileSync(path.join(outDir, 'redaction-map.json'), JSON.stringify(payload.map, null, 2), 'utf8');
    }
    if (payload.reportCsv && payload.includeReport !== false) fs.writeFileSync(path.join(outDir, '_report.csv'), payload.reportCsv, 'utf8');
    if (payload.secretsCsv && payload.secretCount > 0) {
      fs.writeFileSync(path.join(outDir, '_secrets.csv'), payload.secretsCsv, 'utf8');
    }

    return { ok: true, dir: outDir, written };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dictionary-csv', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Load a dictionary',
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  try {
    return { ok: true, name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dictionary-template', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save the dictionary template',
    defaultPath: 'dictionary-template.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false };
  const csv = 'Type,Name\r\nperson,Jane Doe\r\norg,Bridger Aerospace\r\nhost,PC-NAME-01\r\n';
  try {
    fs.writeFileSync(r.filePath, csv, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('restore', async (event, text, map) => {
  const engine = createEngine({});
  if (map) engine.loadJSON(map);
  return engine.restore(text);
});

ipcMain.handle('open-folder', async (event, dir) => {
  if (!dir) return false;
  await shell.openPath(dir);
  return true;
});
