// Picture capture for "where am I" place recognition: a camera walks a grid of points across a map in an
// offline DayZDiag game (tools/capture-mission) and a picture is taken per heading at each one.
//   npm run capture:plan -- <world> [--quick] [--spacing 25,50,100] [--area x0,z0,x1,z1] [--limit n] [--<setting> v]
//       writes @NasdaraCapture\NasdaraCapture.<world>\ (the mission plus plan.txt). Needs the world export.
//   npm run capture:run -- <world>
//       starts DayZDiag on it (profile C:\dzcapture) and saves the pictures into captures\<world>\img as JPEGs,
//       one line each in captures\<world>\shots.csv (tools/capture-shooter.html). A crashed or hung game is
//       restarted where it left off; the game quits when the plan is done.
// Plans add up: points already in captures\<world>\shots.csv are left out, so a 100 m pass followed by a
// 25/50/100 m pass only captures the new points. A stopped run carries on where it left off.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exportFiles, parseWorld, parseTable, parseTerrain, outlines, footprint, paintRects, roadRaster } = require('./worldexport');
const { parseExport } = require('./objects');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'C:\\dzcapture'; // short on purpose: DayZ hangs at start-up with a long profile path
const IMAGE_WIDTH = 640;         // saved JPEGs; place recognition models look at about 320 px
// Grid spacing (m) by kind of ground: within 50 m of a structure, within 20 m of a road, everywhere else.
// Each spacing is a multiple of the smallest, so coarse points are also points of every finer plan.
const SPACING = { town: 25, road: 50, wild: 100 };
const QUICK = { town: 100, road: 100, wild: 100 };
const TOWN_REACH = 50, ROAD_REACH = 20, CELL = 10;
// What the mission reads from plan.txt's header (see tools/capture-mission/init.c).
const SETTINGS = { headings: 6, fov: 0.96, pitch: 0, height: 1.7, first: 15000, settle: 600, turn: 120, hour: 12, overcast: 0.2, view: 3000, stay: 0 };

// Ground kind every CELL m (rows from the north, like paintRects): 0 open, 1 road, 2 town, -1 water.
function groundKinds(size, terrain, structures, roads, roadPx) {
  const n = Math.ceil(size / CELL), kinds = new Int8Array(n * n);
  const roadCell = size / roadPx, reach = Math.ceil(ROAD_REACH / roadCell);
  for (let ry = 0; ry < roadPx; ry++) for (let rx = 0; rx < roadPx; rx++) {
    if (!roads[ry * roadPx + rx]) continue;
    // Each road sample marks the cells within ROAD_REACH (a square: close enough for picking a spacing).
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const gx = Math.floor((rx + dx + 0.5) * roadCell / CELL), gy = Math.floor((ry + dy + 0.5) * roadCell / CELL);
      if (gx >= 0 && gy >= 0 && gx < n && gy < n) kinds[gy * n + gx] = 1;
    }
  }
  paintRects(kinds, n, size, structures, 2, TOWN_REACH);
  if (terrain) for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) {
    // Terrain rows run from the south.
    const tx = Math.floor((gx + 0.5) * CELL / terrain.step), tz = Math.floor((size - (gy + 0.5) * CELL) / terrain.step);
    if (tx < terrain.n && tz >= 0 && tz < terrain.n && terrain.w[tz * terrain.n + tx]) kinds[gy * n + gx] = -1;
  }
  return { n, at: (x, z) => kinds[Math.min(n - 1, Math.floor((size - z) / CELL)) * n + Math.min(n - 1, Math.floor(x / CELL))] };
}

// Footprints (buildings, walls, rocks) in 32 m buckets, to keep the camera out of them.
function obstacles(rects, pad = 2) {
  const B = 32, buckets = new Map();
  for (const r of rects) {
    const reach = Math.hypot(r[2], r[3]) + pad;
    for (let bx = Math.floor((r[0] - reach) / B); bx <= Math.floor((r[0] + reach) / B); bx++)
      for (let bz = Math.floor((r[1] - reach) / B); bz <= Math.floor((r[1] + reach) / B); bz++) {
        const key = bx * 65536 + bz;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      }
  }
  return (x, z) => (buckets.get(Math.floor(x / B) * 65536 + Math.floor(z / B)) || []).some(([cx, cz, hw, hd, yaw]) => {
    const dx = x - cx, dz = z - cz, c = Math.cos(yaw), s = Math.sin(yaw);
    return Math.abs(dx * c - dz * s) <= hw + pad && Math.abs(dx * s + dz * c) <= hd + pad;
  });
}
// The nearest free spot within 8 m (rings of 2 m, 8 directions), or null.
function freeSpot(x, z, blocked) {
  if (!blocked(x, z)) return [x, z];
  for (let r = 2; r <= 8; r += 2) for (let a = 0; a < 8; a++) {
    const px = x + r * Math.sin(a * Math.PI / 4), pz = z + r * Math.cos(a * Math.PI / 4);
    if (!blocked(px, pz)) return [Math.round(px * 10) / 10, Math.round(pz * 10) / 10];
  }
  return null;
}

// Grid points in walking order: rows from the south, alternating east and west, so each step is short.
// spacing: metres per ground kind; area: [x0, z0, x1, z1]; done(x, z): already captured.
function planPoints({ size, kindAt, blocked, spacing, area = [0, 0, size, size], done = () => false }) {
  const step = [spacing.town, spacing.road, spacing.wild].reduce(gcd);
  const bySpacing = [spacing.wild, spacing.road, spacing.town];
  const out = [];
  let row = 0;
  for (let z = Math.ceil(area[1] / step) * step || step; z <= Math.min(area[3], size - step); z += step) {
    const line = [];
    for (let x = Math.ceil(area[0] / step) * step || step; x <= Math.min(area[2], size - step); x += step) {
      const kind = kindAt(x, z);
      if (kind < 0 || x % bySpacing[kind] || z % bySpacing[kind]) continue;
      const spot = freeSpot(x, z, blocked);
      if (spot && !done(...spot)) line.push(spot);
    }
    out.push(...(row++ % 2 ? line.reverse() : line));
  }
  return out;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Captured points from a collected shots.csv: done(x, z) is true within 5 m of one.
function capturedPoints(csv) {
  const cells = new Set();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [, x, , z] = line.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(z)) cells.add(`${Math.round(x / 5)},${Math.round(z / 5)}`);
  }
  return (x, z) => {
    const cx = Math.round(x / 5), cz = Math.round(z / 5);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (cells.has(`${cx + dx},${cz + dz}`)) return true;
    return false;
  };
}

function planText(id, settings, points) {
  const head = [`# NasdaraCapture plan, ${points.length} points (npm run capture:plan)`, `plan ${id}`];
  for (const [key, value] of Object.entries(settings)) head.push(`${key} ${value}`);
  return [...head, 'points', ...points.map(([x, z]) => `${x} ${z}`)].join('\n') + '\n';
}

function findDayz() {
  const steam = 'C:\\Program Files (x86)\\Steam', libs = [steam];
  try {
    const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  const dir = libs.map(lib => path.join(lib, 'steamapps', 'common', 'DayZ')).find(d => fs.existsSync(path.join(d, 'DayZDiag_x64.exe')));
  if (!dir) throw new Error('DayZDiag_x64.exe not found in any Steam library (it comes with DayZ)');
  return dir;
}

// Command line: the world, then --flag value pairs (--quick takes none).
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) opts._.push(a);
    else if (a === '--quick') opts.quick = true;
    else opts[a.slice(2)] = argv[++i];
  }
  return opts;
}
const missionDir = world => path.join(ROOT, '@NasdaraCapture', `NasdaraCapture.${world}`);
const capturesDir = world => path.join(ROOT, 'captures', world);

function plan(world, opts) {
  const exported = exportFiles(ROOT, world);
  if (!exported) throw new Error(`no exports/${world}/${world}_objects.json: run the world export first (see README)`);
  const { size } = parseWorld(exported.text('world.json'));
  const objects = parseExport(exported.text('objects.json'));
  const terrain = exported.has('terrain.txt') ? parseTerrain(exported.text('terrain.txt')) : null;
  const surfaces = exported.has('surfaces.txt') ? parseTable(exported.text('surfaces.txt')) : [];
  const roadPx = 2048, roads = exported.has('roadway.txt') ? roadRaster(exported.text('roadway.txt'), surfaces, objects, size, roadPx) : new Uint8Array(roadPx * roadPx);
  const structures = outlines(objects);
  const rocks = objects.filter(o => o.k === 'r').map(footprint).filter(Boolean);
  const kinds = groundKinds(size, terrain, structures, roads, roadPx);
  const spacing = opts.spacing ? Object.fromEntries(['town', 'road', 'wild'].map((k, i) => [k, +opts.spacing.split(',')[i]])) : opts.quick ? QUICK : SPACING;
  const area = opts.area ? opts.area.split(',').map(Number) : undefined;
  const collected = path.join(capturesDir(world), 'shots.csv');
  const done = fs.existsSync(collected) ? capturedPoints(fs.readFileSync(collected, 'utf8')) : undefined;
  let points = planPoints({ size, kindAt: kinds.at, blocked: obstacles([...structures, ...rocks]), spacing, area, done });
  if (opts.limit) points = points.slice(0, +opts.limit);
  const settings = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, opts[k] ?? v]));
  const id = 'p' + new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const dir = missionDir(world);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'capture-mission', 'init.c'), path.join(dir, 'init.c'));
  fs.writeFileSync(path.join(dir, 'plan.txt'), planText(id, settings, points));
  const shots = points.length * settings.headings, hours = points.length * (settings.settle / 1000 + settings.headings * (settings.turn / 1000 + 0.1)) / 3600;
  console.log(`${world}: plan ${id}, spacing ${spacing.town}/${spacing.road}/${spacing.wild} m, ${points.length} points, ${shots} pictures`);
  console.log(`roughly ${hours.toFixed(1)} h at these settings (the run reports its real speed). Wrote ${dir}`);
}

// The DayZDiag window: its handle and game area (src/gamewindow.js).
const measureWindow = () => require('../src/gamewindow').measureWindow('DayZDiag_x64');
const isRunning = () => /DayZDiag_x64/i.test(require('node:child_process').spawnSync('tasklist', ['/FI', 'IMAGENAME eq DayZDiag_x64.exe'], { encoding: 'utf8' }).stdout);
const killGame = () => require('node:child_process').spawnSync('taskkill', ['/IM', 'DayZDiag_x64.exe', '/F']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HANG_MS = 5 * 60000;  // no picture for this long while the game runs: it has hung
const MAX_RESTARTS = 10;    // in a row without a single new picture: something is wrong beyond a crash

// How far the mission has got: { plan, total } from plan.txt, next point from the profile's progress file.
function planState(world) {
  const text = fs.readFileSync(path.join(missionDir(world), 'plan.txt'), 'utf8');
  const plan = (text.match(/^plan (\S+)/m) || [])[1], total = text.split('\npoints\n')[1].trim().split('\n').filter(Boolean).length;
  let next = 0;
  try {
    const [id, n] = fs.readFileSync(path.join(PROFILE, 'NasdaraCapture', `${world}_progress.txt`), 'utf8').trim().split(' ');
    if (id === plan) next = +n;
  } catch {}
  return { plan, total, next };
}

// Starts DayZDiag on the plan (or joins one already running) and takes the pictures. A crashed or hung game is
// restarted, carrying on from its last point, until the plan is done.
async function run(world) {
  const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
  await app.whenReady();
  app.on('window-all-closed', () => {}); // the picture window is replaced on each restart: keep running
  const dir = missionDir(world), dest = capturesDir(world);
  if (!fs.existsSync(path.join(dir, 'plan.txt'))) throw new Error(`no plan: run npm run capture:plan -- ${world} first`);
  fs.mkdirSync(path.join(dest, 'img'), { recursive: true });
  if (!fs.existsSync(path.join(dest, 'shots.csv'))) fs.writeFileSync(path.join(dest, 'shots.csv'), 'file,x,y,z,heading,pitch,fov\n');
  let saved = 0, last = '', lastSaved = Date.now(), blocked = false, shooter = null;
  ipcMain.on('ready', (_, size) => console.log(`Streaming the game window (${size}). Progress: [NasdaraCapture] lines in ${path.join(PROFILE, 'script_*.log')}`));
  ipcMain.on('failed', (_, why) => console.error(why));
  ipcMain.on('saved', (_, file) => { saved++; last = file; lastSaved = Date.now(); blocked = false; });
  ipcMain.on('blocked', () => {
    if (!blocked) console.log('The game window shows black: is it minimised, or the screen locked or asleep? Waiting for it to come back.');
    blocked = true;
  });
  const started = Date.now();
  for (let restarts = 0, before = -1; ; restarts++) {
    const state = planState(world);
    if (state.next >= state.total) {
      console.log(`Plan ${state.plan} complete: ${state.total} points. ${saved} pictures this run, in ${dest}`);
      break;
    }
    if (saved === before && restarts > MAX_RESTARTS) throw new Error(`the game stopped ${MAX_RESTARTS} times in a row without a picture: see ${path.join(PROFILE, 'script_*.log')}`);
    if (saved > before) restarts = 0;
    before = saved;
    if (isRunning()) console.log('DayZDiag is already running: taking its pictures');
    else {
      const exe = path.join(findDayz(), 'DayZDiag_x64.exe');
      spawn(exe, [`-mission=${dir}`, `-profiles=${PROFILE}`, '-window', '-nosplash', '-noPause', '-noBenchmark', '-doLogs'], { cwd: path.dirname(exe), stdio: 'ignore' });
      console.log(`Started DayZDiag at point ${state.next} of ${state.total}. Leave its window open (other windows may cover it, but do not minimise it).`);
    }
    // The game shows a short-lived start-up window first: wait until its main window is one we can stream.
    let window = null, source = null;
    for (let tries = 0; !source && isRunning() && tries < 180; tries++) {
      if (tries) await sleep(1000);
      window = measureWindow();
      if (!window) continue;
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      source = sources.find(s => s.id.split(':')[1] === String(window.hwnd));
    }
    if (!source) {
      console.log('The game exited or never opened its window: restarting it');
      killGame();
      await sleep(5000);
      continue;
    }
    shooter = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    shooter.loadFile(path.join(__dirname, 'capture-shooter.html'), { query: {
      source: source.id, shot: path.join(PROFILE, 'NasdaraCapture', 'shot.txt'), dest, width: String(IMAGE_WIDTH), crop: window.crop.join(',') } });
    lastSaved = Date.now();
    // Every 30 s: a progress line, a fresh measure of the game area (the window may have been resized), and
    // checks that the game is still running and still asking for pictures.
    for (;;) {
      await sleep(30000);
      if (!isRunning()) {
        if (planState(world).next < state.total) console.log('DayZDiag closed before the plan was done: restarting it');
        break;
      }
      if (Date.now() - lastSaved > HANG_MS && !blocked) {
        console.log(`No picture for ${HANG_MS / 60000} minutes: the game has hung, restarting it`);
        killGame();
        break;
      }
      const now = measureWindow();
      if (now) shooter.webContents.send('crop', now.crop);
      const minutes = (Date.now() - started) / 60000;
      if (saved) console.log(`${saved} pictures (${(saved / minutes).toFixed(0)} a minute), last ${last}`);
    }
    shooter.destroy();
    await sleep(5000);
  }
  app.exit(0);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest), world = opts._[0];
  if (!world) throw new Error('name the world: nasdara, chernarusplus or sakhal');
  if (command === 'plan') plan(world, opts);
  else if (command === 'run') await run(world);
  else throw new Error('commands: plan, run');
}
// Electron loads the script through its own entry point, so require.main is not this module there.
if (require.main === module || process.versions.electron) main().catch(error => {
  console.error(error.stack || error.message);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exit(1);
});
module.exports = { groundKinds, obstacles, freeSpot, planPoints, capturedPoints, planText, planState };
