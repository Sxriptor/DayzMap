// Packs tools/export-mod into @NasdaraExport/addons/NasdaraExport.pbo (unsigned, uncompressed).
// Run: npm run pack:export-mod, then start a local DayZ server with -servermod=<path>\@NasdaraExport.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIX = 'NasdaraExport';
// Header entry for one file: name, packing method, original size, reserved, timestamp, data size.
function entry(name, method, size, time, dataSize) {
  const head = Buffer.alloc(20);
  [method, size, 0, time, dataSize].forEach((v, i) => head.writeUInt32LE(v >>> 0, i * 4));
  return Buffer.concat([Buffer.from(name + '\0', 'latin1'), head]);
}
function packPbo(sourceDir, prefix) {
  const files = [];
  const walk = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else files.push({ name: path.relative(sourceDir, full).split(path.sep).join('\\'), data: fs.readFileSync(full) });
    }
  };
  walk(sourceDir);
  files.sort((a, b) => a.name.localeCompare(b.name));
  const time = Math.floor(Date.now() / 1000);
  const parts = [entry('', 0x56657273, 0, 0, 0), Buffer.from(`prefix\0${prefix}\0\0`, 'latin1')];
  for (const f of files) parts.push(entry(f.name, 0, f.data.length, time, f.data.length));
  parts.push(entry('', 0, 0, 0, 0));
  for (const f of files) parts.push(f.data);
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from([0]), crypto.createHash('sha1').update(body).digest()]);
}
if (require.main === module) {
  const root = path.join(__dirname, '..');
  const out = path.join(root, '@NasdaraExport', 'addons');
  fs.mkdirSync(out, { recursive: true });
  const pbo = packPbo(path.join(__dirname, 'export-mod'), PREFIX);
  fs.writeFileSync(path.join(out, `${PREFIX}.pbo`), pbo);
  console.log(`Wrote ${path.join(out, `${PREFIX}.pbo`)} (${pbo.length} bytes)`);
}
module.exports = { packPbo };
