'use strict';
// Orchestration: file list in, de-identified payloads + reports + map out.
// Pure Node - no Electron here, so it can be tested standalone.

const path = require('path');
const { extract } = require('./extract');
const { createEngine } = require('./redact');

const EXTENSIONS = [
  '.docx', '.doc', '.xlsx', '.xlsm', '.xls', '.pptx', '.ppt', '.pdf',
  '.eml', '.msg', '.txt', '.md', '.markdown', '.ps1', '.psm1', '.psd1',
  '.bat', '.cmd', '.csv', '.tsv', '.log', '.json', '.xml', '.config',
  '.yaml', '.yml', '.ini', '.reg', '.html', '.htm', '.sql', '.js', '.py', '.rtf'
];

const FORMATS = {
  md: { ext: '.llm.md', label: 'Markdown' },
  txt: { ext: '.llm.txt', label: 'Plain text' },
  json: { ext: '.llm.json', label: 'JSON' }
};

function safeName(name) {
  const cleaned = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return cleaned || 'payload';
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function countTokens(text) {
  const counts = {};
  let total = 0;
  for (const m of text.matchAll(/\[([A-Z]+)_(\d{2,4})\]/g)) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
    total++;
  }
  return { counts, total };
}

function normaliseFormat(value) {
  const f = String(value || 'md').toLowerCase();
  return FORMATS[f] ? f : 'md';
}

// One shape per format, so the caller never has to know how a payload was built.
function formatPayload(format, d) {
  const f = normaliseFormat(format);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  if (f === 'txt') {
    return { format: f, ext: FORMATS[f].ext, body: d.clean + '\n' };
  }

  if (f === 'json') {
    return {
      format: f,
      ext: FORMATS[f].ext,
      body: JSON.stringify({
        source: d.source,
        kind: d.kind,
        extracted: stamp,
        extraction: d.method,
        complete: d.complete,
        tokens: d.tokens,
        text: d.clean
      }, null, 2) + '\n'
    };
  }

  return {
    format: f,
    ext: FORMATS[f].ext,
    body: [
      '# Payload: ' + d.title,
      '',
      '- kind: ' + d.kind,
      '- extracted: ' + stamp,
      '- extraction: ' + d.method + ' (' + (d.complete === 'yes' ? 'complete' : String(d.complete).toLowerCase()) + ')',
      '- tokens in this payload: ' + d.tokens,
      '',
      '<!-- Identifiers have been replaced with stable tokens such as [EMAIL_01].',
      '     The same token always means the same real value. Treat tokens as opaque names. -->',
      '',
      '---',
      '',
      d.clean,
      ''
    ].join('\n')
  };
}

async function processFiles(paths, options, onProgress) {
  const opts = options || {};
  const outFormat = normaliseFormat(opts.outputFormat);
  // A caller can hand in a live engine so tokens stay stable across runs.
  const engine = opts.engine || createEngine({
    dictionary: opts.dictionary || [],
    keepList: opts.keepList || [],
    keepPrivateIps: !!opts.keepPrivateIps
  });

  const items = [];
  const usedNames = new Map();
  // Secrets accumulate on the engine for its whole life, so a batch reports only
  // what it added - otherwise every later _secrets.csv repeats the earlier ones.
  const secretStart = engine.secrets.length;

  for (let i = 0; i < paths.length; i++) {
    const full = paths[i];
    const base = path.basename(full);
    if (onProgress) onProgress({ index: i, total: paths.length, file: base });

    const item = {
      source: base, fullPath: full, kind: '', chars: 0, method: '',
      complete: 'yes', note: '', payloadName: '', payload: '', format: outFormat,
      formatLabel: FORMATS[outFormat].label,
      tokens: 0, names: 0, orgs: 0, identifiers: 0, secrets: 0
    };

    try {
      const ex = await extract(full);
      item.kind = ex.kind;
      item.method = ex.method;
      item.chars = ex.text.length;
      if (ex.lossy) item.complete = 'PARTIAL';
      if (ex.warning) item.note = ex.warning;

      if (ex.empty) {
        item.complete = 'EMPTY';
        item.note = 'NO TEXT EXTRACTED - do not send this file.';
        items.push(item);
        continue;
      }

      const secretsBefore = engine.secrets.length;
      const clean = engine.redact(ex.text, base);
      const tally = countTokens(clean);

      item.tokens = tally.total;
      item.names = tally.counts.NAME || 0;
      item.orgs = tally.counts.ORG || 0;
      item.identifiers = tally.total - item.names - item.orgs;
      item.secrets = engine.secrets.length - secretsBefore;

      const fmtd = formatPayload(outFormat, {
        source: base,
        title: engine.redact(base, base),
        kind: item.kind,
        method: item.method,
        complete: item.complete,
        tokens: tally.total,
        clean
      });

      // Output names follow the INPUT, not the token - the folder has to stay traceable.
      // opts.redactFilenames restores the old behaviour for anyone who needs it.
      const stem = path.basename(base, path.extname(base));
      const baseName = safeName(opts.redactFilenames ? engine.redact(stem, base) : stem);
      let outName = baseName + fmtd.ext;
      if (usedNames.has(outName.toLowerCase())) {
        const n = usedNames.get(outName.toLowerCase()) + 1;
        usedNames.set(outName.toLowerCase(), n);
        outName = baseName + '_' + n + fmtd.ext;
      } else {
        usedNames.set(outName.toLowerCase(), 1);
      }
      item.payloadName = outName;
      item.payload = fmtd.body;
    } catch (err) {
      item.complete = 'ERROR';
      item.note = err.message;
    }

    items.push(item);
  }

  // One file for everything, for the case where the model takes a single paste.
  let combined = null;
  let combinedName = '';
  if (opts.combine) {
    const parts = items.filter((it) => it.payload);
    if (parts.length > 1) {
      if (outFormat === 'json') {
        combined = JSON.stringify(parts.map((p) => JSON.parse(p.payload)), null, 2) + '\n';
        combinedName = 'all-documents' + FORMATS[outFormat].ext;
      } else {
        combined = parts.map((p) => p.payload).join('\n\n');
        combinedName = 'all-documents' + FORMATS[outFormat].ext;
      }
    }
  }

  const reportCsv = ['source,kind,chars,method,complete,names,orgs,identifiers,secrets,payload,note']
    .concat(items.map((it) => [
      it.source, it.kind, it.chars, it.method, it.complete,
      it.names, it.orgs, it.identifiers, it.secrets, it.payloadName, it.note
    ].map(csvCell).join(',')))
    .join('\n');

  const batchSecrets = engine.secrets.slice(secretStart);
  const secretsCsv = ['rule,length,context,line']
    .concat(batchSecrets.map((s) => [s.rule, s.length, s.context, s.line].map(csvCell).join(',')))
    .join('\n');

  // Distinct tokens present in this batch's payloads, not the whole session -
  // the session count would inflate the tally on every run after the first.
  const batchTokens = new Set();
  for (const it of items) {
    if (!it.payload) continue;
    for (const m of it.payload.matchAll(/\[[A-Z]+_\d{2,4}\]/g)) batchTokens.add(m[0]);
  }

  return {
    items,
    combined,
    combinedName,
    outputFormat: outFormat,
    reportCsv,
    secretsCsv,
    map: engine.toJSON(),
    tokenCount: batchTokens.size,
    sessionTokenCount: engine.tokenCount,
    secretCount: batchSecrets.length
  };
}

module.exports = { processFiles, EXTENSIONS, FORMATS, safeName, countTokens, formatPayload };
