// Builds the offline Nasdara map from a local DayZ install. Run: npm run build:nasdara [-- "<DayZ folder>"]
// Reads only unencrypted game files (paper map texture + Central Economy) and writes src/map/nasdara/.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { readPbo } = require('./pbo');
const { readPaa } = require('./paa');
const { extractLabels, packAtlas } = require('./labels');
const { contourStrength, mainRoads } = require('./topo');
const { buildHeights } = require('./terrain');
const { parseExport, powerlines, signs } = require('./objects');
const { satelliteTiles } = require('./satellite');

// Each building is STRIDE numbers: type index, x, z, tier bits, area usage bits.
const SIZE = 16384, TILE = 512, STRIDE = 5;
const OUT = path.join(__dirname, '..', 'src', 'map', 'nasdara');
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

function findDayz() {
  if (process.argv[2] && !process.argv[2].startsWith('-')) return process.argv[2];
  const steam = 'C:\\Program Files (x86)\\Steam';
  const libs = [steam];
  try {
    const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps', 'common', 'DayZ');
    if (fs.existsSync(path.join(dir, 'nasdara', 'addons', 'worlds_nasdara_ce.pbo'))) return dir;
  }
  throw new Error('DayZ with Nasdara not found. Pass the DayZ folder: npm run build:nasdara -- "D:\\Steam\\steamapps\\common\\DayZ"');
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
// JPEG for the opaque base maps (paper, satellite), PNG for transparent overlays.
function writeTiles(image, level, kind = 'tiles') {
  const w = image.getSize().width;
  const dir = path.join(OUT, kind, String(level));
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (let ty = 0; ty < w / TILE; ty++) for (let tx = 0; tx < w / TILE; tx++) {
    const tile = image.crop({ x: tx * TILE, y: ty * TILE, width: TILE, height: TILE });
    const jpeg = kind === 'tiles' || kind === 'sat', file = jpeg ? tile.toJPEG(78) : tile.toPNG();
    fs.writeFileSync(path.join(dir, `${tx}_${ty}.${jpeg ? 'jpg' : 'png'}`), file); bytes += file.length;
  }
  return bytes;
}

function build() {
  const dayz = findDayz();
  const addons = path.join(dayz, 'nasdara', 'addons');
  console.log(`Reading ${addons}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Base layer: the in-game paper map with its printed labels lifted off, so the viewer can draw them upright.
  const paperPbo = readPbo(path.join(addons, 'worlds_nasdara_data.pbo'));
  const paper = readPaa(paperPbo.read('map_unfolded_nasdara_co.paa')).decode(0);
  paperPbo.close();
  const { clean, sprites } = extractLabels(paper.rgba, paper.w, paper.h);
  const base = toImage(clean, paper.w, paper.h), levels = [];
  for (const level of [0, 1, 2]) {
    const w = paper.w >> (2 - level);
    const bytes = writeTiles(level === 2 ? base : base.resize({ width: w, quality: 'best' }), level);
    levels.push(w / TILE);
    console.log(`tiles level ${level}: ${w}px, ${(bytes / 1048576).toFixed(1)} MB`);
  }
  // Overlays redrawn from the paper map: darker contour lines and bold main roads.
  const overlay = (kind, rgba) => {
    const image = toImage(rgba, paper.w, paper.h);
    let bytes = 0;
    for (const level of [0, 1, 2]) {
      const w = paper.w >> (2 - level);
      bytes += writeTiles(level === 2 ? image : image.resize({ width: w, quality: 'best' }), level, kind);
    }
    console.log(`${kind} ${(bytes / 1048576).toFixed(1)} MB`);
  };
  const strength = contourStrength(clean, paper.w, paper.h), topo = Buffer.alloc(clean.length);
  for (let p = 0; p < strength.length; p++) topo.set([70, 50, 30, strength[p] * 0.85], p * 4);
  overlay('contours', topo);
  const main = mainRoads(clean, paper.w, paper.h), roads = Buffer.alloc(clean.length);
  for (let p = 0; p < main.length; p++) if (main[p]) roads.set([214, 64, 20, 235], p * 4);
  overlay('roads', roads);
  const pack = packAtlas(sprites);
  fs.writeFileSync(path.join(OUT, 'labels.png'), toImage(pack.atlas, pack.width, pack.height).toPNG());
  const metersPerPixel = SIZE / paper.w;
  // Each label: world centre x, z, then its rectangle in labels.png (map pixels).
  const labels = sprites.map((sp, i) => [round((sp.x + sp.w / 2) * metersPerPixel), round(SIZE - (sp.y + sp.h / 2) * metersPerPixel),
    pack.at[i][0], pack.at[i][1], sp.w, sp.h]);
  console.log(`labels ${labels.length}, atlas ${pack.width}x${pack.height}`);

  const ce = readPbo(path.join(addons, 'worlds_nasdara_ce.pbo'));
  const text = name => ce.read(name).toString('utf8');

  // Terrain from the normal map (global_nohq.paa), pinned to Central Economy building heights.
  const dataPbo = readPbo(path.join(addons, 'worlds_nasdara_data.pbo'));
  const normals = readPaa(dataPbo.read('global_nohq.paa')).decode(0);
  // Satellite base map: layers/S_<col>_<row>_lco.paa, 512 m each at 1 m/px, repeating every 384 m with
  // 64 m overlap on each side, row 0 at the north edge (from the layer rvmats' texGen). Stitched from
  // their quarter-size mipmaps (4 m/px) into one 4096 px image, the same scale as the paper map.
  const satTiles = dataPbo.entries.map(e => e.name.match(/^layers\/s_(\d+)_(\d+)_lco\.paa$/i)).filter(Boolean);
  const satSize = paper.w, sat = Buffer.alloc(satSize * satSize * 4), cell = 96, edge = 16;
  for (const [name, col, row] of satTiles) {
    const paa = readPaa(dataPbo.read(name)), mip = paa.mips.findIndex(m => m.w === 128);
    const { w: tw, rgba: t } = paa.decode(mip);
    for (let y = 0; y < cell; y++) {
      const dy = +row * cell + y; if (dy >= satSize) break;
      for (let x = 0; x < cell; x++) {
        const dx = +col * cell + x; if (dx >= satSize) break;
        const si = ((edge + y) * tw + edge + x) * 4, di = (dy * satSize + dx) * 4;
        sat[di] = t[si]; sat[di + 1] = t[si + 1]; sat[di + 2] = t[si + 2]; sat[di + 3] = 255;
      }
    }
  }
  const satImage = toImage(sat, satSize, satSize);
  let satBytes = 0;
  for (const level of [0, 1, 2]) {
    const w = satSize >> (2 - level);
    satBytes += writeTiles(level === 2 ? satImage : satImage.resize({ width: w, quality: 'best' }), level, 'sat');
  }
  // Sharper satellite levels 3 (2 m/px) and 4 (1 m/px, the source resolution) from the full-size textures.
  const sources = satTiles.map(([name, col, row]) => ({ name, col: +col, row: +row }));
  satelliteTiles(sources, name => { const { w, rgba } = readPaa(dataPbo.read(name)).decode(0); return { w, rgba }; },
    SIZE, TILE, (offset, tx, ty, rgba) => {
      const dir = path.join(OUT, 'sat', String(4 - offset));
      fs.mkdirSync(dir, { recursive: true });
      const jpg = toImage(rgba, TILE, TILE).toJPEG(72);
      fs.writeFileSync(path.join(dir, `${tx}_${ty}.jpg`), jpg); satBytes += jpg.length;
    });
  dataPbo.close();
  const satLevels = [0, 1, 2, 3, 4].map(level => (satSize >> 2 << level) / TILE);
  console.log(`satellite ${satTiles.length} source tiles, levels ${satLevels.join('/')} tiles across, ${(satBytes / 1048576).toFixed(1)} MB`);
  const groundPoints = [...text('mapgrouppos.xml').matchAll(/pos="([\d.]+) ([\d.-]+) ([\d.]+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  const terrain = buildHeights(normals.rgba, normals.w, SIZE, groundPoints, 512);
  // Shaded relief: darkening only, so the paper map underneath keeps its colours.
  const relief = Buffer.alloc(normals.w * normals.w * 4);
  for (let p = 0; p < terrain.shade.length; p++) relief.set([40, 28, 16, Math.max(0, Math.min(170, (205 - terrain.shade[p]) * 1.2))], p * 4);
  fs.writeFileSync(path.join(OUT, 'relief.png'), toImage(relief, normals.w, normals.w).toPNG());
  // Heights: decimetres as 16 bits in R (high) and G (low), rows from the north.
  const hm = Buffer.alloc(terrain.n * terrain.n * 4);
  let low = Infinity, high = -Infinity;
  terrain.heights.forEach((v, p) => {
    const d = Math.max(0, Math.min(65535, Math.round(v * 10)));
    hm.set([d >> 8, d & 255, 0, 255], p * 4); low = Math.min(low, v); high = Math.max(high, v);
  });
  fs.writeFileSync(path.join(OUT, 'heights.png'), toImage(hm, terrain.n, terrain.n).toPNG());
  console.log(`terrain ${terrain.n}x${terrain.n}, ${Math.round(low)}-${Math.round(high)} m, slope scale ${terrain.scale.toFixed(2)}, ` +
    `error vs held-out building heights ${terrain.testRms.toFixed(1)} m`);

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
    const v = flags[24 + cells * cells * 4 + (cells - 1 - y * step) * cells + x * step];
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
  const zones = JSON.parse(text('cfgeffectarea.json')).Areas
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
  for (const t of JSON.parse(text('cfgundergroundtriggers.json')).Triggers) {
    if (!/out+er|entrance/i.test(t.Comment || '')) continue;
    const [x, , z] = t.Position, name = t.Comment.replace(/_?(Out+er|Entrance).*$/i, '').replace(/_/g, ' ');
    if (!underground.some(u => Math.hypot(u[0] - x, u[1] - z) < 40)) underground.push([round(x), round(z), name]);
  }
  const spawns = [...text('cfgplayerspawnpoints.xml').split('<fresh>')[1].split('</fresh>')[0].matchAll(/<pos ([^>]*)\/>/g)]
    .map(p => { const a = attrs(p[1]); return [round(+a.x), round(+a.z)]; });
  ce.close();

  // Powerlines and signs from the export mod's file (see README), when it has been copied into exports/.
  const exported = path.join(__dirname, '..', 'exports', 'nasdara_objects.json');
  let power = null, signList = null;
  if (fs.existsSync(exported)) {
    const objects = parseExport(fs.readFileSync(exported, 'utf8'));
    power = powerlines(objects); signList = signs(objects);
    console.log(`exported objects ${objects.length}: powerline spans ${power.segments.length}, poles ${power.poles.length}, signs ${signList.length}`);
  } else console.log('no exports/nasdara_objects.json: powerline and sign layers skipped');
  const spawnTier1 = spawns.filter(([x, z]) => tierAt(x, z) & 1).length;
  console.log(`buildings ${buildings.length / STRIDE} (${types.length} types), loot items ${items.length}, ` +
    `events ${Object.entries(events).map(([k, v]) => `${k} ${v.length}`).join(', ')}, zones ${zones.length}, infected ${infected.length}, animals ${animals.length}, underground ${underground.length}, ` +
    `spawns ${spawns.length} (${spawnTier1} in Tier1)`);
  if (spawnTier1 < spawns.length * 0.5) throw new Error('tier raster orientation check failed');

  const data = { name: 'Nasdara', size: SIZE, tile: TILE, levels, satLevels, labels, labelScale: metersPerPixel, terrain: { size: terrain.n, low: Math.round(low), high: Math.round(high) }, usages: USAGES, stride: STRIDE, types, buildings, items, events, zones, spawns, zoneTypes, infected, animals, underground, power, signs: signList };
  fs.writeFileSync(path.join(OUT, 'data.js'), `window.MAP_DATA=${JSON.stringify(data)};\n`);
  console.log(`data.js ${(fs.statSync(path.join(OUT, 'data.js')).size / 1024).toFixed(0)} KB -> ${OUT}`);
}

app.whenReady().then(() => {
  try { build(); app.exit(0); }
  catch (error) { console.error(error.message); app.exit(1); }
});
