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
const wx = require('../tools/worldexport');
test('world export: places, terrain grid and height resampling', () => {
  const world = wx.parseWorld(JSON.stringify({ world: 'nasdara', size: 100, places: [
    { cls: 'Town_A', name: 'Alpha', type: 'NameCity', x: 10.04, z: 20 }, { cls: 'NameLocal_Old_Mill', name: '$STR_x', type: 'NameLocal', x: 1, z: 2 }] }));
  assert.deepEqual(world.places, [[10, 20, 'Alpha', 'NameCity'], [1, 2, 'Old Mill', 'NameLocal']]);
  // 2 x 2 cells of 50 m rising 1 m per metre to the east; row 0 is the south.
  const t = wx.parseTerrain('# step 50 cells 2 rows from south\n0|2500,7500|0,1|01\n1|2500,7500|0,1|00\n');
  assert.deepEqual([...t.h], [25, 75, 25, 75]); assert.deepEqual([...t.w], [0, 1, 0, 0]);
  const h = wx.resampleHeights(t, 100, 4);
  assert.deepEqual([...h.slice(0, 4)].map(v => Math.round(v * 10) / 10), [25, 37.5, 62.5, 75]);
  assert.throws(() => wx.parseTerrain('# step 50 cells 2\n0|1,1|0,0|00\n'), /1 of 2 rows/);
});
test('world export: footprints turn with yaw, roads skip building floors, water and fuel points', () => {
  // A 10 x 4 m building (model x long) turned 90°: model x now points south, so it is 4 wide (x) and 10 deep (z).
  const house = { m: 'dz/structures/residential/house.p3d', k: 'b', x: 50, z: 50, yaw: 90, b: [-5, 0, -2, 5, 6, 2], u: '' };
  const [cx, cz, hw, hd, yaw] = wx.footprint(house);
  assert.deepEqual([cx, cz, hw, hd], [50, 50, 5, 2]);
  const corner = [cx + hw * Math.cos(yaw) + hd * Math.sin(yaw), cz - hw * Math.sin(yaw) + hd * Math.cos(yaw)];
  assert.deepEqual(corner.map(v => Math.round(v)), [52, 45]);
  const well = { m: 'dz/structures/residential/misc/well.p3d', t: 'Land_Misc_Well_Pump_Yellow', k: 'b', x: 10, z: 10, yaw: 0, b: [-1, 0, -1, 1, 2, 1], u: 'water' };
  assert.deepEqual(wx.usePoints([house, well]), { water: [[10, 10, 'Misc_Well_Pump_Yellow']], fuel: [] });
  assert.equal(wx.outlines([house, well, { ...house, k: 'r' }]).length, 2, 'tiny well kept as a building, rock skipped');
  // Roadway: an asphalt strip along z = 82 m (row 20) and asphalt "floor" cells inside the house.
  const surfaces = ['cp_grass', 'nam_asphalt', 'cp_gravel'];
  const lines = ['# step 4 cells 25'];
  for (let col = 2; col < 20; col++) lines.push(`${col} 20 1 3`);
  for (let row = 11; row <= 13; row++) for (let col = 12; col <= 13; col++) lines.push(`${col} ${row} 1 0`);
  lines.push('3 3 2 0'); // a lone gravel cell
  const grid = wx.roadRaster(lines.join('\n'), surfaces, [house], 100, 25);
  const at = (x, z) => grid[(24 - Math.floor(z / 4)) * 25 + Math.floor(x / 4)];
  assert.equal(at(30, 82), 1); assert.equal(at(50, 50), 0, 'floor masked'); assert.equal(at(14, 14), 0, 'lone cell dropped');
  assert.equal(wx.roadClass('cp_gravel'), 2); assert.equal(wx.roadClass('cp_grass'), 0);
});
test('world export: Cyrillic names, road part classes, sea ice and per-world folders', () => {
  assert.equal(wx.latin('Петропавловск-Сахальский'), "Petropavlovsk-Sakhal'skiy");
  assert.equal(wx.parseWorld(JSON.stringify({ world: 'sakhal', size: 1, places: [{ cls: 'C', name: 'Североморск', type: 'City', x: 0, z: 0 }] })).places[0][2], 'Severomorsk');
  for (const [model, cls] of [['asf1sakhal_25', 1], ['gravsakhal_7 100', 2], ['mudsakhal_1 1000', 2], ['snowroad_7 100', 2], ['dirt2takistan_12', 2], ['bridge_1', 1]])
    assert.equal(wx.roadPartClass(`dz/structures_sakhal/roads/parts/${model}.p3d`), cls, model);
  const ice = { m: 'dz/water_sakhal/ice_sea/ice_sea_square_50m.p3d', k: 'o', x: 0, z: 0, yaw: 0, b: [-25, 0, -25, 25, 2, 25] };
  assert.equal(wx.outlines([ice]).length, 0, 'sea ice is not a structure');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapexport-'));
  try {
    fs.mkdirSync(path.join(root, 'exports', 'sakhal'), { recursive: true });
    fs.writeFileSync(path.join(root, 'exports', 'sakhal', 'sakhal_objects.json'), '');
    assert.equal(wx.exportFiles(root, 'sakhal').has('objects.json'), true);
    assert.equal(wx.exportFiles(root, 'chernarusplus'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('world export: vegetation density counts trees, bushes a quarter', () => {
  const { density, trees, bushes } = wx.vegetationDensity('T 10 90\nT 12 91\nB 60 10\nX 1 1\n', 100, 2);
  assert.deepEqual([...density], [2, 0, 0, 0.25]); assert.equal(trees, 2); assert.equal(bushes, 1);
});
