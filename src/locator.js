// The app side of "where am I" (main process): loads a map's place index and model (src/map/<map>/places,
// npm run places:build), grabs the game window or takes a pasted image, and answers with src/places.js.
// A request with add: true joins the previous screenshots (taken turning on the same spot), for up to VIEW_MS.
const path = require('node:path');
const fs = require('node:fs');
const { desktopCapturer, nativeImage } = require('electron');
const { loadIndex, locate, viewRegion, bgraToRgb } = require('./places');
const { measureWindow } = require('./gamewindow');

const VIEW_MS = 120000;
const GAMES = ['DayZ_x64', 'DayZDiag_x64'];
const loaded = new Map(); // map id -> Promise<{ index, session }>
let views = { map: null, queries: [], at: 0 };

const placesDir = map => path.join(__dirname, 'map', map, 'places');
const valid = map => typeof map === 'string' && /^[a-z0-9_]+$/.test(map);
const available = map => valid(map) && fs.existsSync(path.join(placesDir(map), 'index.json'));

function load(map) {
  if (!loaded.has(map)) loaded.set(map, (async () => {
    const ort = require('onnxruntime-node');
    const index = loadIndex(placesDir(map));
    // Read through Electron's fs: onnxruntime opens paths natively and cannot see inside app.asar.
    const model = fs.readFileSync(path.join(placesDir(map), 'model.onnx'));
    // DirectML runs the model on the graphics card; the CPU is the fallback.
    let session;
    try { session = await ort.InferenceSession.create(model, { executionProviders: ['dml'] }); }
    catch { session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] }); }
    return { index, session, ort };
  })().catch(error => { loaded.delete(map); throw error; }));
  return loaded.get(map);
}

// An image (nativeImage) as one descriptor.
async function describe({ index, session, ort }, image) {
  const { width, height } = image.getSize();
  const [w, h, top] = index.view;
  const region = viewRegion(width, height, top);
  const pixels = image.crop(region).resize({ width: w, height: h, quality: 'good' }).toBitmap();
  const input = new ort.Tensor('uint8', bgraToRgb(pixels), [1, h, w, 3]);
  const output = await session.run({ view: input });
  return Float32Array.from(output.descriptor.data);
}

// Mostly black: a minimised window, or a fullscreen game the capture cannot see.
function isBlack(image) {
  const pixels = image.resize({ width: 64 }).toBitmap();
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
  return sum / (pixels.length / 4 * 3) < 6;
}

// The game's picture: its window's game area, else the screen it fills (borderless or fullscreen).
async function grabGame() {
  const game = GAMES.map(measureWindow).find(Boolean);
  if (!game) throw new Error('DayZ is not running. You can also paste a screenshot (Ctrl+V) or drop one on the map.');
  if (game.minimized) throw new Error('DayZ is minimised: bring it back, then try again.');
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 2560, height: 1440 } });
  const window = sources.find(s => s.id.split(':')[1] === String(game.hwnd));
  if (window && !window.thumbnail.isEmpty()) {
    const { width, height } = window.thumbnail.getSize(), [x, y, w, h] = game.crop;
    const image = window.thumbnail.crop({ x: Math.round(x * width), y: Math.round(y * height), width: Math.round(w * width), height: Math.round(h * height) });
    if (!isBlack(image)) return image;
  }
  const screen = sources.find(s => s.id.startsWith('screen:') && !s.thumbnail.isEmpty() && !isBlack(s.thumbnail));
  if (screen) return screen.thumbnail;
  throw new Error("Can't see the game picture (exclusive fullscreen?). Use borderless or windowed mode, or paste a screenshot (Ctrl+V).");
}

// request: { map, image?: PNG/JPEG bytes (a pasted or dropped screenshot), add?: same spot as the last one }.
// Without an image the game window is captured. Returns the answer plus how many views it combines.
async function locateRequest(request) {
  const map = request?.map;
  if (!available(map)) throw new Error('No place index for this map yet: capture pictures, then npm run places:build.');
  const model = await load(map);
  let image;
  if (request.image) {
    image = nativeImage.createFromBuffer(Buffer.from(request.image));
    if (image.isEmpty()) throw new Error('That file is not an image Mapino can read (PNG or JPEG).');
  } else image = await grabGame();
  const query = await describe(model, image);
  const now = Date.now();
  if (!request.add || views.map !== map || now - views.at > VIEW_MS) views = { map, queries: [], at: now };
  views.queries.push(query);
  views.at = now;
  const answer = locate(model.index, views.queries);
  return { ...answer, views: views.queries.length, spacing: Math.round(model.index.spacing) };
}

module.exports = { available, locateRequest };
