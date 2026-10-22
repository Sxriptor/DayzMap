// Reads the export mod's files (see tools/export-mod and README): named places, exact terrain, building
// footprints, roads from walkable surfaces, forest density and water/fuel points. Pure functions; the build
// script writes the results out.
const fs = require('node:fs');
const path = require('node:path');

// One world's export files (<world>_objects.json, ...), copied into exports/<world>/ (Nasdara's may also sit
// straight in exports/ from before). Returns a reader by file suffix ('objects.json', 'terrain.txt') or null.
function exportFiles(root, world = 'nasdara') {
  const dirs = [path.join(root, 'exports', world)];
  if (world === 'nasdara') dirs.push(path.join(root, 'exports', 'NasdaraExport'), path.join(root, 'exports'));
  for (const dir of dirs) {
    const file = name => path.join(dir, `${world}_${name}`);
    if (!fs.existsSync(file('objects.json'))) continue;
    return { dir, has: name => fs.existsSync(file(name)), text: name => fs.readFileSync(file(name), 'utf8') };
  }
  return null;
}
const round = v => Math.round(v * 10) / 10;
// Cyrillic names (Sakhal's config) in Latin letters, the way its paper map prints them: "Petropavlovsk-Sakhal'skiy".
const CYRILLIC = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: "'", э: 'e', ю: 'yu', я: 'ya' };
const latin = s => s.replace(/[Ѐ-ӿ]/g, ch => {
  const t = CYRILLIC[ch.toLowerCase()]; if (t === undefined) return ch;
  return ch === ch.toLowerCase() ? t : t.charAt(0).toUpperCase() + t.slice(1);
});
// "Name_Village_Foo" style class names when a place has no plain name (or a stringtable key).
const placeName = p => latin(p.name && !/^[$#@]/.test(p.name) ? p.name : p.cls.replace(/^(Name\w*?_|Settlement_|Local_)/i, '').replace(/_/g, ' '));
// Each place: x, z, name, type ("NameCity", "NameVillage", "NameLocal", "Hill", "NameMarine", ...).
function parseWorld(text) {
  const world = JSON.parse(text);
  return { world: world.world, size: world.size,
    places: world.places.filter(p => Number.isFinite(p.x) && Number.isFinite(p.z)).map(p => [round(p.x), round(p.z), placeName(p), p.type || '']) };
}
// "index<TAB>name" lines -> names by index.
function parseTable(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^(\d+)\t(.*)$/); if (m) out[+m[1]] = m[2]; }
  return out;
}
// Terrain rows "row|heights cm|surfaces|water" from the south. Returns step, n and per-cell arrays (rows from south).
function parseTerrain(text) {
  const lines = text.split(/\r?\n/), head = lines[0].match(/step ([\d.]+) cells (\d+)/);
  if (!head) throw new Error('terrain export: missing header');
  const step = +head[1], n = +head[2];
  const h = new Float32Array(n * n), s = new Uint16Array(n * n), w = new Uint8Array(n * n);
  let rows = 0;
  for (const line of lines.slice(1)) {
    const [row, hs, ss, ws] = line.split('|');
    if (ws === undefined) continue;
    const r = +row, heights = hs.split(','), surfaces = ss.split(',');
    if (!(r >= 0 && r < n) || heights.length !== n) continue;
    for (let x = 0; x < n; x++) { h[r * n + x] = heights[x] / 100; s[r * n + x] = +surfaces[x]; w[r * n + x] = ws.charCodeAt(x) - 48; }
    rows++;
  }
  if (rows < n) throw new Error(`terrain export: ${rows} of ${n} rows (export unfinished?)`);
  return { step, n, h, s, w };
}
// Heights (m) on an m x m grid covering size metres, rows from the north, bilinear between export samples.
function resampleHeights(t, size, m) {
  const out = new Float64Array(m * m), cell = size / m;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const wx = (x + 0.5) * cell, wz = size - (y + 0.5) * cell;
    const fx = Math.min(t.n - 1, Math.max(0, wx / t.step - 0.5)), fz = Math.min(t.n - 1, Math.max(0, wz / t.step - 0.5));
    const x0 = Math.floor(fx), z0 = Math.floor(fz), x1 = Math.min(t.n - 1, x0 + 1), z1 = Math.min(t.n - 1, z0 + 1), tx = fx - x0, tz = fz - z0;
    const at = (a, b) => t.h[b * t.n + a];
    out[y * m + x] = (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz) + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz;
  }
  return out;
}
const isRoadModel = m => /\/roads?\//.test(m);
// Sea ice floes (Sakhal), water surfaces and fallen trees are not structures.
const isNatureModel = m => /\/(water|plants)[^/]*\//.test(m);
// Ground rectangle of an object from its model-space box: [centre x, centre z, half width, half depth, yaw rad].
// Yaw is the game's compass heading (clockwise from north), so model +z points along (sin, cos).
function footprint(o) {
  if (!Array.isArray(o.b) || o.b.length !== 6) return null;
  const [x0, , z0, x1, , z1] = o.b, yaw = (o.yaw || 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  const lx = (x0 + x1) / 2, lz = (z0 + z1) / 2;
  return [round(o.x + lx * c + lz * s), round(o.z - lx * s + lz * c), round((x1 - x0) / 2), round((z1 - z0) / 2), Math.round(yaw * 1000) / 1000];
}
// Outlines worth drawing: buildings and other standing structures (walls, sheds, towers) of a few square metres.
function outlines(objects) {
  const out = [];
  for (const o of objects) {
    if (o.k === 'r' || isRoadModel(o.m) || isNatureModel(o.m) || !Array.isArray(o.b)) continue;
    const f = footprint(o), tall = o.b[4] - o.b[1];
    if (f && (o.k === 'b' || (f[2] * f[3] * 4 >= 9 && tall >= 1.5)) && f[2] < 200 && f[3] < 200) out.push(f);
  }
  return out;
}
// Paints each footprint (grown by pad metres) into a px x px grid over size metres, rows from the north.
function paintRects(grid, px, size, rects, value, pad = 0) {
  const cell = size / px;
  for (const [cx, cz, hw, hd, yaw] of rects) {
    const c = Math.cos(yaw), s = Math.sin(yaw), r = Math.hypot(hw, hd) + pad;
    const gx0 = Math.max(0, Math.floor((cx - r) / cell)), gx1 = Math.min(px - 1, Math.floor((cx + r) / cell));
    const gy0 = Math.max(0, Math.floor((size - cz - r) / cell)), gy1 = Math.min(px - 1, Math.floor((size - cz + r) / cell));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const dx = (gx + 0.5) * cell - cx, dz = size - (gy + 0.5) * cell - cz;
      // Back into the model's frame: local x = dx cos - dz sin, local z = dx sin + dz cos.
      if (Math.abs(dx * c - dz * s) <= hw + pad && Math.abs(dx * s + dz * c) <= hd + pad) grid[gy * px + gx] = value;
    }
  }
}
// Road class from a walkable surface name: 1 paved, 2 unpaved, 0 not a road.
const PAVED = /asphalt|asf|tarmac|concrete|beton|cobble|runway|pavement/i, UNPAVED = /gravel|dirt|road|track|mud|cesta/i;
const roadClass = name => (PAVED.test(name) ? 1 : UNPAVED.test(name) ? 2 : 0);
// Road part models (.../roads/parts|bridges|tunnel/<name>.p3d, e.g. asf1takistan_25, dirt2_12, path_6, gravsakhal_7):
// paved asphalt, concrete, taxiways, bridges and tunnels; unpaved dirt, gravel, mud, snow and quarry roads, paths
// and grass tracks. Decals,
// panels, sidewalks and other roadside props are not roads.
const ROAD_PART = /\/roads\/(parts|bridges|tunnel)\//;
const roadPartClass = model => {
  if (!ROAD_PART.test(model)) return 0;
  const name = model.split('/').pop();
  return /^(dirt|path|grass|grav|mud|snow|quarry|kr)/.test(name) ? 2 : 1;
};
// Road raster (px x px over size metres, rows from the north; 1 paved, 2 unpaved) from the walkable-surface
// samples, leaving out building floors, plus any road objects the sweep returned. Lone cells are dropped.
function roadRaster(roadwayText, surfaces, objects, size, px = 4096) {
  const grid = new Uint8Array(px * px), lines = roadwayText.split(/\r?\n/), head = (lines[0] || '').match(/step ([\d.]+)/);
  const step = head ? +head[1] : 4, k = step / (size / px);
  const classes = surfaces.map(name => roadClass(name || ''));
  for (const line of lines) {
    const [col, row, surface] = line.split(' ').map(Number);
    if (!Number.isFinite(surface) || !classes[surface]) continue;
    const gx = Math.floor((col + 0.5) * k), gy = px - 1 - Math.floor((row + 0.5) * k);
    if (gx >= 0 && gy >= 0 && gx < px && gy < px) grid[gy * px + gx] = classes[surface];
  }
  // Building floors out first, then the road parts on top (a road can pass under a footprint's corner).
  paintRects(grid, px, size, outlines(objects), 0, 0.5);
  for (const cls of [2, 1]) paintRects(grid, px, size, objects.filter(o => roadPartClass(o.m) === cls).map(footprint).filter(Boolean), cls);
  const out = new Uint8Array(grid);
  for (let y = 1; y < px - 1; y++) for (let x = 1; x < px - 1; x++) {
    const p = y * px + x; if (!grid[p]) continue;
    let near = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && grid[p + dy * px + dx]) near++;
    if (near < 2) out[p] = 0;
  }
  return out;
}
// Trees per cell on an n x n grid over size metres, rows from the north; bushes count a quarter.
function vegetationDensity(text, size, n) {
  const out = new Float32Array(n * n), cell = size / n;
  let trees = 0, bushes = 0;
  for (const line of text.split(/\r?\n/)) {
    const [kind, xs, zs] = line.split(' ');
    const x = +xs, z = +zs;
    if ((kind !== 'T' && kind !== 'B') || !(x >= 0 && x < size && z > 0 && z <= size)) continue;
    out[Math.floor((size - z) / cell) * n + Math.floor(x / cell)] += kind === 'T' ? 1 : 0.25;
    if (kind === 'T') trees++; else bushes++;
  }
  return { density: out, trees, bushes };
}
// Water sources and fuel pumps, as the game itself flags them (u), with the model name for the tooltip.
function usePoints(objects) {
  const out = { water: [], fuel: [] };
  for (const o of objects) if (out[o.u]) out[o.u].push([round(o.x), round(o.z), (o.t || o.m.split('/').pop().replace(/\.p3d$/, '')).replace(/^Land_/, '')]);
  return out;
}
module.exports = { latin, exportFiles, parseWorld, parseTable, parseTerrain, resampleHeights, footprint, outlines, paintRects, roadClass, roadPartClass, roadRaster, vegetationDensity, usePoints };
