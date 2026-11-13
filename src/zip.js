'use strict';
// Minimal ZIP reader - enough for OOXML containers (docx/xlsx/pptx).
// No dependencies: the central directory is parsed by hand and entries are
// inflated with zlib. ZIP64 and encrypted archives are not supported.

const zlib = require('zlib');

function openZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

  // End of central directory record, scanning back over a possible comment.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip container');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('zip64 archive not supported');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const api = {
    names() { return Array.from(entries.keys()); },
    has(name) { return entries.has(name); },
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lh = e.localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported zip compression method ' + e.method);
    },
    text(name) {
      const b = api.read(name);
      return b === null ? null : b.toString('utf8');
    }
  };
  return api;
}

module.exports = { openZip };
