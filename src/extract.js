'use strict';
// Text extraction per file type. Every extractor returns:
//   { text, method, lossy, warning }
// Nothing here writes files or touches the network.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { openZip } = require('./zip');

// ---------------------------------------------------------------- helpers

function htmlDecode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(cp, fallback) {
  try { return String.fromCodePoint(cp); } catch { return fallback; }
}

function tidy(s) {
  return s.replace(/[ \t]+\r?\n/g, '\n').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- Word

function wordXmlToText(xml) {
  let s = xml;
  s = s.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '');
  s = s.replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, '');
  s = s.replace(/<w:tab[^>]*\/>/g, '\t');
  s = s.replace(/<w:br[^>]*\/>|<w:cr[^>]*\/>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<\/w:tc>/g, ' | ');
  s = s.replace(/<\/w:tr>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return tidy(htmlDecode(s));
}

function docxText(buf) {
  const zip = openZip(buf);
  const order = ['word/document.xml'];
  for (const n of zip.names()) {
    if (/^word\/(header|footer)\d*\.xml$/.test(n) || /^word\/(footnotes|endnotes|comments)\.xml$/.test(n)) {
      order.push(n);
    }
  }

  let out = '';
  for (const name of order) {
    const xml = zip.text(name);
    if (!xml) continue;
    const t = wordXmlToText(xml);
    if (!t) continue;
    if (name !== 'word/document.xml') {
      out += '\n### [' + name.replace(/^word\//, '').replace(/\.xml$/, '') + ']\n';
    }
    out += t + '\n';
  }

  const core = zip.text('docProps/core.xml');
  if (core) {
    for (const tag of ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:category', 'cp:keywords']) {
      const re = new RegExp('<' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>([\\s\\S]*?)<\\/' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>', 'i');
      const m = core.match(re);
      if (m && m[1].trim()) {
        out += '\n### [property] ' + tag + ': ' + htmlDecode(m[1].trim()) + '\n';
      }
    }
  }
  return out.trim();
}

// ---------------------------------------------------------------- Excel

function xlsxSheets(zip) {
  const rels = {};
  const relXml = zip.text('xl/_rels/workbook.xml.rels');
  if (relXml) {
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      const id = (tag.match(/Id="([^"]+)"/) || [])[1];
      const target = (tag.match(/Target="([^"]+)"/) || [])[1];
      if (id && target) rels[id] = target;
    }
  }

  const sheets = [];
  const wb = zip.text('xl/workbook.xml');
  if (wb) {
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const tag = m[0];
      const name = (tag.match(/name="([^"]*)"/) || [])[1];
      const rid = (tag.match(/r:id="([^"]*)"/) || [])[1];
      if (!name) continue;
      let target = rid && rels[rid] ? rels[rid] : null;
      if (target) {
        if (target.startsWith('/')) target = target.slice(1);
        else if (!target.startsWith('xl/')) target = 'xl/' + target;
      }
      if (!target || !zip.has(target)) continue;
      sheets.push({ name: htmlDecode(name), entry: target });
    }
  }

  if (sheets.length === 0) {
    const found = zip.names()
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
    found.forEach((entry, i) => sheets.push({ name: 'Sheet' + (i + 1), entry }));
  }
  return sheets;
}

function xlsxText(buf) {
  const zip = openZip(buf);

  const shared = [];
  const ssXml = zip.text('xl/sharedStrings.xml');
  if (ssXml) {
    for (const si of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let t = '';
      for (const tm of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) t += tm[1];
      shared.push(htmlDecode(t));
    }
  }

  let out = '';
  for (const sheet of xlsxSheets(zip)) {
    const xml = zip.text(sheet.entry);
    if (!xml) continue;
    out += '\n### Sheet: ' + sheet.name + '\n```csv\n';

    for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = new Map();
      let maxCol = -1;

      for (const cm of rowM[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || '';
        const body = cm[2] || '';
        const ref = attrs.match(/r="([A-Z]+)(\d+)"/);
        if (!ref) continue;
        const col = colIndex(ref[1]);
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';

        let val = '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (type === 's' && v) {
          const idx = parseInt(v[1], 10);
          if (idx >= 0 && idx < shared.length) val = shared[idx];
        } else if (type === 'inlineStr') {
          const is = body.match(/<is>([\s\S]*?)<\/is>/);
          if (is) for (const tm of is[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += tm[1];
          val = htmlDecode(val);
        } else if (v) {
          val = htmlDecode(v[1]);
        }

        cells.set(col, val);
        if (col > maxCol) maxCol = col;
      }

      if (maxCol < 0) continue;
      const line = [];
      for (let c = 0; c <= maxCol; c++) line.push(csvCell(cells.has(c) ? cells.get(c) : ''));
      out += line.join(',') + '\n';
    }
    out += '```\n';
  }
  return out.trim();
}

// ---------------------------------------------------------------- PowerPoint

function pptxText(buf) {
  const zip = openZip(buf);
  let out = '';

  const blocks = [
    { re: /^ppt\/slides\/slide(\d+)\.xml$/, label: 'Slide' },
    { re: /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/, label: 'Speaker notes' }
  ];

  for (const block of blocks) {
    const items = zip.names()
      .filter((n) => block.re.test(n))
      .sort((a, b) => parseInt(a.match(block.re)[1], 10) - parseInt(b.match(block.re)[1], 10));

    for (const entry of items) {
      const xml = zip.text(entry);
      if (!xml) continue;
      let s = xml;
      s = s.replace(/<a:br[^>]*\/>/g, '\n');
      s = s.replace(/<\/a:p>/g, '\n');
      s = s.replace(/<\/a:tc>/g, ' | ');
      s = s.replace(/<\/a:tr>/g, '\n');
      s = s.replace(/<[^>]+>/g, '');
      s = tidy(htmlDecode(s));
      if (!s) continue;
      const num = entry.match(block.re)[1];
      out += '\n### ' + block.label + ' ' + num + '\n' + s + '\n';
    }
  }
  return out.trim();
}

// ---------------------------------------------------------------- PDF

async function pdfText(filePath, buf) {
  // 1. pdfjs-dist, when installed: real text layer, best quality.
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      useWorkerFetch: false
    }).promise;
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const line = content.items.map((it) => it.str).join(' ');
      if (line.trim()) out += '\n--- [page ' + p + '] ---\n' + line;
    }
    if (out.trim()) return { text: out.trim(), method: 'pdfjs', lossy: false, warning: '' };
  } catch (err) {
    // fall through to the built-in scraper
  }

  // 2. Built-in: inflate content streams and pull the text operators out.
  //    Works on many text PDFs; never on a scan.
  const latin1 = buf.toString('latin1');
  let out = '';
  for (const m of latin1.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const chunk = Buffer.from(m[1], 'latin1');
    let inflated = null;
    try { inflated = zlib.inflateSync(chunk); }
    catch { try { inflated = zlib.inflateRawSync(chunk); } catch { continue; } }

    const s = inflated.toString('latin1');
    if (!/Tj|TJ/.test(s)) continue;

    for (const op of s.matchAll(/(\((?:[^()\\]|\\.)*\))\s*(?:Tj|TJ|'|")|(T\*|Td|TD|ET)/g)) {
      if (op[2]) { out += '\n'; continue; }
      let lit = op[1].slice(1, -1);
      lit = lit.replace(/\\n|\\r|\\t/g, ' ').replace(/\\([()\\])/g, '$1');
      out += lit;
    }
    out += '\n';
  }

  out = tidy(out.replace(/[ \t]+/g, ' '));
  if (!out) {
    return {
      text: '', method: 'pdf-scrape', lossy: true,
      warning: 'No text layer found - scanned PDF? Nothing to de-identify, so do not send this file.'
    };
  }
  return {
    text: out, method: 'pdf-scrape', lossy: true,
    warning: 'Text recovered by scraping content streams; word order may be imperfect. Install pdfjs-dist for full quality.'
  };
}

// ---------------------------------------------------------------- Mail

function rfc2047(value) {
  return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(data, 'base64');
      } else {
        const raw = Buffer.from(data.replace(/_/g, ' '), 'latin1');
        const out = [];
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === 0x3d && i + 2 < raw.length) {
            out.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
            i += 2;
          } else out.push(raw[i]);
        }
        bytes = Buffer.from(out);
      }
      if (/utf-?8/i.test(charset)) return bytes.toString('utf8');
      if (/iso-8859-1|latin1/i.test(charset)) return bytes.toString('latin1');
      return bytes.toString('utf8');
    } catch { return m; }
  });
}

function quotedPrintable(value) {
  const joined = value.replace(/=\r?\n/g, '');
  return joined.replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = htmlDecode(s).replace(/[ \t]+/g, ' ');
  return s.replace(/(\n\s*){3,}/g, '\n\n').trim();
}

function emlText(buf) {
  let raw = buf.toString('utf8');
  if (raw.includes('\uFFFD')) raw = buf.toString('latin1');

  const sep = raw.match(/\r?\n\r?\n/);
  if (!sep) return raw;

  const headerBlock = raw.slice(0, sep.index).replace(/\r?\n[ \t]+/g, ' ');
  const body = raw.slice(sep.index + sep[0].length);

  const hdr = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) hdr[m[1].toLowerCase()] = m[2].trim();
  }

  let out = '';
  for (const key of ['from', 'to', 'cc', 'date', 'subject']) {
    if (hdr[key]) out += '### ' + key + ': ' + rfc2047(hdr[key]) + '\n';
  }
  out += '\n';

  const ct = hdr['content-type'] || '';
  const cte = (hdr['content-transfer-encoding'] || '').toLowerCase();
  const boundary = (ct.match(/boundary="?([^";]+)"?/) || [])[1];

  if (boundary) {
    const parts = body.split('--' + boundary);
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;
      const psep = part.match(/\r?\n\r?\n/);
      if (!psep) continue;
      const phead = part.slice(0, psep.index);
      let pbody = part.slice(psep.index + psep[0].length);
      const pct = ((phead.match(/^content-type:\s*([^;\r\n]+)/im) || [])[1] || '').trim();
      const pcte = ((phead.match(/^content-transfer-encoding:\s*(\S+)/im) || [])[1] || '').toLowerCase();
      const fname = (phead.match(/filename="([^"]+)"/i) || [])[1];
      const pname = (phead.match(/name="([^"]+)"/i) || [])[1];

      if (fname || (pname && !/^text\//i.test(pct))) {
        out += '### [attachment] ' + rfc2047(fname || pname) + '\n';
        continue;
      }

      if (pcte === 'base64') {
        try { pbody = Buffer.from(pbody.replace(/\s/g, ''), 'base64').toString('utf8'); } catch { pbody = ''; }
      } else if (pcte === 'quoted-printable') {
        pbody = quotedPrintable(pbody);
      }
      if (/text\/html/i.test(pct)) pbody = htmlToText(pbody);
      if (pbody.trim()) out += pbody.trim() + '\n\n';
    }
  } else {
    let b = body;
    if (cte === 'base64') { try { b = Buffer.from(b.replace(/\s/g, ''), 'base64').toString('utf8'); } catch { b = ''; } }
    else if (cte === 'quoted-printable') b = quotedPrintable(b);
    if (/text\/html/i.test(ct)) b = htmlToText(b);
    out += b.trim();
  }
  return out.trim();
}

// ---------------------------------------------------------------- Outlook .msg

function msgText(buf) {
  let MsgReader;
  try {
    const mod = require('@kenjiuno/msgreader');
    MsgReader = mod.default || mod;
  } catch {
    return {
      text: '', method: 'msgreader', lossy: true,
      warning: 'Outlook .msg needs the optional package. Run: npm install @kenjiuno/msgreader  - or export the mail as .eml.'
    };
  }
  try {
    const reader = new MsgReader(buf);
    const data = reader.getFileData();
    let out = '';
    const add = (label, v) => { if (v) out += '### ' + label + ': ' + v + '\n'; };
    add('from', data.senderName);
    add('from-address', data.senderEmail || data.senderSmtpAddress);
    if (Array.isArray(data.recipients) && data.recipients.length) {
      add('to', data.recipients.map((r) => r.name || r.email || '').filter(Boolean).join('; '));
      add('to-address', data.recipients.map((r) => r.email || r.smtpAddress || '').filter(Boolean).join('; '));
    }
    add('subject', data.subject);
    if (Array.isArray(data.attachments)) {
      for (const a of data.attachments) add('[attachment]', a.fileName || a.name);
    }
    out += '\n' + (data.body || '');
    return { text: out.trim(), method: 'msgreader', lossy: false, warning: '' };
  } catch (err) {
    return {
      text: '', method: 'msgreader', lossy: true,
      warning: 'Could not parse this .msg: ' + err.message + '. Export it as .eml instead.'
    };
  }
}

// ---------------------------------------------------------------- Legacy Office

function sheetjs(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  let out = '';
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    out += '\n### Sheet: ' + name + '\n```csv\n' + XLSX.utils.sheet_to_csv(ws).trim() + '\n```\n';
  }
  return out.trim();
}

async function legacyText(filePath, buf, ext) {
  if (ext === '.xls') {
    try {
      return { text: sheetjs(buf), method: 'sheetjs', lossy: false, warning: '' };
    } catch (err) {
      return {
        text: '', method: 'sheetjs', lossy: true,
        warning: '.xls needs the optional package. Run: npm install xlsx  - or save it as .xlsx.'
      };
    }
  }
  if (ext === '.doc') {
    try {
      const WordExtractor = require('word-extractor');
      const doc = await new WordExtractor().extract(filePath);
      return { text: String(doc.getBody() || '').trim(), method: 'word-extractor', lossy: false, warning: '' };
    } catch (err) {
      return {
        text: '', method: 'word-extractor', lossy: true,
        warning: '.doc needs the optional package. Run: npm install word-extractor  - or save it as .docx.'
      };
    }
  }
  if (ext === '.ppt') {
    return {
      text: '', method: 'none', lossy: true,
      warning: 'Binary PowerPoint (.ppt) cannot be read without Office. Save it as .pptx, or use Protect-LLMPayload.ps1 on a machine with PowerPoint installed.'
    };
  }
  return { text: '', method: 'none', lossy: true, warning: 'No extractor for ' + ext };
}

// ---------------------------------------------------------------- dispatcher

const PLAIN = new Set([
  '.txt', '.md', '.markdown', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.csv', '.tsv',
  '.log', '.json', '.xml', '.config', '.yaml', '.yml', '.ini', '.reg', '.sql', '.js', '.py'
]);

function kindOf(ext) {
  return ext.replace(/^\./, '') || 'file';
}

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.promises.readFile(filePath);

  let r;
  if (ext === '.docx') r = { text: docxText(buf), method: 'ooxml-word', lossy: false };
  else if (ext === '.xlsx' || ext === '.xlsm') {
    // SheetJS reads the workbook more completely when it is available.
    let used = null;
    try { used = sheetjs(buf); } catch { used = null; }
    r = used ? { text: used, method: 'sheetjs', lossy: false } : { text: xlsxText(buf), method: 'ooxml-excel', lossy: false };
  }
  else if (ext === '.pptx') r = { text: pptxText(buf), method: 'ooxml-powerpoint', lossy: false };
  else if (ext === '.pdf') r = await pdfText(filePath, buf);
  else if (ext === '.eml') r = { text: emlText(buf), method: 'mime', lossy: false };
  else if (ext === '.msg') r = msgText(buf);
  else if (ext === '.doc' || ext === '.xls' || ext === '.ppt') r = await legacyText(filePath, buf, ext);
  else if (ext === '.html' || ext === '.htm') r = { text: htmlToText(buf.toString('utf8')), method: 'html', lossy: false };
  else if (PLAIN.has(ext)) r = { text: buf.toString('utf8'), method: 'plain', lossy: false };
  else r = { text: buf.toString('utf8'), method: 'plain', lossy: true, warning: 'Unrecognised extension, read as text.' };

  const warning = r.warning || '';
  const text = r.text || '';
  return {
    text,
    method: r.method || 'plain',
    lossy: !!r.lossy,
    warning,
    kind: kindOf(ext),
    empty: text.trim().length === 0
  };
}

module.exports = {
  extract,
  // exported for the test harness
  docxText, xlsxText, pptxText, emlText, htmlToText, wordXmlToText
};
