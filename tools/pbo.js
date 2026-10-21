// Minimal reader for Bohemia PBO archives: lists entries and reads uncompressed files.
const fs = require('node:fs');
function readPbo(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 16 * 1024 * 1024));
  fs.readSync(fd, head, 0, head.length, 0);
  let pos = 0;
  const str = () => { const end = head.indexOf(0, pos); const s = head.toString('latin1', pos, end); pos = end + 1; return s; };
  const entries = [], props = {};
  for (;;) {
    const name = str();
    const [method, size, , , dataSize] = [0, 1, 2, 3, 4].map(i => head.readUInt32LE(pos + i * 4));
    pos += 20;
    if (!name) {
      if (method === 0x56657273) { for (let k; (k = str());) props[k] = str(); continue; }
      break;
    }
    entries.push({ name: name.split('\\').join('/'), method, size, dataSize });
  }
  let offset = pos;
  for (const e of entries) { e.offset = offset; offset += e.dataSize; }
  return {
    props, entries,
    read(name) {
      const e = entries.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!e) throw new Error(`${name} not in ${file}`);
      if (e.method && e.method !== 0x43707273) throw new Error(`unsupported packing ${e.method.toString(16)}`);
      const buf = Buffer.alloc(e.dataSize);
      fs.readSync(fd, buf, 0, e.dataSize, e.offset);
      return e.method === 0x43707273 ? lzss(buf, e.size) : buf;
    },
    close() { fs.closeSync(fd); }
  };
}
// Bohemia LZSS (used by "Cprs" entries).
function lzss(src, outSize) {
  const out = Buffer.alloc(outSize); let i = 0, o = 0;
  while (o < outSize) {
    const flags = src[i++];
    for (let b = 0; b < 8 && o < outSize; b++) {
      if (flags & (1 << b)) out[o++] = src[i++];
      else {
        const lo = src[i++], hi = src[i++];
        const rpos = o - (lo | ((hi & 0xf0) << 4)), len = (hi & 0x0f) + 3;
        for (let k = 0; k < len && o < outSize; k++) out[o++] = rpos + k < 0 ? 0x20 : out[rpos + k];
      }
    }
  }
  return out;
}
module.exports = { readPbo };
