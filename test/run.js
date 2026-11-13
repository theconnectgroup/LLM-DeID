'use strict';
// Standalone checks for the extraction and tokenizing core.
// Run with: npm test   (no Electron, no network, nothing outside a temp folder)

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { extract } = require('../src/extract');
const { processFiles } = require('../src/engine');
const { createEngine } = require('../src/redact');

// ------------------------------------------------------------------ zip builder

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    locals.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    centrals.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

function makePdf(lines) {
  const objs = [];
  objs.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objs.push(Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  objs.push(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'));

  let content = 'BT /F1 11 Tf 50 750 Td 14 TL\n';
  for (const line of lines) {
    const esc = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    content += '(' + esc + ') Tj T*\n';
  }
  content += 'ET';
  const comp = zlib.deflateSync(Buffer.from(content, 'latin1'));
  objs.push(Buffer.concat([
    Buffer.from('<< /Length ' + comp.length + ' /Filter /FlateDecode >>\nstream\n'),
    comp,
    Buffer.from('\nendstream')
  ]));
  objs.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));

  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let size = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n'), o, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = size;
  let tail = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) tail += String(off).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ corpus

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmdeid-'));
const write = (name, data) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
};

const docx = makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>Quarterly review - Acme Holdings LLC</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Prepared for Jane Doe (jane.doe@acme-holdings.com)</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>E3 for Acme Holdings</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>',
  'docProps/core.xml': '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jane Doe</dc:creator></cp:coreProperties>'
});

const xlsx = makeZip({
  'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<si><t>User</t></si><si><t>Mail</t></si><si><t>Jane Doe</t></si><si><t>jane.doe@acme-holdings.com</t></si><si><t>Acme Holdings</t></si></sst>',
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Acme Seats" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>'
    + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="inlineStr"><is><t>10.20.30.40</t></is></c></row>'
    + '</sheetData></worksheet>'
});

const pptx = makeZip({
  'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
    + '<a:p><a:r><a:t>Acme Holdings - Q4 Review</a:t></a:r></a:p><a:p><a:r><a:t>Jane Doe | jane.doe@acme-holdings.com</a:t></a:r></a:p>'
    + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  'ppt/slides/slide2.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
    + '<a:p><a:r><a:t>40 E3 seats</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  'ppt/notesSlides/notesSlide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
    + '<a:p><a:r><a:t>Speaker: do not mention the 10.20.30.40 outage</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
});

const eml = 'From: "Jane Doe" <jane.doe@acme-holdings.com>\r\n'
  + 'To: "Robert Smith" <robert.smith@acme-holdings.com>\r\n'
  + 'Subject: =?utf-8?B?QWNtZSBIb2xkaW5ncyAtIG91dGFnZSB0b25pZ2h0?=\r\n'
  + 'Content-Type: multipart/alternative; boundary="B1"\r\n\r\n'
  + '--B1\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
  + 'The mail server 10.20.30.40 is being patched tonight.\r\nCall me on (406) 555-0199.\r\n\r\n'
  + '--B1\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n'
  + '<html><body><p>Server <b>10.20.30.40</b> is down=2E</p></body></html>\r\n\r\n--B1--\r\n';

const files = {
  notes: write('client-notes.txt', [
    'Ticket 88213 - Acme Holdings LLC',
    'Contact: Jane Doe <jane.doe@acme-holdings.com> phone (406) 555-0142',
    'Owner: Robert Smith, robert.smith@acme-holdings.com',
    'SSN 123-45-6789  EIN 81-1234567  Card 4111 1111 1111 1111',
    'Tenant 3f2504e0-4f89-11d3-9a0c-0305e82c3301  SID S-1-5-21-1004336348-1177238915-682003330-1001',
    'Server 10.20.30.40, share \\\\FS01\\clients\\acme, profile C:\\Users\\jdoe\\AppData',
    'MAC 00-14-22-01-23-45  portal.acme-holdings.com',
    'Keep: Windows 11 build 22631.4460 and version v1.2.3.4 are not identifiers.'
  ].join('\n')),
  ps1: write('config.ps1', '$clientSecret = "s3cr3tVALUE9xQpLm2Rt"\n$conn = "Server=sql01.acme.local;Database=Acme;User Id=svc_acme;Password=Pa55w0rd2026x;"\n$aws = "AKIAIOSFODNN7EXAMPLE"\n'),
  docx: write('report.docx', docx),
  xlsx: write('users.xlsx', xlsx),
  pptx: write('deck.pptx', pptx),
  eml: write('mail.eml', eml),
  pdf: write('invoice.pdf', makePdf(['INVOICE - Acme Holdings LLC', 'Bill to: Jane Doe, (406) 555-0142', 'Remit to 10.20.30.40'])),
  blank: write('blank.pdf', makePdf([]))
};

const dictionary = [
  { value: 'Jane Doe', type: 'NAME' },
  { value: 'Robert Smith', type: 'NAME' },
  { value: 'Acme Holdings', type: 'ORG' }
];

// ------------------------------------------------------------------ checks

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label + (detail ? '  -> ' + detail : ''));
  }
}

(async () => {
  console.log('\nextraction');

  const docxText = (await extract(files.docx)).text;
  check('docx body text', docxText.includes('Quarterly review'));
  check('docx table cells', docxText.includes('E3 for Acme Holdings') && docxText.includes('40'));
  check('docx properties', docxText.includes('dc:creator'));

  const xlsxText = (await extract(files.xlsx)).text;
  check('xlsx sheet name', xlsxText.includes('Acme Seats'));
  check('xlsx shared strings', xlsxText.includes('Jane Doe'));
  check('xlsx inline string', xlsxText.includes('10.20.30.40'));

  const pptxText = (await extract(files.pptx)).text;
  check('pptx slides', pptxText.includes('Q4 Review') && pptxText.includes('40 E3 seats'));
  check('pptx speaker notes', pptxText.includes('Speaker:'));

  const emlText = (await extract(files.eml)).text;
  check('eml headers decoded', emlText.includes('Acme Holdings - outage tonight'), emlText.slice(0, 90));
  check('eml plain body', emlText.includes('patched tonight'));
  check('eml html part converted', emlText.includes('is down'));

  const pdfRes = await extract(files.pdf);
  check('pdf text', pdfRes.text.includes('INVOICE') && pdfRes.text.includes('Acme Holdings'));
  const blankRes = await extract(files.blank);
  check('blank pdf flagged empty', blankRes.empty === true, JSON.stringify(blankRes.text));

  console.log('\nredaction');
  const engine = createEngine({ dictionary });
  const raw = fs.readFileSync(files.notes, 'utf8');
  const clean = engine.redact(raw, 'client-notes.txt');

  check('company name tokenized', clean.includes('[ORG_01]') && !clean.includes('Acme Holdings'), clean.slice(0, 120));
  check('person tokenized', clean.includes('[NAME_01]') && !clean.includes('Jane Doe'));
  check('email tokenized', clean.includes('[EMAIL_01]') && !clean.includes('jane.doe@'));
  check('phone tokenized', clean.includes('[PHONE_01]'));
  check('ssn tokenized', clean.includes('[SSN_01]') || clean.includes('[SSN_02]'));
  check('card tokenized', /\[CREDITCARD_01\]/.test(clean));
  check('guid tokenized', /\[GUID_01\]/.test(clean));
  check('sid tokenized', /\[SID_01\]/.test(clean));
  check('unc tokenized', /\[UNC_01\]/.test(clean));
  check('user path tokenized', /\[USERPATH_01\]/.test(clean));
  check('mac tokenized', /\[MAC_01\]/.test(clean));
  check('host tokenized', /\[HOST_01\]/.test(clean));
  check('build number preserved', clean.includes('22631.4460'));
  check('version string preserved', clean.includes('v1.2.3.4'));
  // Two different addresses in the fixture must get two tokens; the same address
  // twice must get one. Check both, on a clean engine so counters start at 01.
  const e2 = createEngine({});
  const dup = e2.redact('ping jane@acme.com then jane@acme.com again, and bob@acme.com once', 'x');
  const seen = dup.match(/\[EMAIL_\d+\]/g) || [];
  check('same value same token', seen.length === 3 && seen[0] === seen[1] && seen[0] !== seen[2], dup);
  check('different values different tokens', (clean.match(/\[EMAIL_01\]/g) || []).length === 1 && (clean.match(/\[EMAIL_02\]/g) || []).length === 1);

  console.log('\nsecrets');
  const ps = fs.readFileSync(files.ps1, 'utf8');
  const psClean = engine.redact(ps, 'config.ps1');
  check('client secret removed', !psClean.includes('s3cr3tVALUE9xQpLm2Rt'));
  check('quotes preserved', psClean.includes('"[SECRET_REDACTED]"'), psClean.split('\n')[0]);
  check('aws key removed', !psClean.includes('AKIAIOSFODNN7EXAMPLE'));
  check('connection string removed', !psClean.includes('Pa55w0rd2026x'));
  check('secret values never logged', engine.secrets.every((s) => !JSON.stringify(s).includes('Pa55w0rd') && !JSON.stringify(s).includes('s3cr3t')));
  check('secrets carry a line number', engine.secrets.every((s) => s.line > 0));

  console.log('\nround trip');
  const restored = engine.restore(clean);
  check('restore recovers the original text', restored === raw, 'length ' + restored.length + ' vs ' + raw.length);

  console.log('\nengine');
  const result = await processFiles(Object.values(files), { dictionary });
  const empty = result.items.find((i) => i.source === 'blank.pdf');
  check('blank pdf marked EMPTY', !!empty && empty.complete === 'EMPTY');
  check('all other files complete', result.items.filter((i) => i.source !== 'blank.pdf').every((i) => i.complete !== 'ERROR'), JSON.stringify(result.items.map((i) => i.source + ':' + i.complete)));
  check('map has entries', result.map.entries.length > 0);
  check('report has a row per file', result.reportCsv.trim().split('\n').length === result.items.length + 1);
  const allPayloads = result.items.map((i) => i.payload).join('\n');
  check('no raw email in any payload', !allPayloads.includes('jane.doe@acme-holdings.com'));
  check('no raw company name in any payload', !allPayloads.includes('Acme Holdings'));

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
