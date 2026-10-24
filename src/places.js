// "Where am I": finds the spot a screenshot was taken from in the place index (npm run places:build), in the
// main process. A screenshot is cropped like the captured pictures (view()), turned into a descriptor by the
// index's ONNX model, and compared with every captured picture. Each captured point scores its best-matching
// heading; several screenshots from one spot (turning on the spot) add their scores, which narrows it down.
// The answer is the best point's neighbourhood, averaged by score so it can land between grid points.
const fs = require('node:fs');
const path = require('node:path');

// Scores within SHARPNESS of the best keep weight (softmax temperature over cosine similarities), and points
// within CLUSTER x grid spacing of the best count towards its answer. Tuned with npm run places:eval.
const SHARPNESS = 0.02, CLUSTER = 1.6, CANDIDATES = 300;

function loadIndex(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'index.bin'));
  const rows = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  if (rows.length !== meta.shots.length * meta.dim) throw new Error(`index.bin holds ${rows.length} values, index.json expects ${meta.shots.length * meta.dim}`);
  const n = meta.points.length, pointX = new Float32Array(n), pointZ = new Float32Array(n);
  meta.points.forEach(([x, z], i) => { pointX[i] = x; pointZ[i] = z; });
  return { ...meta, dir, rows, pointX, pointZ, spacing: gridSpacing(meta.points) };
}

// The typical distance between neighbouring points (the plan's spacing), from a sample of nearest neighbours.
function gridSpacing(points) {
  if (points.length < 2) return 100;
  const cell = new Map(), C = 50, key = (x, z) => `${Math.floor(x / C)},${Math.floor(z / C)}`;
  points.forEach(([x, z], i) => { const k = key(x, z); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); });
  const near = [];
  for (let i = 0; i < points.length; i += Math.max(1, Math.floor(points.length / 500))) {
    const [x, z] = points[i];
    let best = Infinity;
    for (let r = 1; r <= 6 && best === Infinity; r++)
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++)
        for (const j of cell.get(key(x + dx * C, z + dz * C)) || []) if (j !== i) best = Math.min(best, Math.hypot(points[j][0] - x, points[j][1] - z));
    if (best < Infinity) near.push(best);
  }
  near.sort((a, b) => a - b);
  return near[near.length >> 1] || 100;
}

// Per point: the best cosine similarity over its pictures, and that picture's heading.
function pointScores(index, query) {
  const { rows, dim, shots, scale } = index, n = index.points.length;
  const best = new Float32Array(n).fill(-2), heading = new Float32Array(n);
  for (let s = 0, o = 0; s < shots.length; s++, o += dim) {
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += rows[o + k] * query[k];
    dot /= scale;
    const p = shots[s][0];
    if (dot > best[p]) { best[p] = dot; heading[p] = shots[s][1]; }
  }
  return { best, heading };
}

// queries: descriptors (Float32Array, unit length) from one spot. skip(point index): leave a point out (used
// by the evaluation to hide the point a test picture came from). options: { sharpness, cluster } for tuning.
// Returns { x, z, radius, heading, confidence, candidates: [{ x, z, share }] } or null for an empty index.
function locate(index, queries, skip = () => false, { sharpness = SHARPNESS, cluster = CLUSTER } = {}) {
  const n = index.points.length;
  if (!n || !queries.length) return null;
  const total = new Float32Array(n), scored = queries.map(q => pointScores(index, q));
  for (const { best } of scored) for (let p = 0; p < n; p++) total[p] += best[p] / queries.length;
  // The CANDIDATES best points, best first.
  const top = [];
  for (let p = 0; p < n; p++) {
    if (skip(p)) continue;
    if (top.length < CANDIDATES) { top.push(p); if (top.length === CANDIDATES) top.sort((a, b) => total[b] - total[a]); continue; }
    if (total[p] <= total[top[CANDIDATES - 1]]) continue;
    let i = CANDIDATES - 1;
    while (i > 0 && total[top[i - 1]] < total[p]) { top[i] = top[i - 1]; i--; }
    top[i] = p;
  }
  if (top.length < CANDIDATES) top.sort((a, b) => total[b] - total[a]);
  if (!top.length) return null;
  const weight = p => Math.exp((total[p] - total[top[0]]) / sharpness);
  // Clusters: each candidate joins the first (higher scoring) cluster centre within reach, else starts one.
  const reach = cluster * index.spacing, clusters = [];
  let sum = 0;
  for (const p of top) {
    const w = weight(p), x = index.pointX[p], z = index.pointZ[p];
    sum += w;
    const c = clusters.find(c => Math.hypot(c.cx - x, c.cz - z) <= reach);
    if (c) { c.w += w; c.x += x * w; c.z += z * w; c.members.push(p); }
    else clusters.push({ cx: x, cz: z, w, x: x * w, z: z * w, members: [p] });
  }
  clusters.sort((a, b) => b.w - a.w);
  const answer = clusters[0], x = answer.x / answer.w, z = answer.z / answer.w;
  // Spread of the winning cluster around its centre, at least half the grid spacing.
  let spread = 0;
  for (const p of answer.members) spread += weight(p) * ((index.pointX[p] - x) ** 2 + (index.pointZ[p] - z) ** 2);
  const radius = Math.max(index.spacing / 2, Math.sqrt(spread / answer.w));
  // Facing: the first screenshot's best heading at the winning cluster's best point.
  const heading = scored[0].heading[answer.members[0]];
  return {
    x: Math.round(x), z: Math.round(z), radius: Math.round(radius), heading, confidence: answer.w / sum,
    candidates: clusters.slice(0, 5).map(c => ({ x: Math.round(c.x / c.w), z: Math.round(c.z / c.w), share: c.w / sum }))
  };
}

// Where in a screenshot of any size the model looks, matching tools/places.py's view(): centred to 16:9,
// the top `top` of that frame. The app crops and scales with Electron's nativeImage, then bgraToRgb.
function viewRegion(width, height, top) {
  const cropW = Math.min(width, Math.round(height * 16 / 9)), cropH = Math.min(height, Math.round(cropW * 9 / 16));
  const x = Math.floor((width - cropW) / 2), y = Math.floor((height - cropH) / 2);
  return { x, y, width: cropW, height: Math.round(cropH * top) };
}
function bgraToRgb(bgra) {
  const rgb = new Uint8Array(bgra.length / 4 * 3);
  for (let i = 0, o = 0; i < bgra.length; i += 4, o += 3) { rgb[o] = bgra[i + 2]; rgb[o + 1] = bgra[i + 1]; rgb[o + 2] = bgra[i]; }
  return rgb;
}

module.exports = { loadIndex, gridSpacing, pointScores, locate, viewRegion, bgraToRgb };
