// Offline DayZ map (whichever boot.js picked): base-map tiles plus Central Economy overlays on one canvas, redrawn only on change.
const $ = id => document.getElementById(id);
const data = window.MAP_DATA;
// This map's files and its own saved view, base and layers (Nasdara's keys predate other maps: "nasdara-view").
const ROOT = window.MAP_ROOT || 'nasdara/', MAP_ID = window.MAP_ID || 'nasdara';
const { lootBuildings, typeBuildings, search, pretty, eventIcon, sourceIcon } = window.MapLoot;
const LAYERS = [
  ['Buildings', [['military', 'Military', '#d8352a', true], ['police', 'Police / prison', '#2f6fe0', true],
    ['medical', 'Medical', '#f2f2f2', true], ['fire', 'Fire station', '#ff7b1c', true], ['hunting', 'Hunting', '#7a9a3a', false],
    ['industrial', 'Industrial / farm', '#9a7b4f', false], ['civilian', 'Civilian', '#6d5a45', false], ['wreck', 'Wrecks', '#555', false]]],
  ['Events', [['vehicle', 'Vehicles', '#19a974', true], ['heli', 'Heli crashes', '#ff4136', true], ['convoy', 'Military convoys', '#b10dc9', true],
    ['policecar', 'Police cars', '#0074d9', false], ['container', 'Locked containers', '#ffdc00', false], ['watertruck', 'Water trucks', '#7fdbff', false]]],
  ['Map', [['relief', 'Shaded relief', '#5a4632', true], ['topo', 'Topography', '#46321e', true], ['mainroads', 'Main roads', '#d64014', true],
    ['places', 'Place names (game)', '#1d140b', true], ['roadnet', 'Roads (surveyed)', '#3c3c42', true], ['outlines', 'Building outlines', '#2b2b2b', true], ['forest', 'Forest', '#1e6e28', false],
    ['power', 'Powerlines', '#2b2b2b', true], ['signs', 'Road signs', '#f2f2f2', false], ['water', 'Wells & water', '#2aa1ff', true],
    ['fuel', 'Fuel pumps', '#ff9f1c', true]]],
  ['Areas', [['zones', 'Toxic zones', '#c5e000', true], ['infected', 'Infected zones', '#8a8a8a', false],
    ['underground', 'Bunkers & tunnels', '#00d0d0', true], ['game', 'Game animals', '#b5651d', false], ['predators', 'Bears & wolves', '#a01e1e', false], ['dogs', 'Dogs', '#5c3a1e', false],
    ['critters', 'Small animals', '#e0c068', false], ['spawns', 'Player spawns', '#ffffff', false], ['tiers', 'Loot tiers', '#eb8714', false]]]
];
// Infected zone colour by type; animal species by layer.
const INFECTED_COLORS = [[/Army|NBC/, '#d8352a'], [/Police/, '#2f6fe0'], [/Medic/, '#f2f2f2'], [/Fire/, '#ff7b1c'], [/Industrial/, '#9a7b4f'], [/./, '#8a8a8a']];
const ANIMAL_LAYER = { mouflon: 'game', wild_boar: 'game', sheep: 'game', goat: 'game', sheep_goat: 'game', cattle: 'game', pig: 'game',
  red_deer: 'game', roe_deer: 'game', reindeer: 'game', bear: 'predators', wolf: 'predators', dobermann_shepherd: 'dogs' };
const animalLayer = species => ANIMAL_LAYER[species] || 'critters';
// Layers that exist only after the export mod has run (README), by the data they need.
const NEEDS = { mainroads: 'mainroads', places: 'places', power: 'power', signs: 'signs', roadnet: 'roadnet', outlines: 'outlines', forest: 'forest', water: 'uses', fuel: 'uses' };
const words = name => name.replace(/^Infec?t?e?d/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
// Base map under everything: the in-game paper map, the satellite image, or plain white.
// Chernarus has no paper map in the game files; its "paper" tiles are drawn from the terrain at build time.
const BASES = [['paper', data?.paper === false ? 'Topographic' : 'Paper map'], ['satellite', 'Satellite'], ['white', 'White']];
const baseKind = () => (base === 'satellite' ? 'sat' : 'tiles');
const COLORS = Object.fromEntries(LAYERS.flatMap(([, l]) => l.map(([id, , color]) => [id, color])));
const S = data?.stride;
const canvas = $('map'), ctx = canvas.getContext('2d');
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let W = 0, H = 0, dpr = 1, view, layers, selection = null, hover = null, pending = false;
const tiles = new Map(); // key -> Image, insertion order doubles as LRU
let frame = 0; // draw counter, to tell which tiles the current frame uses
let tierImage = null, labelImage = null, reliefImage = null, forestImage = null, heightGrid = null, in3d = false, base = 'paper';

// Pre-render each square PNG into a circular badge once, shared with the 3D view.
const ICON_FILES = { military: 'military', police: 'police', medical: 'medic', fire: 'fire',
  heli: 'heli', convoy: 'military', policecar: 'pcar', watertruck: 'truck',
  vehicle: 'car', car: 'car', truck: 'truck', dirtbike: 'dirtbike', well: 'well',
  water: 'water', fuel: 'fuel', grocery: 'grocery', power: 'telephoneline' };
const markerBadges = new Map();
const buildingIcon = type => /(?:shop|market|grocery|store)/i.test(type.name) ? 'grocery' : type.layer;
function badgeCanvas(image, color = '#aaa') {
  const badge = document.createElement('canvas'); badge.width = badge.height = 96;
  const g = badge.getContext('2d');
  g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2);
  g.fillStyle = '#151515'; g.fill();
  if (image) {
    g.save(); g.clip();
    // Contain and center the original square; clip only its outer corners.
    const scale = 88 / Math.max(image.naturalWidth, image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    g.drawImage(image, 48 - w / 2, 48 - h / 2, w, h); g.restore();
  } else { g.fillStyle = color; g.fill(); }
  g.strokeStyle = '#e3d9c8'; g.lineWidth = 3; g.stroke();
  return badge;
}
for (const [id, file] of Object.entries(ICON_FILES)) {
  const image = new Image();
  image.onload = () => {
    markerBadges.set(id, badgeCanvas(image)); redraw();
    if (in3d) window.Map3D.layersChanged(id);
  };
  image.src = `icons/${file}.png`;
}
function marker(x, z, r, id, color = COLORS[id]) {
  const badge = markerBadges.get(id);
  if (!badge) { dot(x, z, r, color); return; }
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  const size = Math.max(18, Math.min(28, r * 3.2));
  // Keep pictograms upright when the map rotates.
  ctx.save(); ctx.translate(sx, sy); ctx.rotate(-view.r);
  ctx.drawImage(badge, -size / 2, -size / 2, size, size); ctx.restore();
}

let userPins;
function pinScreen(x, z) {
  const [sx, sy] = toScreen(x, z), dx = sx - W / 2, dy = sy - H / 2;
  return [W / 2 + dx * Math.cos(view.r) - dy * Math.sin(view.r), H / 2 + dx * Math.sin(view.r) + dy * Math.cos(view.r)];
}

function fitScale() { return Math.min(W, H) / data.size; }
function clampView() {
  view.s = Math.min(4, Math.max(fitScale() * 0.9, view.s));
  view.x = Math.min(data.size, Math.max(0, view.x)); view.z = Math.min(data.size, Math.max(0, view.z));
}
// Drawing happens in an unrotated "map frame"; the canvas then rotates it by view.r (clockwise) about the centre.
const toScreen = (x, z) => [W / 2 + (x - view.x) * view.s, H / 2 - (z - view.z) * view.s];
function unrotate(sx, sy) {
  const dx = sx - W / 2, dy = sy - H / 2, c = Math.cos(view.r), s = Math.sin(view.r);
  return [W / 2 + dx * c + dy * s, H / 2 - dx * s + dy * c];
}
function toWorld(sx, sy) {
  const [fx, fy] = unrotate(sx, sy);
  return [view.x + (fx - W / 2) / view.s, view.z - (fy - H / 2) / view.s];
}
function redraw() { if (!pending) { pending = true; requestAnimationFrame(draw); } }
function saveView() { store.set(`${MAP_ID}-view`, view); }

function tile(kind, level, tx, ty) {
  const key = `${kind}/${level}/${tx}_${ty}`;
  let img = tiles.get(key);
  if (img) { tiles.delete(key); tiles.set(key, img); img.frame = frame; return img.complete && img.naturalWidth ? img : null; }
  img = new Image(); img.onload = redraw; img.src = `${ROOT}${key}.${kind === 'tiles' || kind === 'sat' ? 'jpg' : 'png'}`;
  img.frame = frame; tiles.set(key, img);
  // Older tiles are dropped so deep zooming stays light on memory, but never one this frame draws: the base and
  // three overlays can need more than the cap together, and evicting those left black holes that never filled in.
  while (tiles.size > 96) {
    const [oldest, old] = tiles.entries().next().value;
    if (old.frame === frame) break;
    tiles.delete(oldest);
  }
  return null;
}
// Satellite has two extra, sharper levels (2 and 1 m/px); paper map and overlays stop at 4 m/px.
const levelsOf = kind => (kind === 'sat' && data.satLevels) || data.levels;
// Smallest level that is sharp at the current zoom, else the sharpest there is.
function levelFor(kind) {
  const list = levelsOf(kind), i = list.findIndex(n => n * data.tile / data.size >= view.s * dpr * 0.85);
  return i < 0 ? list.length - 1 : i;
}
function drawLevel(level, need, kind = 'tiles') {
  const n = levelsOf(kind)[level], span = data.size / n;
  const corners = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)];
  const x0 = Math.min(...corners.map(c => c[0])), x1 = Math.max(...corners.map(c => c[0]));
  const z0 = Math.min(...corners.map(c => c[1])), z1 = Math.max(...corners.map(c => c[1]));
  let complete = true;
  for (let ty = Math.max(0, Math.floor((data.size - z1) / span)); ty < Math.min(n, Math.ceil((data.size - z0) / span)); ty++)
    for (let tx = Math.max(0, Math.floor(x0 / span)); tx < Math.min(n, Math.ceil(x1 / span)); tx++) {
      const img = tile(kind, level, tx, ty);
      if (!img) { complete = false; continue; }
      const [sx, sy] = toScreen(tx * span, data.size - ty * span);
      ctx.drawImage(img, sx, sy, span * view.s + 0.5, span * view.s + 0.5);
    }
  return complete || !need;
}
// A whole-map image, cropped to the part in view: stretching all of it to tens of thousands of pixels misrenders when zoomed in.
function drawWhole(img) {
  const corners = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)], k = img.width / data.size;
  const px0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0])) * k) - 1), px1 = Math.min(img.width, Math.ceil(Math.max(...corners.map(c => c[0])) * k) + 1);
  const py0 = Math.max(0, Math.floor((data.size - Math.max(...corners.map(c => c[1]))) * k) - 1), py1 = Math.min(img.height, Math.ceil((data.size - Math.min(...corners.map(c => c[1]))) * k) + 1);
  if (px1 <= px0 || py1 <= py0) return;
  const [sx, sy] = toScreen(px0 / k, data.size - py0 / k);
  ctx.drawImage(img, px0, py0, px1 - px0, py1 - py0, sx, sy, (px1 - px0) / k * view.s, (py1 - py0) / k * view.s);
}
function draw() {
  pending = false; frame++;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H); // the window colour shows around the map
  ctx.translate(W / 2, H / 2); ctx.rotate(view.r); ctx.translate(-W / 2, -H / 2);
  // Pick the smallest tile level that is sharp at this zoom; level 0 underneath while it loads.
  const level = levelFor(baseKind()), overlay = levelFor('contours');
  if (base === 'white') {
    const [sx, sy] = toScreen(0, data.size); ctx.fillStyle = '#fff'; ctx.fillRect(sx, sy, data.size * view.s, data.size * view.s);
  } else {
    if (level > 0) drawLevel(0, false, baseKind());
    drawLevel(level, true, baseKind());
  }
  // The relief is 16 m/px: zoomed in, one dark slope pixel would stretch over the whole screen, so it fades out from 4 m/px.
  if (layers.relief && reliefImage?.complete && view.s < 1) {
    ctx.globalAlpha = Math.min(1, (1 - view.s) / 0.75) * (base === 'satellite' ? 0.5 : 1); drawWhole(reliefImage); ctx.globalAlpha = 1;
  }
  if (layers.forest && data.forest && forestImage?.complete) drawWhole(forestImage);
  if (layers.topo) drawLevel(overlay, false, 'contours');
  if (layers.roadnet && data.roadnet) drawLevel(overlay, false, 'roadnet');
  if (layers.outlines && data.outlines && view.s >= 0.4) drawOutlines();
  // The bold road trace is 4 m/px; past 2 m/px it only smudges over the real road, so it fades out.
  if (layers.mainroads && view.s < 0.5) {
    ctx.globalAlpha = Math.min(1, (0.5 - view.s) / 0.25); drawLevel(overlay, false, 'roads'); ctx.globalAlpha = 1;
  }
  if (layers.tiers && tierImage?.complete) { ctx.imageSmoothingEnabled = false; drawWhole(tierImage); ctx.imageSmoothingEnabled = true; }
  // Marker size grows gently with zoom; black outlines keep them readable on the parchment.
  const r = Math.max(3.5, Math.min(9, 3 + view.s * 5));
  if (layers.infected) for (const [x, z, radius, type] of data.infected) {
    const color = INFECTED_COLORS.find(([re]) => re.test(data.zoneTypes[type]))[1];
    area(x, z, radius, color, 0.18);
  }
  for (const [x, z, radius, species] of data.animals) { const layer = animalLayer(species); if (layers[layer]) area(x, z, radius, COLORS[layer], 0.22); }
  if (layers.zones) for (const zone of data.zones) {
    const [sx, sy] = toScreen(zone.x, zone.z);
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(4, zone.r * view.s), 0, 7);
    ctx.fillStyle = '#c5e00040'; ctx.fill(); ctx.strokeStyle = '#9fb500'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  const b = data.buildings, dim = !!selection;
  ctx.globalAlpha = dim ? 0.35 : 1;
  for (let i = 0; i < b.length; i += S) {
    const layer = data.types[b[i]].layer;
    if (layers[layer]) marker(b[i + 1], b[i + 2], r * 0.8, buildingIcon(data.types[b[i]]), COLORS[layer]);
  }
  for (const [layer, points] of Object.entries(data.events)) if (layers[layer]) for (const [x, z, name] of points) marker(x, z, r + 1, eventIcon(layer, name), COLORS[layer]);
  if (layers.spawns) for (const [x, z] of data.spawns) ring(x, z, 6, '#ffffff');
  if (layers.underground) for (const [x, z] of data.underground) hatch(x, z, r + 2);
  if (layers.power && data.power) drawPower();
  if (layers.signs && data.signs) for (const [x, z] of data.signs) dot(x, z, Math.max(2.5, r * 0.6), '#f2f2f2');
  for (const kind of ['water', 'fuel']) if (layers[kind] && data.uses) for (const [x, z, name] of data.uses[kind]) marker(x, z, r, sourceIcon(kind, name), COLORS[kind]);
  ctx.globalAlpha = 1;
  if (selection?.kind === 'place') ring(selection.x, selection.z, r + 8, '#ffcf3f');
  if (selection) for (const i of selection.buildings) { ring(b[i * S + 1], b[i * S + 2], r + 3, '#ffcf3f'); marker(b[i * S + 1], b[i * S + 2], r * 0.8, buildingIcon(data.types[b[i * S]]), '#ffcf3f'); }
  if (hover) ring(hover.x, hover.z, r + 5, '#fff');
  drawLocated();
  drawLabels();
  if (!in3d) userPins?.render(pinScreen, toWorld);
}
// Place names lifted off the paper map, drawn upright at their map position whatever the rotation.
function drawLabels() {
  if (!labelImage?.complete || !data.labels) return;
  const k = Math.min(1.5, view.s * data.labelScale), c = Math.cos(view.r), s = Math.sin(view.r);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Black names need a light halo to read on the dark satellite image.
  if (base === 'satellite') { ctx.shadowColor = '#fff'; ctx.shadowBlur = 4; }
  const game = layers.places && data.places;
  for (const [i, [x, z, ax, ay, w, h]] of data.labels.entries()) {
    if (h * k < 3 || (game && paperNames.has(i))) continue;
    const [fx, fy] = toScreen(x, z), dx = fx - W / 2, dy = fy - H / 2;
    const sx = W / 2 + dx * c - dy * s, sy = H / 2 + dx * s + dy * c;
    if (sx < -w * k || sy < -h * k || sx > W + w * k || sy > H + h * k) continue;
    ctx.drawImage(labelImage, ax, ay, w, h, sx - w * k / 2, sy - h * k / 2, w * k, h * k);
  }
  ctx.shadowBlur = 0;
  if (game) drawPlaces(c, s);
}
// Game place names (export mod), upright, largest first; smaller kinds appear as you zoom in.
const PLACE_STYLE = [[/Capital/, 'bold 18px', 0], [/City/, 'bold 15px', 0], [/Village/, '600 13px', 0.05], [/Marine/, 'italic 12px', 0.08], [/./, 'italic 11px', 0.12]];
// Paper-map name labels (wider than a grid number) near a game place: hidden while game names are shown.
let paperNames = new Set();
function drawPlaces(c, s) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const dark = base === 'satellite';
  for (const [x, z, name, type] of data.places) {
    const [font, minScale] = PLACE_STYLE.find(([re]) => re.test(type)).slice(1);
    if (view.s < minScale) continue;
    const [fx, fy] = toScreen(x, z), dx = fx - W / 2, dy = fy - H / 2;
    const sx = W / 2 + dx * c - dy * s, sy = H / 2 + dx * s + dy * c;
    if (sx < -200 || sy < -40 || sx > W + 200 || sy > H + 40) continue;
    ctx.font = `${font} 'Segoe UI', sans-serif`;
    ctx.strokeStyle = dark ? '#000c' : '#f4ead2e0'; ctx.lineWidth = 4; ctx.strokeText(name, sx, sy);
    ctx.fillStyle = /Marine/.test(type) ? (dark ? '#9fd4ff' : '#1d4e8a') : dark ? '#fff' : '#1d140b';
    ctx.fillText(name, sx, sy);
  }
}
// Map-frame points within the rotated viewport's bounding circle.
function onScreen(sx, sy) { const d = Math.hypot(W, H) / 2 + 20; return Math.abs(sx - W / 2) < d && Math.abs(sy - H / 2) < d; }
// Black screen-sized dashes stay readable even when pole segments are very short.
function drawPower() {
  ctx.strokeStyle = '#000'; ctx.lineCap = 'butt';
  for (const family of ['pole', 'hv']) {
    const hv = family === 'hv';
    ctx.lineWidth = hv ? 2 : 1.4; ctx.setLineDash(hv ? [6, 4] : [4, 4]);
    let distance = 0;
    for (const [x1, z1, x2, z2, f] of data.power.segments) {
      if (f !== family) continue;
      const [ax, ay] = toScreen(x1, z1), [bx, by] = toScreen(x2, z2);
      const offset = distance; distance += Math.hypot(bx - ax, by - ay);
      if (!onScreen(ax, ay) && !onScreen(bx, by)) continue;
      ctx.lineDashOffset = -offset;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }
  ctx.setLineDash([]); ctx.lineDashOffset = 0;
}
// Building and structure outlines from the export, at true size and rotation, once zoomed in enough to read.
// There are tens of thousands, so they are built once into world-space paths per 512 m cell and only visible cells are drawn.
const OUTLINE_CELL = 512;
let outlineCells = null;
function buildOutlineCells() {
  const o = data.outlines, n = Math.ceil(data.size / OUTLINE_CELL);
  outlineCells = { n, paths: Array.from({ length: n * n }, () => new Path2D()) };
  for (let i = 0; i < o.length; i += 5) {
    const x = o[i], z = o[i + 1], hw = o[i + 2], hd = o[i + 3], c = Math.cos(o[i + 4]), s = Math.sin(o[i + 4]);
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / OUTLINE_CELL))), cz = Math.min(n - 1, Math.max(0, Math.floor(z / OUTLINE_CELL)));
    const p = outlineCells.paths[cz * n + cx];
    // Model x runs along (cos, -sin) and model z along (sin, cos) in world x, z.
    p.moveTo(x - hw * c - hd * s, z + hw * s - hd * c);
    p.lineTo(x + hw * c - hd * s, z - hw * s - hd * c);
    p.lineTo(x + hw * c + hd * s, z - hw * s + hd * c);
    p.lineTo(x - hw * c + hd * s, z + hw * s + hd * c);
    p.closePath();
  }
}
function drawOutlines() {
  if (!outlineCells) buildOutlineCells();
  const { n, paths } = outlineCells;
  const corners = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)];
  // Cells hold outlines by centre, so pad by one cell for buildings that straddle an edge.
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0])) / OUTLINE_CELL) - 1), x1 = Math.min(n - 1, Math.floor(Math.max(...corners.map(c => c[0])) / OUTLINE_CELL) + 1);
  const z0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1])) / OUTLINE_CELL) - 1), z1 = Math.min(n - 1, Math.floor(Math.max(...corners.map(c => c[1])) / OUTLINE_CELL) + 1);
  ctx.save();
  // World x, z straight onto the (already rotated) map frame; screen y points south.
  ctx.translate(W / 2 - view.x * view.s, H / 2 + view.z * view.s); ctx.scale(view.s, -view.s);
  ctx.fillStyle = base === 'satellite' ? '#ffffff30' : '#5a463240';
  ctx.strokeStyle = base === 'satellite' ? '#ffffffb0' : '#2b2b2b'; ctx.lineWidth = Math.min(1.5, 0.5 + view.s) / view.s;
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) { const p = paths[cz * n + cx]; ctx.fill(p); ctx.stroke(p); }
  ctx.restore();
}
// Water source / fuel pump: a coloured drop with a dark edge.
function drop(x, z, r, color) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.beginPath(); ctx.moveTo(sx, sy - r * 1.4); ctx.quadraticCurveTo(sx + r, sy, sx, sy + r * 0.9); ctx.quadraticCurveTo(sx - r, sy, sx, sy - r * 1.4);
  ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
}
// Territory circle at true size (at least a few pixels), translucent with a solid edge.
function area(x, z, radius, color, alpha) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, radius * view.s), 0, 7);
  ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}
// Bunker/tunnel entrance: cyan square with a black outline and a down-arrow.
function hatch(x, z, r) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.fillStyle = '#00d0d0'; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
  ctx.beginPath(); ctx.moveTo(sx - r * 0.55, sy - r * 0.3); ctx.lineTo(sx + r * 0.55, sy - r * 0.3); ctx.lineTo(sx, sy + r * 0.5); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill();
}
function dot(x, z, r, color) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.25; ctx.stroke();
}
function diamond(x, z, r, color) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.beginPath(); ctx.moveTo(sx, sy - r); ctx.lineTo(sx + r, sy); ctx.lineTo(sx, sy + r); ctx.lineTo(sx - r, sy); ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
}
function ring(x, z, r, color) {
  const [sx, sy] = toScreen(x, z); if (!onScreen(sx, sy)) return;
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.strokeStyle = '#000'; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
}

// Nearest visible marker under the cursor, for the tooltip.
function pick(mx, my, project = toScreen, rotated = true) {
  const [sx, sy] = rotated ? unrotate(mx, my) : [mx, my];
  let best = null, bestD = 14 * 14;
  const consider = (x, z, label, sub) => {
    const [px, py] = project(x, z), d = (px - sx) ** 2 + (py - sy) ** 2;
    if (d < bestD) { bestD = d; best = { x, z, label, sub }; }
  };
  const b = data.buildings, picked = selection ? new Set(selection.buildings) : null;
  for (let i = 0; i < b.length; i += S) {
    const type = data.types[b[i]];
    if (layers[type.layer] || picked?.has(i / S)) consider(b[i + 1], b[i + 2], pretty(type.name), tierText(b[i + 3]));
  }
  for (const [layer, points] of Object.entries(data.events)) if (layers[layer])
    for (const [x, z, name] of points) consider(x, z, name.replace(/^(Static|Vehicle)/, m => m === 'Vehicle' ? 'Vehicle: ' : ''), 'Event spawn');
  if (layers.zones) for (const zone of data.zones) consider(zone.x, zone.z, `Toxic zone ${zone.name}`, `radius ${zone.r} m`);
  if (layers.underground) for (const [x, z, name] of data.underground) consider(x, z, words(name), 'Underground entrance');
  if (layers.signs && data.signs) for (const [x, z, name] of data.signs) consider(x, z, words(name), 'Sign');
  for (const [kind, sub] of [['water', 'Drinking water'], ['fuel', 'Fuel']]) if (layers[kind] && data.uses)
    for (const [x, z, name] of data.uses[kind]) consider(x, z, words(name), sub);
  if (layers.infected) for (const [x, z, radius, type] of data.infected) consider(x, z, `Infected: ${words(data.zoneTypes[type]) || 'zone'}`, `radius ${radius} m`);
  for (const [x, z, radius, species, kind] of data.animals) if (layers[animalLayer(species)])
    consider(x, z, words(species).replace(/^w/, c => c.toUpperCase()), `${words(kind).replace(/^Zones*/, '') || 'Territory'} · radius ${radius} m`);
  return best;
}
function tierText(t) { const s = [1, 2, 4, 8].filter(v => t & v).map(v => `T${Math.log2(v) + 1}`); return s.length ? s.join('/') : ''; }

function select(hit) {
  if (!hit) { selection = null; $('selection').hidden = true; redraw(); if (in3d) window.Map3D.selectionChanged(); return; }
  // A place: centre on it (zoomed in to show at least about 4 km across) and ring it.
  if (hit.kind === 'place') {
    const [x, z, name, type] = data.places[hit.index];
    selection = { ...hit, x, z, buildings: [] };
    $('selectionText').textContent = `${name} · ${placeType(type)}`;
    $('selection').hidden = false; $('results').hidden = true; $('query').blur();
    if (in3d) window.Map3D.focus(x, z);
    else { view.x = x; view.z = z; view.s = Math.max(view.s, Math.min(W, H) / 4000); clampView(); saveView(); }
    redraw(); if (in3d) window.Map3D.selectionChanged(); return;
  }
  const buildings = hit.kind === 'item' ? lootBuildings(data, data.items[hit.index]) : typeBuildings(data, hit.index);
  selection = { ...hit, buildings };
  $('selectionText').textContent = `${hit.label}: ${buildings.length} building${buildings.length === 1 ? '' : 's'}`;
  $('selection').hidden = false; $('results').hidden = true; $('query').blur();
  redraw(); if (in3d) window.Map3D.selectionChanged();
}
// Where am I (src/locator.js through window.desk): the answer as a circle with a cone for the facing, other
// likely spots as faint rings, and the #located card. Screenshots come from the game window (button or
// Ctrl+Alt+L in game), a paste or a drop; "Add a view" combines another view from the same spot.
let located = null, locating = false;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const LOCATED = '#FF7A45';
function drawLocated() {
  if (!located) return;
  for (const c of located.candidates.slice(1)) if (c.share >= 0.05) ring(c.x, c.z, 9, `${LOCATED}99`);
  const [sx, sy] = toScreen(located.x, located.z), r = Math.max(10, located.radius * view.s);
  // Facing: a 60° cone (about what one screenshot shows), compass heading clockwise from north (up).
  const h = located.heading * Math.PI / 180 - Math.PI / 2, reach = Math.max(34, r * 1.5);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, reach, h - Math.PI / 6, h + Math.PI / 6); ctx.closePath();
  ctx.fillStyle = `${LOCATED}55`; ctx.fill();
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7);
  ctx.fillStyle = `${LOCATED}2e`; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.stroke();
  ctx.strokeStyle = LOCATED; ctx.lineWidth = 2; ctx.stroke();
  dot(located.x, located.z, 5, LOCATED);
}
function showLocated(result) {
  const card = $('located');
  card.hidden = false;
  card.classList.toggle('busy', !!result.busy); card.classList.toggle('error', !!result.error);
  $('locateMore').hidden = !!result.busy || !!result.error || !located;
  $('locate').classList.toggle('busy', !!result.busy);
  if (result.busy) { $('locatedTitle').textContent = 'Looking…'; $('locatedText').textContent = 'Comparing the screenshot with the captured pictures.'; return; }
  if (result.error) { $('locatedTitle').textContent = "Couldn't locate"; $('locatedText').textContent = result.error; return; }
  located = result;
  $('locateMore').hidden = false;
  const others = result.candidates.slice(1).filter(c => c.share >= 0.05).length;
  $('locatedTitle').textContent = `X ${result.x}  Y ${result.z}`;
  $('locatedText').textContent = [
    `Within about ${result.radius} m, facing ${COMPASS[Math.round(result.heading / 45) % 8]} (${Math.round(result.heading)}°).`,
    `${Math.round(result.confidence * 100)}% sure from ${result.views} view${result.views === 1 ? '' : 's'}.`,
    others ? `${others} other possible spot${others === 1 ? '' : 's'} ringed.` : '',
    result.confidence < 0.7 ? 'Turn on the spot and add a view to narrow it down.' : ''
  ].filter(Boolean).join(' ');
  if (in3d) window.Map3D.focus(result.x, result.z);
  else { view.x = result.x; view.z = result.z; view.s = Math.max(view.s, Math.min(W, H) / Math.max(1500, result.radius * 8)); clampView(); saveView(); }
  redraw();
}
async function locate(request = {}) {
  if (!window.desk?.locate || locating) return;
  locating = true; showLocated({ busy: true });
  const result = await window.desk.locate({ map: MAP_ID, ...request }).catch(error => ({ error: error.message }));
  locating = false; showLocated(result);
}
// Screenshots handed over as files: the first starts a spot, any more join it.
async function locateFiles(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  for (const [i, file] of images.entries()) await locate({ image: await file.arrayBuffer(), add: i > 0 });
}
function clearLocated() { located = null; $('located').hidden = true; redraw(); }

// "NameCityCapital" -> "city capital", "NameMarine" -> "marine", "Hill" -> "hill".
const placeType = type => (type.replace(/^Name/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'place');
let results = [], active = 0;
function showResults() {
  results = search(data, $('query').value); active = 0;
  const list = $('results'); list.replaceChildren();
  for (const [i, hit] of results.entries()) {
    const li = document.createElement('li'); li.className = i === active ? 'active' : '';
    const name = document.createElement('span'); name.textContent = hit.label;
    const kind = document.createElement('small');
    kind.textContent = hit.kind === 'item' ? data.items[hit.index].category || 'loot' : hit.kind === 'place' ? placeType(data.places[hit.index][3]) : 'building';
    li.append(name, kind); li.addEventListener('mousedown', e => { e.preventDefault(); select(hit); });
    list.append(li);
  }
  list.hidden = !results.length;
}

function buildLayerList() {
  const list = $('layerList');
  // The base map as a segmented control (styled from the radios inside).
  const heading = document.createElement('h3'); heading.textContent = 'Base map'; list.append(heading);
  const bases = document.createElement('div'); bases.className = 'seg'; bases.setAttribute('role', 'radiogroup'); list.append(bases);
  for (const [id, label] of BASES) {
    const row = document.createElement('label'), radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'base'; radio.checked = base === id;
    radio.addEventListener('change', () => { base = id; store.set(`${MAP_ID}-base`, base); redraw(); if (in3d) window.Map3D.layersChanged('base'); });
    row.append(radio, label.replace(/ map$/, '')); bases.append(row);
  }
  for (const [group, items] of LAYERS) {
    const h = document.createElement('h3'); h.textContent = group.toUpperCase(); list.append(h);
    for (const [id, label, color] of items) {
      if (NEEDS[id] && !data[NEEDS[id]]) continue; // only after the export mod has run
      const row = document.createElement('label'), box = document.createElement('input'), swatch = document.createElement('i');
      box.type = 'checkbox'; box.checked = !!layers[id];
      if (ICON_FILES[id]) {
        const image = document.createElement('img'); image.src = `icons/${ICON_FILES[id === 'water' ? 'well' : id]}.png`; image.alt = '';
        swatch.className = 'icon-badge'; swatch.append(image);
      } else swatch.style.background = color;
      box.addEventListener('change', () => { layers[id] = box.checked; store.set(`${MAP_ID}-layers`, layers); redraw(); if (in3d) window.Map3D.layersChanged(id); });
      row.append(box, swatch, label); list.append(row);
    }
  }
  const setOpen = open => {
    $('layers').classList.toggle('closed', !open); $('layersToggle').setAttribute('aria-expanded', String(open));
  };
  setOpen(store.get(`${MAP_ID}-layers-open`) === true);
  $('layersToggle').addEventListener('click', () => {
    const open = $('layers').classList.contains('closed'); setOpen(open); store.set(`${MAP_ID}-layers-open`, open);
  });
}
function resize() {
  dpr = window.devicePixelRatio || 1; W = innerWidth; H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; clampView(); redraw();
}
// Ground height (m) from heights.png at world x, z, nearest cell; null until loaded.
function groundHeight(x, z) {
  if (!heightGrid) return null;
  const n = heightGrid.n, cx = Math.min(n - 1, Math.max(0, Math.floor(x / data.size * n))), cy = Math.min(n - 1, Math.max(0, Math.floor((data.size - z) / data.size * n)));
  return heightGrid.h[cy * n + cx];
}
function loadHeights() {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data, h = new Float32Array(img.width * img.height);
    for (let p = 0; p < h.length; p++) h[p] = (px[p * 4] * 256 + px[p * 4 + 1]) / 10;
    heightGrid = { n: img.width, h };
  };
  img.src = data.terrain?.fine ? `${ROOT}heights-fine.png` : `${ROOT}heights.png`;
}
// The 3D view and three.js load on first use only.
function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src)); document.body.append(s);
  });
}
async function toggle3d() {
  userPins?.cancel();
  const button = $('toggle3d');
  if (in3d) {
    const at = window.Map3D.close(); in3d = false;
    view.x = at.x; view.z = at.z; if (at.s) view.s = at.s; clampView(); setRotation(at.r);
  } else {
    button.disabled = true;
    try {
      if (!window.THREE) await script('vendor/three.min.js');
      if (!window.Map3D) await script('map3d.js');
      $('tooltip').hidden = true; hover = null;
      await window.Map3D.open(); in3d = true;
    } catch (error) { console.error('3D view unavailable:', error); }
    button.disabled = false;
  }
  button.setAttribute('aria-pressed', String(in3d));
}
function setRotation(r) {
  view.r = ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  $('compass').firstChild.style.transform = `rotate(${view.r}rad)`;
  saveView(); redraw();
}
// Global keybind commands from the main process; pans move the view in screen directions.
function command(name) {
  if (in3d) return window.Map3D.command(name);
  const step = Math.min(W, H) / 4, pan = { up: [0, -step], down: [0, step], left: [-step, 0], right: [step, 0] };
  if (pan[name]) { [view.x, view.z] = toWorld(W / 2 + pan[name][0], H / 2 + pan[name][1]); clampView(); saveView(); redraw(); }
  else if (name === 'zoomIn' || name === 'zoomOut') zoomAt(W / 2, H / 2, name === 'zoomIn' ? 1.25 : 0.8);
  else if (name === 'rotateLeft' || name === 'rotateRight') setRotation(view.r + (name === 'rotateLeft' ? -1 : 1) * Math.PI / 12);
}
function zoomAt(sx, sy, factor) {
  const [wx, wz] = toWorld(sx, sy);
  view.s *= factor; clampView();
  const [nx, nz] = toWorld(sx, sy); view.x += wx - nx; view.z += wz - nz; clampView();
  saveView(); redraw();
}

$('close').addEventListener('click', () => window.desk ? window.desk.close() : window.close());
// Full screen (also F11): the desk window itself in the app, the page in a plain browser.
function toggleFullscreen() {
  if (window.desk) window.desk.fullscreen();
  else if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}
$('fullscreen').addEventListener('click', toggleFullscreen);
addEventListener('keydown', e => { if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); } });
if (!data) $('missing').hidden = false;
else {
  document.title = `${data.name} · Mapino`;
  view = { x: data.size / 2, z: data.size / 2, s: 0, r: 0, ...store.get(`${MAP_ID}-view`) };
  base = BASES.some(([id]) => id === store.get(`${MAP_ID}-base`)) ? store.get(`${MAP_ID}-base`) : 'paper';
  // Saved choices over the defaults, so layers added since (e.g. after an export) start at their default.
  layers = { ...Object.fromEntries(LAYERS.flatMap(([, l]) => l.map(([id, , , on]) => [id, on]))), ...store.get(`${MAP_ID}-layers`) };
  // A paper map kept as printed (Sakhal) already shows its names: game place names start hidden there.
  if (data.paper && !data.labels.length && !('places' in (store.get(`${MAP_ID}-layers`) || {}))) layers.places = false;
  if (data.places && data.labels) data.labels.forEach(([x, z, , , w], i) => {
    if (w >= 30 && data.places.some(([px, pz]) => Math.hypot(px - x, pz - z) < 900)) paperNames.add(i);
  });
  tierImage = new Image(); tierImage.onload = redraw; tierImage.src = `${ROOT}tiers.png`;
  labelImage = new Image(); labelImage.onload = redraw; labelImage.src = `${ROOT}labels.png`;
  reliefImage = new Image(); reliefImage.onload = redraw; reliefImage.src = `${ROOT}relief.png`;
  if (data.forest) { forestImage = new Image(); forestImage.onload = redraw; forestImage.src = `${ROOT}forest.png`; }
  loadHeights();
  // 2D | 3D segmented control: each button selects its own view.
  $('toggle3d').addEventListener('click', () => { if (!in3d) toggle3d(); });
  $('view2d').addEventListener('click', () => { if (in3d) toggle3d(); });
  userPins = window.MapPins.mount({ size: data.size, saved: store.get(`${MAP_ID}-pins`),
    persist: points => store.set(`${MAP_ID}-pins`, points),
    onChange: () => { redraw(); if (in3d) window.Map3D.pinsChanged(); } });
  userPins.bindMap(canvas, toWorld);
  buildLayerList(); resize(); setRotation(view.r);
  if (!view.s) { view.s = fitScale(); redraw(); }
  window.desk?.onCommand(command);
  $('compass').addEventListener('click', () => in3d ? window.Map3D.command('north') : setRotation(0));
  addEventListener('resize', resize);
  let drag = null, mouse = [0, 0];
  // Dragging keeps the world point grabbed under the cursor, which also holds when rotated.
  canvas.addEventListener('pointerdown', e => { drag = toWorld(e.clientX, e.clientY); canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); });
  canvas.addEventListener('pointerup', () => { if (drag) saveView(); drag = null; canvas.classList.remove('drag'); });
  canvas.addEventListener('pointermove', e => {
    mouse = [e.clientX, e.clientY];
    const [x, z] = toWorld(e.clientX, e.clientY);
    const elevation = groundHeight(x, z);
    $('coords').textContent = `X ${Math.round(x)}  Y ${Math.round(z)}${elevation == null ? '' : `  ·  ${Math.round(elevation)} m`}`;
    if (drag) {
      view.x += drag[0] - x; view.z += drag[1] - z; clampView();
      $('tooltip').hidden = true; redraw(); return;
    }
    const hit = pick(e.clientX, e.clientY);
    if (hit?.x !== hover?.x || hit?.z !== hover?.z) { hover = hit; redraw(); }
    const tip = $('tooltip'); tip.hidden = !hit;
    if (hit) {
      tip.replaceChildren(hit.label, document.createElement('br'), Object.assign(document.createElement('small'),
        { textContent: `${Math.round(hit.x)}, ${Math.round(hit.z)}${hit.sub ? ` · ${hit.sub}` : ''}` }));
      tip.style.left = `${Math.min(e.clientX + 14, W - tip.offsetWidth - 6)}px`; tip.style.top = `${e.clientY + 14}px`;
    }
  });
  canvas.addEventListener('pointerleave', () => { $('tooltip').hidden = true; if (hover) { hover = null; redraw(); } });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
  $('query').addEventListener('input', showResults);
  $('query').addEventListener('focus', showResults);
  $('query').addEventListener('blur', () => { $('results').hidden = true; });
  $('query').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
      [...$('results').children].forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' && results[active]) select(results[active]);
    else if (e.key === 'Escape') $('query').blur();
  });
  $('clearSelection').addEventListener('click', () => select(null));
  window.desk?.places?.(MAP_ID).then(ready => { $('locate').hidden = !ready; }).catch(() => {});
  window.desk?.onLocated?.(showLocated);
  $('locate').addEventListener('click', () => locate());
  $('locateAgain').addEventListener('click', () => locate());
  $('locateMore').addEventListener('click', () => locate({ add: true }));
  $('closeLocated').addEventListener('click', clearLocated);
  addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile());
    if (files.some(f => f?.type.startsWith('image/'))) { e.preventDefault(); locateFiles(files); }
  });
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('drop-target'); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drop-target'); });
  addEventListener('drop', e => {
    document.body.classList.remove('drop-target');
    if (!hasFiles(e)) return;
    e.preventDefault(); locateFiles(e.dataTransfer.files);
  });
  addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea')) return; // typing in the search box or the server panel
    if (e.key === 'Escape') select(null);
    else if (e.key === '/' || (e.shiftKey && e.key === 'Q')) { e.preventDefault(); $('query').focus(); }
    else if (e.ctrlKey && e.key === 'c' && !getSelection().toString()) {
      const [x, z] = toWorld(...mouse); navigator.clipboard?.writeText(`${Math.round(x)}, ${Math.round(z)}`).catch(() => {});
    }
  });
}
