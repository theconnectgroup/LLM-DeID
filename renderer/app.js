'use strict';

const state = { files: [], result: null, map: null };
const $ = (id) => document.getElementById(id);

const FORMAT_LABEL = { md: 'Markdown', txt: 'Plain text', json: 'JSON' };

// The Save button is the only place the chosen format shows now; the caveats live in the tip beside "Results".
function syncFormatUi() {
  const sel = $('opt-format');
  const f = sel ? sel.value : 'md';
  const label = FORMAT_LABEL[f] || 'Markdown';
  const save = $('btn-save');
  if (save) save.textContent = 'Save ' + label + ' to folder\u2026';
}

function nameOf(p) {
  return String(p).split(/[\\/]/).pop();
}

function renderFiles() {
  const list = $('file-list');
  list.textContent = '';
  state.files.forEach((f) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = f.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      state.files = state.files.filter((x) => x.path !== f.path);
      renderFiles();
    });
    li.append(span, btn);
    list.appendChild(li);
  });
  $('file-count').textContent = String(state.files.length);
  $('files-panel').hidden = state.files.length === 0;
  $('btn-run').disabled = state.files.length === 0;
}

async function addPaths(paths) {
  if (!paths || !paths.length) return;
  const expanded = await window.deid.expandPaths(paths);
  const seen = new Set(state.files.map((f) => f.path.toLowerCase()));
  for (const p of expanded) {
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    state.files.push({ path: p, name: nameOf(p) });
  }
  renderFiles();
  setStatus(expanded.length ? expanded.length + ' file(s) added' : 'No supported files in that selection');
}

function setStatus(text) {
  $('status').textContent = text || '';
}

function setBusy(busy) {
  $('btn-run').disabled = busy || state.files.length === 0;
  const badge = $('engine-badge');
  badge.textContent = busy ? 'working' : 'ready';
  badge.className = 'badge' + (busy ? ' busy' : '');
}

function parseDictionary(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(person|org|name|host|machine)\s*:\s*(.+)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const type = kind === 'org' ? 'ORG' : (kind === 'host' || kind === 'machine') ? 'HOST' : 'NAME';
      out.push({ value: m[2].trim(), type });
    } else if (line.length >= 2) out.push({ value: line, type: 'NAME' });
  }
  return out;
}

// Minimal CSV reader: quoted cells and doubled quotes, nothing fancier.
function csvRows(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

const TYPE_LABEL = { person: 'person', name: 'person', org: 'org', host: 'host', machine: 'host' };

async function loadDictionaryCsv() {
  const res = await window.deid.loadDictionaryCsv();
  if (!res || !res.ok) {
    if (res && res.error) setStatus('CSV failed: ' + res.error);
    return;
  }
  const known = new Set(parseDictionary($('dict').value).map((e) => e.type + '|' + e.value.toLowerCase()));
  const add = [];
  for (const cells of csvRows(res.text)) {
    const a = (cells[0] || '').trim();
    const b = (cells[1] || '').trim();
    let kind;
    let value;
    if (b && TYPE_LABEL[a.toLowerCase()]) { kind = TYPE_LABEL[a.toLowerCase()]; value = b; }
    else if (cells.length === 1 && a) { kind = 'person'; value = a; }
    else if (b && !TYPE_LABEL[a.toLowerCase()]) { kind = 'person'; value = b; }
    else continue;
    if (!value) continue;
    if (/^(name|value)$/i.test(value) && /^(type|kind)$/i.test(a)) continue; // header row
    const type = kind === 'org' ? 'ORG' : kind === 'host' ? 'HOST' : 'NAME';
    const key = type + '|' + value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    add.push(kind + ': ' + value);
  }
  if (!add.length) { setStatus('No new names in that CSV.'); return; }
  const box = $('dict');
  box.value = (box.value.trim() ? box.value.replace(/\s+$/, '') + '\n' : '') + add.join('\n');
  setStatus(add.length + ' name' + (add.length === 1 ? '' : 's') + ' added from ' + res.name);
}

async function saveDictionaryTemplate() {
  const res = await window.deid.saveDictionaryTemplate();
  if (res && res.ok) setStatus('Template saved to ' + res.path);
  else if (res && res.error) setStatus('Template failed: ' + res.error);
}

function badgeFor(item) {
  if (item.complete === 'EMPTY') return ['bad', 'No text'];
  if (item.complete === 'ERROR') return ['bad', 'Error'];
  if (item.complete === 'PARTIAL') return ['warn', 'Partial'];
  return ['good', 'Complete'];
}

function renderResults() {
  const result = state.result;
  if (!result) return;

  $('results-panel').hidden = false;
  const tally = $('tally');
  tally.textContent = '';
  const add = (label, value, cls) => {
    const div = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    if (cls) strong.style.color = cls;
    div.appendChild(strong);
    div.appendChild(document.createTextNode(label));
    tally.appendChild(div);
  };
  add('values replaced', result.tokenCount);
  add('secrets quarantined', result.secretCount, result.secretCount ? 'var(--warn)' : null);
  add(result.items.length === 1 ? 'file' : 'files', result.items.length);

  const list = $('results');
  list.textContent = '';
  for (const item of result.items) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'head';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.source;

    const right = document.createElement('div');
    right.className = 'row';
    right.style.marginTop = '0';

    const [cls, label] = badgeFor(item);
    const tag = document.createElement('span');
    tag.className = 'tag ' + cls;
    tag.textContent = label;
    right.appendChild(tag);

    let preview = null;
    if (item.payload) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'ghost';
      show.textContent = 'Preview';
      preview = document.createElement('pre');
      preview.className = 'preview';
      preview.hidden = true;
      preview.textContent = item.payload;
      show.addEventListener('click', () => {
        preview.hidden = !preview.hidden;
        show.textContent = preview.hidden ? 'Preview' : 'Hide';
      });
      right.appendChild(show);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        const ok = await copyText(item.payload);
        copy.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });
      right.appendChild(copy);
    }

    head.append(name, right);
    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    bits.push(item.complete === 'EMPTY' ? 'No text extracted' : (item.formatLabel || 'Plain text'));
    if (item.chars) bits.push(item.chars.toLocaleString() + ' characters');
    if (item.tokens) bits.push(item.tokens + ' values replaced');
    if (item.secrets) bits.push(item.secrets + ' secret' + (item.secrets === 1 ? '' : 's') + ' quarantined');
    meta.textContent = bits.join(' · ');
    li.appendChild(meta);

    if (item.note) {
      const note = document.createElement('div');
      note.className = 'note' + (item.complete === 'EMPTY' || item.complete === 'ERROR' ? ' bad' : '');
      note.textContent = item.note;
      li.appendChild(note);
    }

    if (preview) li.appendChild(preview);
    list.appendChild(li);
  }

  const withPayload = result.items.filter((it) => it.payload).length;
  $('btn-copy-all').hidden = withPayload < 2;

  if (result.secretCount > 0) {
    setStatus('Secrets were replaced — read _secrets.csv before sending anything.');
  } else {
    setStatus('Done.');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }
}

// The map is session state: it never reaches disk unless the user asks.
function updateMapUi() {
  const btn = $('btn-save-map');
  if (!btn) return;
  const entries = state.map && Array.isArray(state.map.entries) ? state.map.entries.length : 0;
  btn.hidden = entries === 0;
  btn.title = entries ? entries + ' entries in this session' : '';
  const forget = $('btn-forget');
  if (forget) forget.hidden = entries === 0;
}

async function runPaste() {
  const text = $('paste-in').value;
  if (!text.trim()) { $('paste-status').textContent = 'Nothing pasted.'; return; }
  const options = {
    dictionary: parseDictionary($('dict').value),
    keepList: $('keeplist').value.split(',').map((s) => s.trim()).filter(Boolean),
    keepPrivateIps: $('keepip').checked
  };
  const btn = $('btn-paste-run');
  btn.disabled = true;
  $('paste-status').textContent = 'Working\u2026';
  try {
    const res = await window.deid.tokenizeText(text, options);
    if (!res || !res.ok) {
      $('paste-status').textContent = (res && res.error) || 'Failed.';
      return;
    }
    $('paste-out').textContent = res.payload;
    $('paste-out').hidden = false;
    $('btn-paste-copy').hidden = false;
    state.map = res.map;
    updateMapUi();
    const bits = [res.chars.toLocaleString() + ' characters', res.tokens + ' values replaced'];
    if (res.secrets) bits.push(res.secrets + ' secret' + (res.secrets === 1 ? '' : 's') + ' quarantined');
    $('paste-status').textContent = bits.join(' \u00b7 ');
  } catch (err) {
    $('paste-status').textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function findTokens(text) {
  return String(text || '').match(/\[[A-Z]+_\d{2,4}\]/g) || [];
}

// The re-identify control only makes sense when the box holds tokens.
function syncPasteMode() {
  const btn = $('btn-paste-restore');
  if (!btn) return;
  btn.hidden = findTokens($('paste-in').value).length === 0;
}

async function reidentify() {
  const text = $('paste-in').value;
  if (!text.trim()) { $('paste-status').textContent = 'Nothing pasted.'; return; }
  const tokens = findTokens(text);
  if (!tokens.length) { $('paste-status').textContent = 'No tokens in that text.'; return; }

  const known = new Set();
  if (state.map && Array.isArray(state.map.entries)) {
    for (const e of state.map.entries) known.add(e.Token);
  }

  const btn = $('btn-paste-restore');
  btn.disabled = true;
  try {
    const out = await window.deid.restore(text, state.map);
    $('paste-out').textContent = out;
    $('paste-out').hidden = false;
    $('btn-paste-copy').hidden = false;

    const replaced = tokens.filter((t) => known.has(t)).length;
    const missing = tokens.length - replaced;
    if (!replaced) {
      $('paste-status').textContent = 'None of those tokens are in this session\u2019s map.';
      return;
    }
    let msg = replaced + ' token' + (replaced === 1 ? '' : 's') + ' replaced';
    if (missing) msg += ', ' + missing + ' left as ' + (missing === 1 ? 'it was' : 'they were') + ' (not in this session)';
    $('paste-status').textContent = msg;
  } catch (err) {
    $('paste-status').textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function saveMap() {
  const res = await window.deid.saveMap(state.map);
  if (res && res.ok) {
    setStatus('Map saved to ' + res.path + ' (' + res.entries + ' entries)');
  } else if (res && !res.canceled) {
    setStatus('Map not saved: ' + ((res && res.error) || 'unknown error'));
  }
}

async function forgetSession() {
  const entries = state.map && Array.isArray(state.map.entries) ? state.map.entries.length : 0;
  if (entries) {
    const msg = 'Drop the ' + entries + ' token' + (entries === 1 ? '' : 's') + ' held in memory?\n\n' +
      'The pasted text and the de-identified output are cleared as well, so neither can be restored.';
    if (!window.confirm(msg)) return;
  }
  const res = await window.deid.forgetSession();
  state.map = null;
  // state.result keeps its payloads; its copy of the map goes with everything else.
  if (state.result) state.result.map = null;
  $('paste-in').value = '';
  $('paste-out').textContent = '';
  $('paste-out').hidden = true;
  $('btn-paste-copy').hidden = true;
  $('paste-status').textContent = '';
  $('restore-out').value = '';
  $('restore-out').hidden = true;
  $('btn-copy-restored').hidden = true;
  syncPasteMode();
  updateMapUi();
  setStatus(res && res.ok ? 'Session cleared. Nothing is held in memory.' : 'Could not clear the session.');
}

async function run() {
  if (!state.files.length) return;
  const options = {
    dictionary: parseDictionary($('dict').value),
    keepList: $('keeplist').value.split(',').map((s) => s.trim()).filter(Boolean),
    keepPrivateIps: $('keepip').checked,
    outputFormat: $('opt-format').value,
    combine: $('opt-combine').checked
  };

  $('save-note').hidden = true;

  setBusy(true);
  setStatus('Reading files…');
  try {
    const result = await window.deid.process(state.files.map((f) => f.path), options);
    state.result = result;
    state.map = result.map;
    updateMapUi();
    renderResults();
  } catch (err) {
    setStatus('Failed: ' + err.message);
  } finally {
    setBusy(false);
  }
}

async function saveAll() {
  if (!state.result) return;
  const dir = await window.deid.chooseOutDir();
  if (!dir) return;
  const payload = Object.assign({}, state.result, { includeReport: $('opt-report').checked });
  const res = await window.deid.saveAll(payload, dir);
  const note = $('save-note');
  note.hidden = false;
  note.textContent = '';
  if (res.ok) {
    const line = document.createElement('div');
    line.textContent = 'Saved ' + res.written.length + ' file' + (res.written.length === 1 ? '' : 's') + ' to: ';
    const where = document.createElement('span');
    where.className = 'path';
    where.textContent = res.dir;
    line.appendChild(where);
    const names = document.createElement('div');
    names.className = 'path';
    names.textContent = res.written.join(', ');
    note.append(line, names);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'The map was not written. It stays in this window until you close the app \u2014 use Save map if you need to restore an answer later.';
    note.appendChild(hint);
    setStatus('Saved to ' + res.dir);
    window.deid.openFolder(res.dir);
  } else {
    note.textContent = 'Save failed: ' + res.error;
    setStatus('Save failed: ' + res.error);
  }
}

async function copyAll() {
  if (!state.result) return;
  const text = state.result.combined ||
    state.result.items.filter((it) => it.payload).map((it) => it.payload).join('\n\n');
  const ok = await copyText(text);
  const btn = $('btn-copy-all');
  btn.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.textContent = 'Copy all'; }, 1400);
}

async function restore() {
  const input = $('restore-in').value;
  if (!input.trim()) return;
  const out = await window.deid.restore(input, state.map);
  $('restore-out').value = out;
  $('restore-out').hidden = false;
  $('btn-copy-restored').hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const THEME_KEY = 'deid.theme';
  const themeSel = $('theme-select');

  const applyTheme = (name) => {
    document.documentElement.setAttribute('data-theme', name);
    if (themeSel) themeSel.value = name;
  };

  let savedTheme = 'midnight';
  try { savedTheme = localStorage.getItem(THEME_KEY) || 'midnight'; } catch (_) { /* storage blocked: keep default */ }
  applyTheme(savedTheme);

  if (themeSel) {
    themeSel.addEventListener('change', () => {
      applyTheme(themeSel.value);
      try { localStorage.setItem(THEME_KEY, themeSel.value); } catch (_) { /* not persisted */ }
    });
  }

  $('btn-files').addEventListener('click', async () => addPaths(await window.deid.pickFiles()));
  $('btn-folder').addEventListener('click', async () => addPaths(await window.deid.pickFolder()));
  $('btn-clear').addEventListener('click', () => {
    state.files = [];
    state.result = null;
    $('results-panel').hidden = true;
    setStatus('');
    renderFiles();
  });
  $('btn-run').addEventListener('click', run);
  $('btn-save').addEventListener('click', saveAll);
  $('btn-save-map').addEventListener('click', saveMap);
  $('btn-forget').addEventListener('click', forgetSession);
  $('btn-copy-all').addEventListener('click', copyAll);
  $('btn-paste-run').addEventListener('click', runPaste);
  $('btn-paste-restore').addEventListener('click', reidentify);
  $('paste-in').addEventListener('input', syncPasteMode);
  $('btn-paste-copy').addEventListener('click', async () => {
    const ok = await copyText($('paste-out').textContent);
    $('paste-status').textContent = ok ? 'Copied.' : 'Copy failed.';
  });
  $('opt-format').addEventListener('change', syncFormatUi);
  $('btn-dict-csv').addEventListener('click', loadDictionaryCsv);
  $('btn-dict-template').addEventListener('click', saveDictionaryTemplate);
  if (window.deid.appVersion) {
    window.deid.appVersion().then((v) => {
      document.title = 'LLM DeID ' + v;
      const el = $('app-version');
      if (el) el.textContent = 'v' + v;
    }).catch(() => {});
  }
  syncFormatUi();
  updateMapUi();
  $('btn-restore').addEventListener('click', restore);
  $('btn-copy-restored').addEventListener('click', async () => {
    await copyText($('restore-out').value);
    setStatus('Restored text copied.');
  });

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); });
  });
  dz.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => window.deid.pathFor(f)).filter(Boolean);
    await addPaths(paths);
  });

  window.deid.onProgress((p) => {
    setStatus('Reading ' + p.file + ' (' + (p.index + 1) + '/' + p.total + ')');
  });

  renderFiles();
});
