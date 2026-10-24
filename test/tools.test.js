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
test('world export: 3D blocks carry the roof height above sea level and a category', () => {
  // A house at 100 m whose box rises 6 m, and a quay at sea level whose box reaches 12 m down to the sea bed.
  const house = { m: 'dz/structures/residential/house.p3d', t: 'Land_House', k: 'b', x: 50, y: 100, z: 50, yaw: 0, b: [-5, -0.5, -2, 5, 6, 2] };
  const quay = { m: 'dz/structures/industrial/harbour/quay.p3d', t: '', k: 'o', x: 10, y: 0, z: 10, yaw: 0, b: [-20, -12, -4, 20, 2, 4] };
  const out = wx.blocks([house, quay], o => (o.t ? 3 : 0));
  assert.deepEqual(out, [50, 50, 5, 2, 0, 106, 3, 10, 10, 20, 4, 0, 2, 0]);
});
test('world export: vegetation density counts trees, bushes a quarter', () => {
  const { density, trees, bushes } = wx.vegetationDensity('T 10 90\nT 12 91\nB 60 10\nX 1 1\n', 100, 2);
  assert.deepEqual([...density], [2, 0, 0, 0.25]); assert.equal(trees, 2); assert.equal(bushes, 1);
});
test('capture plan: spacing by ground kind, walking order, obstacles, water and captured points', () => {
  const capture = require('../tools/capture');
  // 400 m world: town (25 m) in the south-west quarter, sea along the north edge, open ground (100 m) elsewhere.
  const kindAt = (x, z) => (z > 350 ? -1 : x < 100 && z < 100 ? 2 : 0);
  const blocked = capture.obstacles([[50, 50, 3, 3, 0]]); // a 6 x 6 m house on the town point at 50, 50
  const spacing = { town: 25, road: 50, wild: 100 };
  const points = capture.planPoints({ size: 400, kindAt, blocked, spacing });
  const key = ([x, z]) => `${x},${z}`;
  assert.ok(points.some(p => key(p) === '25,25') && points.some(p => key(p) === '200,200'));
  assert.ok(!points.some(p => key(p) === '150,200'), 'open ground keeps only 100 m points');
  assert.ok(!points.some(([, z]) => z > 350), 'no points at sea');
  assert.ok(!points.some(p => key(p) === '50,50') && points.some(([x, z]) => Math.hypot(x - 50, z - 50) <= 8 && !blocked(x, z)), 'moved out of the house');
  // Rows run from the south (a nudged point may sit a few metres off its row) and alternate direction.
  const rows = points.filter(([x, z]) => x % 25 === 0 && z % 25 === 0).map(([, z]) => z);
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
  const row25 = points.filter(([, z]) => z === 25).map(([x]) => x), row50 = points.filter(([, z]) => Math.abs(z - 50) < 9).map(([x]) => x);
  assert.ok(row25[0] < row25[row25.length - 1] && row50[0] > row50[row50.length - 1]);
  // A second plan leaves out what a first one captured.
  const done = capture.capturedPoints('file,x,y,z,heading,pitch,fov\na,25,1,25,0,0,0.9\n');
  assert.ok(!capture.planPoints({ size: 400, kindAt, blocked, spacing, done }).some(p => key(p) === '25,25'));
  const text = capture.planText('p1', { headings: 6 }, [[25, 25]]);
  assert.equal(text, '# NasdaraCapture plan, 1 points (npm run capture:plan)\nplan p1\nheadings 6\npoints\n25 25\n');
});
test('places: finds the spot, its neighbourhood when hidden, combines views and crops screenshots', () => {
  const { gridSpacing, locate, viewRegion, bgraToRgb } = require('../src/places');
  const { evaluate } = require('../tools/places-eval');
  // A 10 x 10 grid, 100 m apart, 4 headings a point. Descriptors vary smoothly with position and heading, so
  // neighbouring points look alike (as real views do) and far ones do not.
  const dim = 32, points = [], shots = [], vectors = [];
  const describe = (x, z, h) => {
    const v = Float32Array.from({ length: dim }, (_, k) => Math.sin(x / 300 * (1 + k % 5) + k) + Math.cos(z / 300 * (1 + k % 7) + 2 * k) + Math.sin(h / 57 + k * 0.7));
    const n = Math.hypot(...v); return v.map(c => c / n);
  };
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
    points.push([1000 + j * 100, 2000 + i * 100]);
    for (const h of [0, 90, 180, 270]) { shots.push([points.length - 1, h]); vectors.push(describe(...points[points.length - 1], h)); }
  }
  const scale = 127 / Math.max(...vectors.flatMap(v => [...v].map(Math.abs)));
  const rows = new Int8Array(vectors.length * dim);
  vectors.forEach((v, s) => v.forEach((c, k) => { rows[s * dim + k] = Math.round(c * scale); }));
  const index = { dim, scale, rows, shots, points, pointX: Float32Array.from(points, p => p[0]), pointZ: Float32Array.from(points, p => p[1]) };
  index.spacing = gridSpacing(points);
  assert.equal(Math.round(index.spacing), 100);
  // Exactly at point 55 (1500, 2500), facing east.
  const at = locate(index, [describe(1500, 2500, 90)]);
  assert.deepEqual([at.x, at.z, at.heading], [1500, 2500, 90]);
  assert.ok(at.confidence > 0.5 && at.radius >= 50);
  // Between points, and with the nearest point hidden: still a neighbour's neighbourhood.
  const between = locate(index, [describe(1540, 2530, 180)]);
  assert.ok(Math.hypot(between.x - 1540, between.z - 2530) < 100, `between: ${between.x}, ${between.z}`);
  const hidden = locate(index, [describe(1500, 2500, 0)], p => p === 55);
  assert.ok(Math.hypot(hidden.x - 1500, hidden.z - 2500) <= 150, `hidden: ${hidden.x}, ${hidden.z}`);
  // Two views from one spot agree on it.
  const two = locate(index, [describe(1500, 2500, 0), describe(1500, 2500, 180)]);
  assert.deepEqual([two.x, two.z], [1500, 2500]);
  // The evaluation harness runs over the same index.
  const result = evaluate(index, 20);
  assert.equal(result.points, 20); assert.equal(result.one.length, 80); assert.equal(result.three.length, 20);
  // Screenshots: 21:9 is centred to 16:9, the top 70% kept; channels swap BGRA -> RGB.
  assert.deepEqual(viewRegion(2560, 1080, 0.7), { x: 320, y: 0, width: 1920, height: 756 });
  assert.deepEqual(viewRegion(1920, 1200, 0.7), { x: 0, y: 60, width: 1920, height: 756 });
  assert.deepEqual([...bgraToRgb(Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]))], [3, 2, 1, 6, 5, 4]);
});
test('server setup: config edited in place, start file, mod order and VPP admins', () => {
  const { readCfg, writeCfg, batText, modFolder, orderMods, readVpp, writeVpp, clean } = require('../src/server');
  const stock = 'hostname = "EXAMPLE NAME";  // Server name\npassword = "";\npasswordAdmin = "";\nmaxPlayers = 60; // max\n\nclass Missions\n{\n    class DayZ\n    {\n        template="dayzOffline.chernarusplus"; // map\n    };\n};\n';
  const cfg = writeCfg(stock, { hostname: 'Nas $1 server', password: '8891', maxPlayers: 20, thirdPersonView: 1, template: 'dayzOffline.nasdara' });
  assert.deepEqual(readCfg(cfg), { hostname: 'Nas $1 server', password: '8891', passwordAdmin: '', maxPlayers: 20, thirdPersonView: 1, template: 'dayzOffline.nasdara' });
  assert.match(cfg, /maxPlayers = 20; \/\/ max/); // comments kept
  assert.match(cfg, /thirdPersonView = 1;\n\s*class Missions/); // a missing key goes above Missions
  assert.equal(modFolder('Mounts & Sights'), '@MountsSights');
  assert.deepEqual(orderMods([{ name: 'Zeta' }, { name: 'Dabs Framework' }, { name: 'CF' }, { name: 'Alpha' }]).map(m => m.name), ['CF', 'Dabs Framework', 'Alpha', 'Zeta']);
  const bat = batText('C:\DayZServer', 'nas', { port: 2402, cpu: 4, restartHours: 6 }, ['@CF', '@VPPAdminTools']);
  assert.match(bat, /title mapino-nas server/);
  assert.match(bat, /-config=serverDZ-nas\.cfg -port=2402 -profiles=profiles -BEpath=battleye "-mod=@CF;@VPPAdminTools" -cpuCount=4/);
  assert.match(bat, /timeout 21600/);
  const opts = { maps: ['dayzOffline.nasdara'], mods: [{ id: '1', name: 'CF' }], groups: ['Admins'], cores: 8 };
  const form = { name: 'nas', template: 'dayzOffline.nasdara', hostname: 'Nas', maxPlayers: 10, serverTimeAcceleration: 1, serverNightTimeAcceleration: 1,
    port: 2302, cpu: 4, restartHours: 4, mods: ['1', 'gone'], admins: [{ id: '76561198000000001', name: 'Me', role: 'super' }, { id: '76561198000000002', role: 'Admins' }] };
  assert.deepEqual(clean(form, opts).mods, ['1']);
  assert.throws(() => clean({ ...form, name: 'my server' }, opts), /Setup name/);
  assert.throws(() => clean({ ...form, admins: [{ id: '123', role: 'super' }] }, opts), /Steam64/);
  assert.throws(() => clean({ ...form, admins: [{ id: '76561198000000001', role: 'Mods' }] }, opts), /no user group/);
  assert.throws(() => clean({ ...form, hostname: 'a"b' }, opts), /quotes/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapino-server-'));
  const perms = path.join(dir, 'profiles', 'VPPAdminTools', 'Permissions');
  fs.mkdirSync(path.join(perms, 'UserGroups'), { recursive: true });
  fs.writeFileSync(path.join(perms, 'UserGroups', 'UserGroups.json'), JSON.stringify([{ m_groupName: 'Admins', m_permissionLevel: 1,
    m_GroupMembers: [{ m_UserName: 'Example User', m_Steam64ID: '26561198420222028', m_SessionId: -1 }], m_Permissions: ['FreeCamera'] }]));
  fs.writeFileSync(path.join(perms, 'credentials.txt'), '//REMOVE THIS LINE AND REPLACE WITH YOUR PASSWORD!\n');
  assert.deepEqual(readVpp(dir), { admins: [], groups: ['Admins'], passwordSet: false });
  writeVpp(dir, clean(form, opts).admins, 'secret');
  assert.deepEqual(readVpp(dir), { admins: [{ id: '76561198000000001', name: '', role: 'super' }, { id: '76561198000000002', name: '76561198000000002', role: 'Admins' }], groups: ['Admins'], passwordSet: true });
  const groups = JSON.parse(fs.readFileSync(path.join(perms, 'UserGroups', 'UserGroups.json'), 'utf8'));
  assert.deepEqual(groups[0].m_Permissions, ['FreeCamera']); // permissions untouched
  assert.match(fs.readFileSync(path.join(perms, 'credentials.txt'), 'utf8'), /^secret\n/);
  fs.rmSync(dir, { recursive: true, force: true });
});
