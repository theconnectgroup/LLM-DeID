'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { processFiles, EXTENSIONS, safeName, countTokens } = require('./src/engine');
const { createEngine } = require('./src/redact');

const FILTERS = [
  { name: 'Documents', extensions: EXTENSIONS.map((e) => e.replace('.', '')) },
  { name: 'All files', extensions: ['*'] }
];

let win = null;

// One engine for the life of the process. Tokens stay stable across pastes and
// file batches, and the map lives in memory until the user saves it - closing
// the app is what discards it.
let sessionEngine = null;
let sessionSig = '';

function engineFor(options) {
  const opts = {
    dictionary: (options && options.dictionary) || [],
    keepList: (options && options.keepList) || [],
    keepPrivateIps: !!(options && options.keepPrivateIps)
  };
  const sig = JSON.stringify(opts);
  if (!sessionEngine) {
    sessionEngine = createEngine(opts);
    sessionSig = sig;
    return sessionEngine;
  }
  if (sig !== sessionSig) {
    // Settings changed. Rebuild on the new dictionary but carry the map, so a
    // value already tokenized keeps its token instead of getting a second one.
    const carried = sessionEngine.toJSON();
    sessionEngine = createEngine(opts);
    sessionEngine.loadJSON(carried);
    sessionSig = sig;
  }
  return sessionEngine;
}

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
  const opts = Object.assign({}, options, { engine: engineFor(options) });
  const result = await processFiles(paths, opts, (progress) => {
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

    // The map is deliberately not written here. It stays in memory for the
    // session unless the user saves it with 'save-map'.
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
  // The live engine already holds this session's map; a passed map is a fallback.
  if (sessionEngine) return sessionEngine.restore(text);
  const engine = createEngine({});
  if (map) engine.loadJSON(map);
  return engine.restore(text);
});

ipcMain.handle('tokenize-text', async (event, text, options) => {
  const body = String(text === null || text === undefined ? '' : text);
  if (!body.trim()) return { ok: false, error: 'Nothing to de-identify.' };
  const engine = engineFor(options);
  const secretsBefore = engine.secrets.length;
  const clean = engine.redact(body, 'Pasted text');
  const tally = countTokens(clean);
  return {
    ok: true,
    payload: clean,
    chars: body.length,
    tokens: tally.total,
    secrets: engine.secrets.length - secretsBefore,
    map: engine.toJSON()
  };
});

ipcMain.handle('save-map', async (event, map) => {
  if (!map || !Array.isArray(map.entries) || !map.entries.length) {
    return { ok: false, error: 'No map yet - de-identify something first.' };
  }
  const r = await dialog.showSaveDialog(win, {
    title: 'Save the redaction map',
    defaultPath: 'redaction-map.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(map, null, 2), 'utf8');
    return { ok: true, path: r.filePath, entries: map.entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('session-info', async () => ({
  entries: sessionEngine ? sessionEngine.tokenCount : 0,
  secrets: sessionEngine ? sessionEngine.secrets.length : 0
}));

ipcMain.handle('forget-session', async () => {
  // Drops the map and the quarantined-secret log without closing the app.
  const entries = sessionEngine ? sessionEngine.tokenCount : 0;
  const secrets = sessionEngine ? sessionEngine.secrets.length : 0;
  sessionEngine = null;
  sessionSig = '';
  return { ok: true, entries, secrets };
});

ipcMain.handle('open-folder', async (event, dir) => {
  if (!dir) return false;
  await shell.openPath(dir);
  return true;
});
