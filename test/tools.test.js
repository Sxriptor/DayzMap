const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExport, powerlines, signs } = require('../tools/objects');
const { integrate, fit } = require('../tools/terrain');
const { packPbo } = require('../tools/pack-mod');
const { readPbo } = require('../tools/pbo');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('poles become chains: nearest neighbours, two links each, no loops, no long jumps', () => {
  const line = (m, x, z) => JSON.stringify({ m, x, z, y: 0 });
  const text = [
    line('dz/structures/industrial/power/power_pole_wood1.p3d', 0, 0), line('dz/structures/industrial/power/power_pole_wood1.p3d', 50, 0),
    line('dz/structures/industrial/power/power_pole_wood1.p3d', 100, 0), line('dz/structures/industrial/power/power_pole_wood1.p3d', 500, 0),
    line('dz/structures_takistan/industrial/power/power_hv3_tower1.p3d', 0, 1000), line('dz/structures_takistan/industrial/power/power_hv3_tower1.p3d', 300, 1000),
    line('dz/structures/signs/traffic/sign_stop.p3d', 10, 10), 'not json', ''
  ].join('\n');
  const objects = parseExport(text);
  assert.equal(objects.length, 7);
  const { segments, poles } = powerlines(objects);
  assert.deepEqual(segments.filter(s => s[4] === 'pole').map(s => [s[0], s[2]]).sort((a, b) => a[0] - b[0]), [[0, 50], [50, 100]]);
  assert.equal(segments.filter(s => s[4] === 'hv').length, 1);
  assert.equal(poles.length, 6);
  assert.deepEqual(signs(objects), [[10, 10, 'sign_stop']]);
});
test('heights integrate from slopes and fit to anchors', () => {
  // A plane rising 0.1 m per metre to the east, 0.05 to the north, on a 16 x 16 grid of 10 m cells.
  const n = 16, gx = new Float32Array(n * n).fill(0.1), gz = new Float32Array(n * n).fill(0.05);
  const h = integrate(gx, gz, n, 10, [], 0, 2000);
  const truth = p => 200 + 0.1 * (p % n) * 10 + 0.05 * (n - 1 - Math.floor(p / n)) * 10;
  const anchors = [0, 37, 120, 255].map(p => [p, truth(p)]);
  const { s, rms } = fit(h, anchors);
  assert.ok(Math.abs(s - 1) < 0.01 && rms < 0.05, `scale ${s}, rms ${rms}`);
});
test('export mod packs into a readable PBO with its prefix', () => {
  const pbo = packPbo(path.join(__dirname, '..', 'tools', 'export-mod'), 'NasdaraExport');
  const file = path.join(os.tmpdir(), `nasdara-export-${process.pid}.pbo`);
  fs.writeFileSync(file, pbo);
  try {
    const p = readPbo(file);
    assert.equal(p.props.prefix, 'NasdaraExport');
    assert.deepEqual(p.entries.map(e => e.name).sort(), ['config.cpp', 'scripts/5_Mission/NasdaraExport.c']);
    assert.match(p.read('config.cpp').toString(), /missionScriptModule/);
    p.close();
  } finally { fs.rmSync(file, { force: true }); }
});
