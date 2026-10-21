// Offline Nasdara map: paper-map tiles plus Central Economy overlays on one canvas, redrawn only on change.
const $ = id => document.getElementById(id);
const data = window.MAP_DATA;
const { lootBuildings, typeBuildings, search, pretty } = window.MapLoot;
const LAYERS = [
  ['Buildings', [['military', 'Military', '#d8352a', true], ['police', 'Police / prison', '#2f6fe0', true],
    ['medical', 'Medical', '#f2f2f2', true], ['fire', 'Fire station', '#ff7b1c', true], ['hunting', 'Hunting', '#7a9a3a', false],
    ['industrial', 'Industrial / farm', '#9a7b4f', false], ['civilian', 'Civilian', '#6d5a45', false], ['wreck', 'Wrecks', '#555', false]]],
  ['Events', [['vehicle', 'Vehicles', '#19a974', true], ['heli', 'Heli crashes', '#ff4136', true], ['convoy', 'Military convoys', '#b10dc9', true],
    ['policecar', 'Police cars', '#0074d9', false], ['container', 'Locked containers', '#ffdc00', false], ['watertruck', 'Water trucks', '#7fdbff', false]]],
  ['Map', [['relief', 'Shaded relief', '#5a4632', true], ['topo', 'Topography', '#46321e', true], ['mainroads', 'Main roads', '#d64014', true],
    ['power', 'Powerlines', '#ffd84a', true], ['signs', 'Road signs', '#f2f2f2', false]]],
  ['Areas', [['zones', 'Toxic zones', '#c5e000', true], ['infected', 'Infected zones', '#8a8a8a', false],
    ['underground', 'Bunkers & tunnels', '#00d0d0', true], ['game', 'Game animals', '#b5651d', false], ['dogs', 'Dogs', '#5c3a1e', false],
    ['critters', 'Small animals', '#e0c068', false], ['spawns', 'Player spawns', '#ffffff', false], ['tiers', 'Loot tiers', '#eb8714', false]]]
];
// Infected zone colour by type; animal species by layer.
const INFECTED_COLORS = [[/Army|NBC/, '#d8352a'], [/Police/, '#2f6fe0'], [/Medic/, '#f2f2f2'], [/Fire/, '#ff7b1c'], [/Industrial/, '#9a7b4f'], [/./, '#8a8a8a']];
const ANIMAL_LAYER = { mouflon: 'game', wild_boar: 'game', sheep: 'game', goat: 'game', cattle: 'game', dobermann_shepherd: 'dogs' };
const animalLayer = species => ANIMAL_LAYER[species] || 'critters';
const words = name => name.replace(/^Infec?t?e?d/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
// Base map under everything: the in-game paper map, the satellite image, or plain white.
const BASES = [['paper', 'Paper map'], ['satellite', 'Satellite'], ['white', 'White']];
const baseKind = () => (base === 'satellite' ? 'sat' : 'tiles');
const COLORS = Object.fromEntries(LAYERS.flatMap(([, l]) => l.map(([id, , color]) => [id, color])));
const S = data?.stride;
const canvas = $('map'), ctx = canvas.getContext('2d');
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let W = 0, H = 0, dpr = 1, view, layers, selection = null, hover = null, pending = false;
const tiles = new Map(); // key -> Image, insertion order doubles as LRU
let tierImage = null, labelImage = null, reliefImage = null, heightGrid = null, in3d = false, base = 'paper';

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
function saveView() { store.set('nasdara-view', view); }

function tile(kind, level, tx, ty) {
  const key = `${kind}/${level}/${tx}_${ty}`;
  let img = tiles.get(key);
  if (img) { tiles.delete(key); tiles.set(key, img); return img.complete && img.naturalWidth ? img : null; }
  img = new Image(); img.onload = redraw; img.src = `nasdara/${key}.${kind === 'tiles' || kind === 'sat' ? 'jpg' : 'png'}`;
  tiles.set(key, img);
  // About two screens of 512 px tiles; older ones are dropped so deep zooming stays light on memory.
  if (tiles.size > 64) tiles.delete(tiles.keys().next().value);
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
function draw() {
  pending = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2); ctx.rotate(view.r); ctx.translate(-W / 2, -H / 2);
  // Pick the smallest tile level that is sharp at this zoom; level 0 underneath while it loads.
  const level = levelFor(baseKind()), overlay = levelFor('contours');
  if (base === 'white') {
    const [sx, sy] = toScreen(0, data.size); ctx.fillStyle = '#fff'; ctx.fillRect(sx, sy, data.size * view.s, data.size * view.s);
  } else {
    if (level > 0) drawLevel(0, false, baseKind());
    drawLevel(level, true, baseKind());
  }
  if (layers.relief && reliefImage?.complete) { const [sx, sy] = toScreen(0, data.size); ctx.drawImage(reliefImage, sx, sy, data.size * view.s, data.size * view.s); }
  if (layers.topo) drawLevel(overlay, false, 'contours');
  // The bold road trace is 4 m/px; past 2 m/px it only smudges over the real road, so it fades out.
  if (layers.mainroads && view.s < 0.5) {
    ctx.globalAlpha = Math.min(1, (0.5 - view.s) / 0.25); drawLevel(overlay, false, 'roads'); ctx.globalAlpha = 1;
  }
  if (layers.tiers && tierImage?.complete) {
    const [sx, sy] = toScreen(0, data.size);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(tierImage, sx, sy, data.size * view.s, data.size * view.s); ctx.imageSmoothingEnabled = true;
  }
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
    if (layers[layer]) dot(b[i + 1], b[i + 2], r * 0.8, COLORS[layer]);
  }
  for (const [layer, points] of Object.entries(data.events)) if (layers[layer]) for (const [x, z] of points) diamond(x, z, r + 1, COLORS[layer]);
  if (layers.spawns) for (const [x, z] of data.spawns) ring(x, z, 6, '#ffffff');
  if (layers.underground) for (const [x, z] of data.underground) hatch(x, z, r + 2);
  if (layers.power && data.power) drawPower();
  if (layers.signs && data.signs) for (const [x, z] of data.signs) dot(x, z, Math.max(2.5, r * 0.6), '#f2f2f2');
  ctx.globalAlpha = 1;
  if (selection) for (const i of selection.buildings) { ring(b[i * S + 1], b[i * S + 2], r + 3, '#ffcf3f'); dot(b[i * S + 1], b[i * S + 2], r * 0.8, '#ffcf3f'); }
  if (hover) ring(hover.x, hover.z, r + 5, '#fff');
  drawLabels();
}
// Place names lifted off the paper map, drawn upright at their map position whatever the rotation.
function drawLabels() {
  if (!labelImage?.complete || !data.labels) return;
  const k = Math.min(1.5, view.s * data.labelScale), c = Math.cos(view.r), s = Math.sin(view.r);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Black names need a light halo to read on the dark satellite image.
  if (base === 'satellite') { ctx.shadowColor = '#fff'; ctx.shadowBlur = 4; }
  for (const [x, z, ax, ay, w, h] of data.labels) {
    if (h * k < 3) continue;
    const [fx, fy] = toScreen(x, z), dx = fx - W / 2, dy = fy - H / 2;
    const sx = W / 2 + dx * c - dy * s, sy = H / 2 + dx * s + dy * c;
    if (sx < -w * k || sy < -h * k || sx > W + w * k || sy > H + h * k) continue;
    ctx.drawImage(labelImage, ax, ay, w, h, sx - w * k / 2, sy - h * k / 2, w * k, h * k);
  }
  ctx.shadowBlur = 0;
}
// Map-frame points within the rotated viewport's bounding circle.
function onScreen(sx, sy) { const d = Math.hypot(W, H) / 2 + 20; return Math.abs(sx - W / 2) < d && Math.abs(sy - H / 2) < d; }
// Powerlines from the export mod: dark-cased yellow lines (HV wider), poles as dots when zoomed in.
function drawPower() {
  for (const [width, color] of [[4.5, '#000'], [2.2, '#ffd84a']]) {
    ctx.strokeStyle = color; ctx.lineCap = 'round';
    for (const family of ['pole', 'hv']) {
      ctx.lineWidth = family === 'hv' ? width + 1 : width - 1; ctx.beginPath();
      for (const [x1, z1, x2, z2, f] of data.power.segments) {
        if (f !== family) continue;
        const [ax, ay] = toScreen(x1, z1), [bx, by] = toScreen(x2, z2);
        if (!onScreen(ax, ay) && !onScreen(bx, by)) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
  }
  if (view.s > 0.5) for (const [x, z] of data.power.poles) dot(x, z, 2, '#ffd84a');
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
  ctx.fillStyle = color; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.25; ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
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
function pick(mx, my) {
  const [sx, sy] = unrotate(mx, my);
  let best = null, bestD = 10 * 10;
  const consider = (x, z, label, sub) => {
    const [px, py] = toScreen(x, z), d = (px - sx) ** 2 + (py - sy) ** 2;
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
  if (layers.infected) for (const [x, z, radius, type] of data.infected) consider(x, z, `Infected: ${words(data.zoneTypes[type]) || 'zone'}`, `radius ${radius} m`);
  for (const [x, z, radius, species, kind] of data.animals) if (layers[animalLayer(species)])
    consider(x, z, words(species).replace(/^w/, c => c.toUpperCase()), `${words(kind).replace(/^Zones*/, '') || 'Territory'} · radius ${radius} m`);
  return best;
}
function tierText(t) { const s = [1, 2, 4, 8].filter(v => t & v).map(v => `T${Math.log2(v) + 1}`); return s.length ? s.join('/') : ''; }

function select(hit) {
  if (!hit) { selection = null; $('selection').hidden = true; redraw(); if (in3d) window.Map3D.selectionChanged(); return; }
  const buildings = hit.kind === 'item' ? lootBuildings(data, data.items[hit.index]) : typeBuildings(data, hit.index);
  selection = { ...hit, buildings };
  $('selectionText').textContent = `${hit.label}: ${buildings.length} building${buildings.length === 1 ? '' : 's'}`;
  $('selection').hidden = false; $('results').hidden = true; $('query').blur();
  redraw(); if (in3d) window.Map3D.selectionChanged();
}
let results = [], active = 0;
function showResults() {
  results = search(data, $('query').value); active = 0;
  const list = $('results'); list.replaceChildren();
  for (const [i, hit] of results.entries()) {
    const li = document.createElement('li'); li.className = i === active ? 'active' : '';
    const name = document.createElement('span'); name.textContent = hit.label;
    const kind = document.createElement('small'); kind.textContent = hit.kind === 'item' ? data.items[hit.index].category || 'loot' : 'building';
    li.append(name, kind); li.addEventListener('mousedown', e => { e.preventDefault(); select(hit); });
    list.append(li);
  }
  list.hidden = !results.length;
}

function buildLayerList() {
  const list = $('layerList');
  const heading = document.createElement('h3'); heading.textContent = 'BASE MAP'; list.append(heading);
  for (const [id, label] of BASES) {
    const row = document.createElement('label'), radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'base'; radio.checked = base === id;
    radio.addEventListener('change', () => { base = id; store.set('nasdara-base', base); redraw(); if (in3d) window.Map3D.layersChanged('base'); });
    row.append(radio, label); list.append(row);
  }
  for (const [group, items] of LAYERS) {
    const h = document.createElement('h3'); h.textContent = group.toUpperCase(); list.append(h);
    for (const [id, label, color] of items) {
      if ((id === 'power' && !data.power) || (id === 'signs' && !data.signs)) continue; // only after an object export
      const row = document.createElement('label'), box = document.createElement('input'), swatch = document.createElement('i');
      box.type = 'checkbox'; box.checked = !!layers[id]; swatch.style.background = color;
      box.addEventListener('change', () => { layers[id] = box.checked; store.set('nasdara-layers', layers); redraw(); if (in3d) window.Map3D.layersChanged(id); });
      row.append(box, swatch, label); list.append(row);
    }
  }
  const setOpen = open => {
    $('layers').classList.toggle('closed', !open); $('layersToggle').setAttribute('aria-expanded', String(open));
  };
  setOpen(store.get('nasdara-layers-open') === true);
  $('layersToggle').addEventListener('click', () => {
    const open = $('layers').classList.contains('closed'); setOpen(open); store.set('nasdara-layers-open', open);
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
  img.src = 'nasdara/heights.png';
}
// The 3D view and three.js load on first use only.
function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src)); document.body.append(s);
  });
}
async function toggle3d() {
  const button = $('toggle3d');
  if (in3d) {
    const at = window.Map3D.close(); in3d = false;
    view.x = at.x; view.z = at.z; clampView(); setRotation(at.r);
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
if (!data) $('missing').hidden = false;
else {
  view = { x: data.size / 2, z: data.size / 2, s: 0, r: 0, ...store.get('nasdara-view') };
  base = BASES.some(([id]) => id === store.get('nasdara-base')) ? store.get('nasdara-base') : 'paper';
  layers = store.get('nasdara-layers') || Object.fromEntries(LAYERS.flatMap(([, l]) => l.map(([id, , , on]) => [id, on])));
  tierImage = new Image(); tierImage.onload = redraw; tierImage.src = 'nasdara/tiers.png';
  labelImage = new Image(); labelImage.onload = redraw; labelImage.src = 'nasdara/labels.png';
  reliefImage = new Image(); reliefImage.onload = redraw; reliefImage.src = 'nasdara/relief.png';
  loadHeights();
  $('toggle3d').addEventListener('click', toggle3d);
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
  canvas.addEventListener('dblclick', e => zoomAt(e.clientX, e.clientY, e.shiftKey ? 0.5 : 2));
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
  addEventListener('keydown', e => {
    if (e.target === $('query')) return;
    if (e.key === 'Escape') select(null);
    else if (e.key === '/' || (e.shiftKey && e.key === 'Q')) { e.preventDefault(); $('query').focus(); }
    else if (e.ctrlKey && e.key === 'c' && !getSelection().toString()) {
      const [x, z] = toWorld(...mouse); navigator.clipboard?.writeText(`${Math.round(x)}, ${Math.round(z)}`).catch(() => {});
    }
  });
}
