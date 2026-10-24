// Builds the offline maps from a local DayZ install. Run: npm run build:map [-- <map ...>] [-- "<DayZ folder>"]
// Maps: nasdara, chernarusplus, sakhal (default: every one installed). Reads only unencrypted game files (paper
// map texture, terrain textures, Central Economy) plus the optional world export, and writes src/map/<map>/.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { readPbo } = require('./pbo');
const { readPaa } = require('./paa');
const { parseRap } = require('./rap');
const { extractLabels, packAtlas } = require('./labels');
const { contourStrength, mainRoads } = require('./topo');
const { buildHeights, shade, upsample } = require('./terrain');
const { parseExport, powerlines, signs } = require('./objects');
const { exportFiles, parseWorld, parseTable, parseTerrain, resampleHeights, outlines, blocks, roadRaster, vegetationDensity, usePoints } = require('./worldexport');
const { satelliteTiles } = require('./satellite');

// Each map: display name, world size (m), its addon folder under DayZ, the paper map texture (Chernarus has none:
// its base is drawn from the terrain instead) and the terrain normal map. `lift`: the paper map's printed names,
// contours and main roads can be picked out by colour (tuned to Nasdara's plain style; Sakhal's busy map stays
// as printed, with contours drawn from the terrain).
const MAPS = {
  nasdara: { name: 'Nasdara', size: 16384, dir: 'nasdara/addons', paper: 'map_unfolded_nasdara_co.paa', normals: 'global_nohq.paa', lift: true },
  chernarusplus: { name: 'Chernarus', size: 15360, dir: 'Addons', paper: null, normals: 'global_nohq.paa' },
  sakhal: { name: 'Frostline (Sakhal)', size: 15360, dir: 'sakhal/addons', paper: 'map_unfolded_sakhal_co.paa', normals: 'sakhal_global_nohq.paa' }
};
// Each building is STRIDE numbers: type index, x, z, tier bits, area usage bits. (Image sizes are per map: see build.)
const STRIDE = 5;
const MAP_ROOT = path.join(__dirname, '..', 'src', 'map');
const USAGES = ['Military', 'Police', 'Medic', 'Firefighter', 'Industrial', 'Farm', 'Coast', 'Town', 'Village', 'Hunting',
  'Office', 'School', 'Prison', 'Lunapark', 'SeasonalEvent', 'ContaminatedArea', 'Historical', 'MilitaryEast', 'MilitaryWest'];
const TIERS = { Tier1: 1, Tier2: 2, Tier3: 4, Tier4: 8, Unique: 16 };
// Building layer by most specific usage; wrecks are detected by class name.
const CATEGORY_ORDER = ['Military', 'MilitaryEast', 'MilitaryWest', 'Police', 'Prison', 'Medic', 'Firefighter', 'Hunting',
  'Industrial', 'Farm', 'Office', 'School', 'Historical', 'ContaminatedArea', 'Town', 'Village', 'Coast'];
const CATEGORY_LAYER = { Military: 'military', MilitaryEast: 'military', MilitaryWest: 'military', Police: 'police', Prison: 'police',
  Medic: 'medical', Firefighter: 'fire', Hunting: 'hunting', Industrial: 'industrial', Farm: 'industrial' };
const EVENTS = { StaticHeliCrash: 'heli', StaticHeliCrashBig: 'heli', StaticMilitaryConvoy: 'convoy', StaticPoliceCar: 'policecar',
  StaticContainerLocked: 'container', StaticWaterTruck: 'watertruck' };

const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
function findDayz() {
  const given = args.find(a => !(a in MAPS));
  if (given) return given;
  const steam = 'C:\\Program Files (x86)\\Steam';
  const libs = [steam];
  try {
    const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps', 'common', 'DayZ');
    if (fs.existsSync(path.join(dir, 'Addons', 'worlds_chernarusplus_ce.pbo'))) return dir;
  }
  throw new Error('DayZ not found. Pass the DayZ folder: npm run build:map -- "D:\\Steam\\steamapps\\common\\DayZ"');
}
const attrs = s => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const mask = (names, list) => names.reduce((m, n) => list.includes(n) ? m | (1 << list.indexOf(n)) : m, 0);
const round = v => Math.round(v * 10) / 10;

// nativeImage bitmaps are premultiplied BGRA.
function toImage(rgba, width, height) {
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    bgra[i] = rgba[i + 2] * a; bgra[i + 1] = rgba[i + 1] * a; bgra[i + 2] = rgba[i] * a; bgra[i + 3] = rgba[i + 3];
  }
  return nativeImage.createFromBitmap(bgra, { width, height });
}
// Satellite layer grid from the terrain materials' texGen (layers/P_<col>-<row>_*.rvmat): each S_ texture spans
// `span` m and starts `step` m after the previous one, the first `edge` m before the map's west/north edge.
function layerGrid(dataPbo) {
  const uv = (col, row) => {
    const entry = dataPbo.entries.find(e => e.name.toLowerCase().startsWith(`layers/p_${col}-${row}`) && e.name.endsWith('.rvmat'));
    const t = parseRap(dataPbo.read(entry.name)).TexGen3.uvTransform;
    return { span: 1 / t.aside[0], u: t.pos[0] };
  };
  const a = uv('000', '000'), b = uv('001', '001');
  return { span: a.span, step: Math.round((a.u - b.u) * a.span), edge: Math.round(a.u * a.span) };
}
// Terrain-drawn base map for worlds without a paper map texture: parchment land, forest tint, water with a darker
// shore. Rows from the north, px x px over size metres.
function drawnBase(size, px, heights, water, forest) {
  const out = Buffer.alloc(px * px * 4), isWater = new Uint8Array(px * px);
  for (let p = 0; p < px * px; p++) isWater[p] = water(p);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const p = y * px + x;
    let c = [238, 229, 204];
    if (isWater[p]) {
      const shore = (x > 0 && !isWater[p - 1]) || (x < px - 1 && !isWater[p + 1]) || (y > 0 && !isWater[p - px]) || (y < px - 1 && !isWater[p + px]);
      c = shore ? [80, 125, 170] : [164, 200, 222];
    } else if (forest) {
      // Full tint at 6 trees per 15 m cell: dense Chernarus forest (95th percentile about 8).
      const k = Math.min(1, forest(p) / 6) * 0.85;
      c = c.map((v, i) => v + ([196, 216, 170][i] - v) * k);
    }
    out.set([c[0], c[1], c[2], 255], p * 4);
  }
  return out;
}
// Contour lines from heights (rows from the north): every 10 m, every 50 m bolder; none under water.
function drawnContours(px, heights, water) {
  const out = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px - 1; y++) for (let x = 0; x < px - 1; x++) {
    const p = y * px + x; if (water(p)) continue;
    const c = Math.floor(heights[p] / 10);
    for (const q of [p + 1, p + px]) {
      const d = Math.floor(heights[q] / 10); if (d === c) continue;
      const index = (Math.max(c, d) * 10) % 50 === 0;
      if (out[p * 4 + 3] < (index ? 190 : 100)) out.set([70, 50, 30, index ? 190 : 100], p * 4);
    }
  }
  return out;
}
// Slopes (dh/dx east, dh/dz north) of a height grid with rows from the north, for hill shading.
function gradients(h, n, cell) {
  const gx = new Float32Array(n * n), gz = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const at = (a, b) => h[Math.min(n - 1, Math.max(0, b)) * n + Math.min(n - 1, Math.max(0, a))];
    gx[y * n + x] = (at(x + 1, y) - at(x - 1, y)) / (2 * cell);
    gz[y * n + x] = (at(x, y - 1) - at(x, y + 1)) / (2 * cell);
  }
  return { gx, gz };
}

function build(id, dayz) {
  const map = MAPS[id], SIZE = map.size, OUT = path.join(MAP_ROOT, id);
  // Base map and overlay images are BASE px across (4 m/px) in tiles of TILE px (1/32 of the map), so every tile
  // level, satellite included, has exactly twice the tiles of the one before: 2/4/8/16/32 across. Nasdara (16384 m)
  // uses 4096 px and 512 px tiles; Chernarus and Sakhal (15360 m) 3840 px and 480 px tiles.
  const BASE = SIZE / 4, TILE = SIZE / 32;
  const addons = path.join(dayz, map.dir);
  console.log(`\n== ${map.name}: reading ${addons}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  // JPEG for the opaque base maps (paper, satellite), PNG for transparent overlays.
  const writeTiles = (image, level, kind = 'tiles') => {
    const w = image.getSize().width, dir = path.join(OUT, kind, String(level));
    fs.mkdirSync(dir, { recursive: true });
    let bytes = 0;
    for (let ty = 0; ty < w / TILE; ty++) for (let tx = 0; tx < w / TILE; tx++) {
      const tile = image.crop({ x: tx * TILE, y: ty * TILE, width: TILE, height: TILE });
      const jpeg = kind === 'tiles' || kind === 'sat', file = jpeg ? tile.toJPEG(78) : tile.toPNG();
      fs.writeFileSync(path.join(dir, `${tx}_${ty}.${jpeg ? 'jpg' : 'png'}`), file); bytes += file.length;
    }
    return bytes;
  };
  // Three tile levels (1/4, 1/2 and full BASE px) of a full-map image.
  const pyramid = (image, kind) => {
    let bytes = 0;
    for (const level of [0, 1, 2]) {
      const w = BASE >> (2 - level);
      bytes += writeTiles(level === 2 ? image : image.resize({ width: w, quality: 'best' }), level, kind);
    }
    console.log(`${kind} ${(bytes / 1048576).toFixed(1)} MB`);
  };
  const overlay = (kind, rgba) => pyramid(toImage(rgba, BASE, BASE), kind);
  const levels = [0, 1, 2].map(level => (BASE >> (2 - level)) / TILE);

  // Everything the export mod read from a running server (see README), when its files are in exports/<map>/.
  const exported = exportFiles(path.join(__dirname, '..'), id);
  const objects = exported ? parseExport(exported.text('objects.json')) : [];
  const exact = exported?.has('terrain.txt') ? parseTerrain(exported.text('terrain.txt')) : null;
  if (!exported) console.log(`no exports/${id}/${id}_objects.json: export-only layers skipped (see README)`);
  const vegetation = exported?.has('vegetation.txt') ? vegetationDensity(exported.text('vegetation.txt'), SIZE, 1024) : null;

  const ce = readPbo(path.join(addons, `worlds_${id}_ce.pbo`));
  const text = name => ce.read(name).toString('utf8');
  const dataPbo = readPbo(path.join(addons, `worlds_${id}_data.pbo`));

  // Terrain from the normal map, pinned to Central Economy building heights; the exported heights, when there,
  // are the game's own and replace the estimate.
  const normals = readPaa(dataPbo.read(map.normals)).decode(0);
  const groundPoints = [...text('mapgrouppos.xml').matchAll(/pos="([\d.]+) ([\d.-]+) ([\d.]+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  const terrain = buildHeights(normals.rgba, normals.w, SIZE, groundPoints, 512);
  if (exact) {
    const estimate = terrain.heights;
    terrain.heights = resampleHeights(exact, SIZE, terrain.n);
    const rms = Math.sqrt(terrain.heights.reduce((e, v, p) => e + (v - estimate[p]) ** 2, 0) / estimate.length);
    console.log(`exact terrain ${exact.n}x${exact.n} at ${exact.step} m (the normal-map estimate was off by ${rms.toFixed(1)} m rms)`);
  }

  // Heights and water on the BASE px grid, for maps whose base or contours are drawn from the terrain.
  const cell = SIZE / BASE, heights = map.lift ? null : exact ? resampleHeights(exact, SIZE, BASE) : upsample(terrain.heights, terrain.n, BASE);
  // Sea below 0 m on the smooth height surface (the export's 10 m water grid would give a stepped coast); ponds,
  // which sit above sea level, from that grid.
  const water = exact
    ? p => { if (heights[p] < 0) return true; const x = Math.min(exact.n - 1, Math.floor(((p % BASE) + 0.5) * cell / exact.step)), z = Math.min(exact.n - 1, Math.floor((SIZE - (Math.floor(p / BASE) + 0.5) * cell) / exact.step)); return exact.w[z * exact.n + x] === 2; }
    : p => heights[p] < 0;
  // Base layer: the in-game paper map, for Nasdara with its printed labels lifted off (so the viewer can draw them
  // upright) and its contour lines and main roads redrawn as overlays. Without a paper map: drawn from the terrain.
  let labels = [], mainroads = false;
  if (map.paper && !map.lift) {
    const paper = readPaa(dataPbo.read(map.paper)).decode(0), image = toImage(paper.rgba, paper.w, paper.h);
    pyramid(paper.w === BASE ? image : image.resize({ width: BASE, quality: 'best' }), 'tiles');
    overlay('contours', drawnContours(BASE, heights, water));
    fs.writeFileSync(path.join(OUT, 'labels.png'), toImage(Buffer.alloc(4), 1, 1).toPNG());
    console.log(`paper map as printed, contours from the ${exact ? 'exported' : 'estimated'} terrain`);
  } else if (map.paper) {
    const paper = readPaa(dataPbo.read(map.paper)).decode(0);
    if (paper.w !== BASE) throw new Error(`${map.paper} is ${paper.w} px, expected ${BASE}`);
    const { clean, sprites } = extractLabels(paper.rgba, paper.w, paper.h);
    pyramid(toImage(clean, BASE, BASE), 'tiles');
    const strength = contourStrength(clean, BASE, BASE), topo = Buffer.alloc(clean.length);
    for (let p = 0; p < strength.length; p++) topo.set([70, 50, 30, strength[p] * 0.85], p * 4);
    overlay('contours', topo);
    const main = mainRoads(clean, BASE, BASE), roads = Buffer.alloc(clean.length);
    for (let p = 0; p < main.length; p++) if (main[p]) roads.set([214, 64, 20, 235], p * 4);
    overlay('roads', roads); mainroads = true;
    const pack = packAtlas(sprites);
    fs.writeFileSync(path.join(OUT, 'labels.png'), toImage(pack.atlas, pack.width, pack.height).toPNG());
    // Each label: world centre x, z, then its rectangle in labels.png (map pixels).
    const k = SIZE / BASE;
    labels = sprites.map((sp, i) => [round((sp.x + sp.w / 2) * k), round(SIZE - (sp.y + sp.h / 2) * k), pack.at[i][0], pack.at[i][1], sp.w, sp.h]);
    console.log(`labels ${labels.length}, atlas ${pack.width}x${pack.height}`);
  } else {
    const forest = vegetation && (p => vegetation.density[Math.floor(Math.floor(p / BASE) * 1024 / BASE) * 1024 + Math.floor((p % BASE) * 1024 / BASE)]);
    pyramid(toImage(drawnBase(SIZE, BASE, heights, water, forest), BASE, BASE), 'tiles');
    overlay('contours', drawnContours(BASE, heights, water));
    fs.writeFileSync(path.join(OUT, 'labels.png'), toImage(Buffer.alloc(4), 1, 1).toPNG());
    console.log(`base drawn from the ${exact ? 'exported' : 'estimated'} terrain (no paper map in the game files)`);
  }

  // Satellite base map from layers/S_<col>_<row>_lco.paa, row 0 at the north edge. Levels 0-2 are stitched from
  // their quarter-size mipmaps (4 m/px) and scaled to BASE px; levels 3 and 4 (2 and 1 m/px) from the full textures.
  const grid = layerGrid(dataPbo), q = grid.span / 4;
  const satTiles = dataPbo.entries.map(e => e.name.match(/^layers\/s_(\d+)_(\d+)_lco\.paa$/i)).filter(Boolean);
  const satSize = SIZE / 4, sat = Buffer.alloc(satSize * satSize * 4), satCell = grid.step / 4, edge = grid.edge / 4;
  for (const [name, col, row] of satTiles) {
    const paa = readPaa(dataPbo.read(name)), mip = paa.mips.findIndex(m => m.w === q);
    const { w: tw, rgba: t } = paa.decode(mip);
    for (let y = 0; y < satCell; y++) {
      const dy = +row * satCell + y; if (dy >= satSize) break;
      for (let x = 0; x < satCell; x++) {
        const dx = +col * satCell + x; if (dx >= satSize) break;
        const si = ((edge + y) * tw + edge + x) * 4, di = (dy * satSize + dx) * 4;
        sat[di] = t[si]; sat[di + 1] = t[si + 1]; sat[di + 2] = t[si + 2]; sat[di + 3] = 255;
      }
    }
  }
  const satImage = toImage(sat, satSize, satSize);
  pyramid(satSize === BASE ? satImage : satImage.resize({ width: BASE, quality: 'best' }), 'sat');
  let satBytes = 0;
  const sources = satTiles.map(([name, col, row]) => ({ name, col: +col, row: +row }));
  satelliteTiles(sources, name => { const { w, rgba } = readPaa(dataPbo.read(name)).decode(0); return { w, rgba }; },
    SIZE, TILE, (offset, tx, ty, rgba) => {
      const dir = path.join(OUT, 'sat', String(4 - offset));
      fs.mkdirSync(dir, { recursive: true });
      const jpg = toImage(rgba, TILE, TILE).toJPEG(72);
      fs.writeFileSync(path.join(dir, `${tx}_${ty}.jpg`), jpg); satBytes += jpg.length;
    }, grid);
  dataPbo.close();
  const satLevels = [...levels, SIZE / 2 / TILE, SIZE / TILE];
  console.log(`satellite ${satTiles.length} source tiles every ${grid.step} m, levels ${satLevels.join('/')} tiles across, full resolution ${(satBytes / 1048576).toFixed(1)} MB`);

  // Shaded relief (darkening only, so the base map keeps its colours): from the exact heights when exported,
  // else from the normal map.
  let relief = { shade: terrain.shade, w: normals.w };
  if (exact) {
    const R = 1024, { gx, gz } = gradients(resampleHeights(exact, SIZE, R), R, SIZE / R);
    relief = { shade: shade(gx, gz, R, R), w: R };
  }
  const reliefPng = Buffer.alloc(relief.w * relief.w * 4);
  for (let p = 0; p < relief.shade.length; p++) reliefPng.set([40, 28, 16, Math.max(0, Math.min(170, (205 - relief.shade[p]) * 1.2))], p * 4);
  fs.writeFileSync(path.join(OUT, 'relief.png'), toImage(reliefPng, relief.w, relief.w).toPNG());
  // Heights: decimetres as 16 bits in R (high) and G (low), rows from the north.
  const hm = Buffer.alloc(terrain.n * terrain.n * 4);
  let low = Infinity, high = -Infinity;
  terrain.heights.forEach((v, p) => {
    const d = Math.max(0, Math.min(65535, Math.round(v * 10)));
    hm.set([d >> 8, d & 255, 0, 255], p * 4); low = Math.min(low, v); high = Math.max(high, v);
  });
  fs.writeFileSync(path.join(OUT, 'heights.png'), toImage(hm, terrain.n, terrain.n).toPNG());
  // With exact heights, a finer 8 m grid for the 2D cursor readout (the 3D mesh stays at 512).
  const FINE = 2048;
  if (exact) {
    const fine = resampleHeights(exact, SIZE, FINE), fm = Buffer.alloc(FINE * FINE * 4);
    fine.forEach((v, p) => { const d = Math.max(0, Math.min(65535, Math.round(v * 10))); fm.set([d >> 8, d & 255, 0, 255], p * 4); });
    fs.writeFileSync(path.join(OUT, 'heights-fine.png'), toImage(fm, FINE, FINE).toPNG());
  }
  console.log(`terrain ${terrain.n}x${terrain.n}, ${Math.round(low)}-${Math.round(high)} m` +
    (exact ? '' : `, slope scale ${terrain.scale.toFixed(2)}, error vs held-out building heights ${terrain.testRms.toFixed(1)} m`));

  // Loot tier per 4 m cell: N uint32 usage masks followed by N tier bytes, rows from south (z = 0).
  const flags = ce.read('areaflags.map');
  const cells = flags.readUInt32LE(0), cellSize = flags.readUInt32LE(8) / cells;
  const tierAt = (x, z) => {
    const cx = Math.min(cells - 1, Math.max(0, Math.floor(x / cellSize)));
    const cy = Math.min(cells - 1, Math.max(0, Math.floor(z / cellSize)));
    return flags[24 + cells * cells * 4 + cy * cells + cx] & 31;
  };
  const areaUsageAt = (x, z) =>
    flags.readUInt32LE(24 + 4 * (Math.min(cells - 1, Math.floor(z / cellSize)) * cells + Math.min(cells - 1, Math.floor(x / cellSize))));
  const tierPng = Buffer.alloc(1024 * 1024 * 4), step = cells / 1024;
  const tierColors = { 8: [200, 30, 30], 4: [235, 135, 20], 2: [40, 90, 220], 1: [40, 160, 70] };
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const v = flags[24 + cells * cells * 4 + (cells - 1 - Math.floor(y * step)) * cells + Math.floor(x * step)];
    const c = tierColors[v & 8 || v & 4 || v & 2 || v & 1]; if (!c) continue;
    // Premultiplied BGRA at ~35% opacity.
    const o = (y * 1024 + x) * 4, a = 90;
    tierPng[o] = c[2] * a / 255; tierPng[o + 1] = c[1] * a / 255; tierPng[o + 2] = c[0] * a / 255; tierPng[o + 3] = a;
  }
  fs.writeFileSync(path.join(OUT, 'tiers.png'), nativeImage.createFromBitmap(tierPng, { width: 1024, height: 1024 }).toPNG());

  // Building prototypes: usage flags and container categories/tags.
  const protos = {};
  for (const m of text('mapgroupproto.xml').matchAll(/<group ([^>]*?)>([\s\S]*?)<\/group>/g)) {
    const { name } = attrs(m[1]);
    const usages = [...m[2].matchAll(/<usage name="([^"]+)"/g)].map(u => u[1]);
    const containers = [...m[2].matchAll(/<container[^>]*>([\s\S]*?)<\/container>/g)].map(c => ({
      categories: [...c[1].matchAll(/<category name="([^"]+)"/g)].map(x => x[1]),
      points: (c[1].match(/<point /g) || []).length
    }));
    protos[name] = { usages, containers, points: containers.reduce((n, c) => n + c.points, 0) };
  }

  const types = [], typeIndex = {}, buildings = [];
  for (const m of text('mapgrouppos.xml').matchAll(/<group ([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    const [x, , z] = a.pos.split(' ').map(Number);
    if (!(a.name in typeIndex)) {
      const proto = protos[a.name] || { usages: [], containers: [], points: 0 };
      const main = CATEGORY_ORDER.find(u => proto.usages.includes(u));
      typeIndex[a.name] = types.length;
      types.push({
        name: a.name, layer: /wreck/i.test(a.name) ? 'wreck' : CATEGORY_LAYER[main] || 'civilian',
        usage: mask(proto.usages, USAGES), points: proto.points,
        categories: [...new Set(proto.containers.flatMap(c => c.categories))]
      });
    }
    buildings.push(typeIndex[a.name], round(x), round(z), tierAt(x, z), areaUsageAt(x, z));
  }

  // Loot items: category, usage and tier masks. Items with nominal 0 never spawn as world loot.
  const items = [];
  for (const m of text('db/types.xml').matchAll(/<type name="([^"]+)">([\s\S]*?)<\/type>/g)) {
    const body = m[2];
    const nominal = Number((body.match(/<nominal>(\d+)/) || [])[1] || 0);
    const usages = [...body.matchAll(/<usage name="([^"]+)"/g)].map(u => u[1]);
    if (!nominal || !usages.length) continue;
    const values = [...body.matchAll(/<value name="([^"]+)"/g)].map(v => TIERS[v[1]] || 0);
    items.push({
      name: m[1], category: (body.match(/<category name="([^"]+)"/) || [])[1] || '',
      usage: mask(usages, USAGES), tiers: values.reduce((a, b) => a | b, 0), nominal
    });
  }

  const events = {};
  for (const m of text('cfgeventspawns.xml').matchAll(/<event name="([^"]+)">([\s\S]*?)<\/event>/g)) {
    const layer = EVENTS[m[1]] || (m[1].startsWith('Vehicle') ? 'vehicle' : null);
    if (!layer) continue;
    for (const p of m[2].matchAll(/<pos ([^>]*)\/>/g)) {
      const a = attrs(p[1]);
      (events[layer] ||= []).push([round(+a.x), round(+a.z), m[1]]);
    }
  }
  const zones = (JSON.parse(text('cfgeffectarea.json')).Areas || [])
    .map(a => ({ name: a.AreaName, x: a.Data.Pos[0], z: a.Data.Pos[2], r: a.Data.Radius }));
  // Infected spawn zones and animal territories (env/*_territories.xml), and bunker/tunnel entrances.
  const zoneTypes = [], typeOf = name => { if (!zoneTypes.includes(name)) zoneTypes.push(name); return zoneTypes.indexOf(name); };
  const territory = file => [...text(file).matchAll(/<zone ([^>]*)\/>/g)].map(m => attrs(m[1]));
  const infected = territory('env/zombie_territories.xml').map(a => [round(+a.x), round(+a.z), +a.r, typeOf(a.name)]);
  const animals = [];
  for (const entry of ce.entries) {
    const species = (entry.name.match(/^env\/(.+)_territories\.xml$/) || [])[1];
    if (!species || species === 'zombie') continue;
    for (const a of territory(entry.name)) animals.push([round(+a.x), round(+a.z), +a.r, species, a.name]);
  }
  // The outermost trigger of each entrance ("..._Outter", "..._Entrance") marks where you walk in; merge ones within 40 m.
  const underground = [];
  for (const t of JSON.parse(text('cfgundergroundtriggers.json')).Triggers || []) {
    if (!/out+er|entrance/i.test(t.Comment || '')) continue;
    const [x, , z] = t.Position, name = t.Comment.replace(/_?(Out+er|Entrance).*$/i, '').replace(/_/g, ' ');
    if (!underground.some(u => Math.hypot(u[0] - x, u[1] - z) < 40)) underground.push([round(x), round(z), name]);
  }
  const spawns = [...text('cfgplayerspawnpoints.xml').split('<fresh>')[1].split('</fresh>')[0].matchAll(/<pos ([^>]*)\/>/g)]
    .map(p => { const a = attrs(p[1]); return [round(+a.x), round(+a.z)]; });
  ce.close();

  // Export-only layers: powerlines, signs, place names, building outlines, water/fuel, roads and forest.
  let power = null, signList = null, places = null, outlineList = null, uses = null, roadnet = false, forest = false;
  if (exported) {
    power = powerlines(objects); signList = signs(objects);
    console.log(`exported objects ${objects.length}: powerline spans ${power.segments.length}, poles ${power.poles.length}, signs ${signList.length}`);
    if (objects.some(o => Array.isArray(o.b))) {
      outlineList = outlines(objects).flat(); uses = usePoints(objects);
      // 3D buildings (loaded only when the 3D view opens): category = the Central Economy layer of a loot building
      // matched by class name, else a plain building or other structure (walls, sheds, towers).
      const kinds = ['structure', 'building', 'civilian', 'military', 'police', 'medical', 'fire', 'hunting', 'industrial', 'wreck'];
      const kindOf = o => { const t = types[typeIndex[o.t]]; return t ? Math.max(2, kinds.indexOf(t.layer)) : o.k === 'b' ? 1 : 0; };
      const list = blocks(objects, kindOf);
      fs.writeFileSync(path.join(OUT, 'blocks.js'), `window.MAP_BLOCKS=${JSON.stringify({ stride: 7, kinds, data: list })};\n`);
      console.log(`3D buildings ${list.length / 7} (${(fs.statSync(path.join(OUT, 'blocks.js')).size / 1048576).toFixed(1)} MB)`);
      console.log(`outlines ${outlineList.length / 5}, water sources ${uses.water.length}, fuel pumps ${uses.fuel.length}`);
    }
    if (exported.has('world.json')) {
      const world = parseWorld(exported.text('world.json'));
      places = world.places;
      console.log(`places ${places.length} (world ${world.world}, size ${world.size})`);
      if (world.size !== SIZE) console.warn(`warning: exported world size ${world.size} differs from ${SIZE}`);
    }
    if (exported.has('roadway.txt') && exported.has('surfaces.txt')) {
      const surfaces = parseTable(exported.text('surfaces.txt'));
      const grid = roadRaster(exported.text('roadway.txt'), surfaces, objects, SIZE, BASE), rgba = Buffer.alloc(grid.length * 4);
      let paved = 0, unpaved = 0;
      for (let p = 0; p < grid.length; p++) {
        if (grid[p] === 1) { rgba.set([60, 60, 66, 255], p * 4); paved++; } else if (grid[p] === 2) { rgba.set([150, 105, 60, 255], p * 4); unpaved++; }
      }
      overlay('roadnet', rgba); roadnet = true;
      const m2 = (SIZE / BASE) ** 2;
      console.log(`roads ${(paved * m2 / 1e6).toFixed(2)} km² paved, ${(unpaved * m2 / 1e6).toFixed(2)} km² unpaved (surfaces: ${surfaces.join(', ')})`);
    }
    if (vegetation) {
      const N = 1024, { density, trees, bushes } = vegetation, img = Buffer.alloc(N * N * 4);
      // Full green at about one tree per 25 m² (40 per 15-16 m cell).
      for (let p = 0; p < density.length; p++) if (density[p]) img.set([30, 110, 40, Math.min(150, density[p] * 4)], p * 4);
      fs.writeFileSync(path.join(OUT, 'forest.png'), toImage(img, N, N).toPNG()); forest = true;
      console.log(`vegetation ${trees} trees, ${bushes} bushes`);
    }
  }
  const spawnTier1 = spawns.filter(([x, z]) => tierAt(x, z) & 1).length;
  console.log(`buildings ${buildings.length / STRIDE} (${types.length} types), loot items ${items.length}, ` +
    `events ${Object.entries(events).map(([k, v]) => `${k} ${v.length}`).join(', ')}, zones ${zones.length}, infected ${infected.length}, animals ${animals.length}, underground ${underground.length}, ` +
    `spawns ${spawns.length} (${spawnTier1} in Tier1)`);
  if (spawnTier1 < spawns.length * 0.5) throw new Error('tier raster orientation check failed');

  const data = { id, name: map.name, size: SIZE, tile: TILE, levels, satLevels, paper: !!map.paper, mainroads, labels, labelScale: SIZE / BASE,
    terrain: { size: terrain.n, low: Math.round(low), high: Math.round(high), exact: !!exact, fine: exact ? FINE : 0 }, usages: USAGES, stride: STRIDE,
    types, buildings, items, events, zones, spawns, zoneTypes, infected, animals, underground, power, signs: signList,
    places, outlines: outlineList, blocks: !!outlineList, uses, roadnet, forest };
  fs.writeFileSync(path.join(OUT, 'data.js'), `window.MAP_DATA=${JSON.stringify(data)};\n`);
  console.log(`data.js ${(fs.statSync(path.join(OUT, 'data.js')).size / 1024).toFixed(0)} KB -> ${OUT}`);
}
// The viewer's map list: every map whose data has been built, in MAPS order.
function writeManifest() {
  const list = Object.entries(MAPS).filter(([id]) => fs.existsSync(path.join(MAP_ROOT, id, 'data.js'))).map(([id, { name }]) => ({ id, name }));
  fs.writeFileSync(path.join(MAP_ROOT, 'maps.js'), `window.MAP_LIST=${JSON.stringify(list)};\n`);
  console.log(`\nmaps.js: ${list.map(m => m.name).join(', ') || 'none'}`);
}

app.whenReady().then(() => {
  try {
    const dayz = findDayz();
    const wanted = args.filter(a => a in MAPS);
    const ids = wanted.length ? wanted : Object.keys(MAPS).filter(id => fs.existsSync(path.join(dayz, MAPS[id].dir, `worlds_${id}_ce.pbo`)));
    for (const id of ids) build(id, dayz);
    writeManifest();
    app.exit(0);
  } catch (error) { console.error(error.stack || error.message); app.exit(1); }
});
