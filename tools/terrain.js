// Terrain from the unencrypted normal map (global_nohq.paa): slopes per cell, shaded relief, and a height
// grid integrated from the slopes and pinned to known ground heights (Central Economy building positions).

// DXT5nm normal map: X in alpha, Y in green. Returns slopes dh/dx (east) and dh/dz (north) per pixel,
// image rows from north. signX/signZ fix the encoding's handedness (chosen by fitting known heights).
function slopes(rgba, w, h, signX = 1, signZ = 1) {
  const gx = new Float32Array(w * h), gz = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const nx = rgba[p * 4 + 3] / 127.5 - 1, ny = rgba[p * 4 + 1] / 127.5 - 1;
    const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
    gx[p] = signX * -nx / nz; gz[p] = signZ * -ny / nz;
  }
  return { gx, gz };
}
// Averages slopes into an n x n grid.
function downsample(field, w, n) {
  const k = w / n, out = new Float32Array(n * n);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) out[((y / k) | 0) * n + ((x / k) | 0)] += field[y * w + x] / (k * k);
  return out;
}
// Least-squares heights on an n x n grid (rows from north, cell metres apart) whose differences match the
// slopes, plus weight * (h - a)^2 at anchor cells. Conjugate gradient on the normal equations, optionally
// warm-started from an initial guess (e.g. a coarser solution scaled up).
function integrate(gx, gz, n, cell, anchors = [], weight = 0, iterations = 600, init = null) {
  const N = n * n, b = new Float64Array(N), diag = new Float64Array(N);
  // East-west pairs: h[x+1] - h[x] = cell * gx; north-south: h[row-1] - h[row] = cell * gz (row 0 is north).
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const p = y * n + x;
    if (x + 1 < n) { const d = cell * (gx[p] + gx[p + 1]) / 2; b[p + 1] += d; b[p] -= d; diag[p]++; diag[p + 1]++; }
    if (y > 0) { const q = p - n, d = cell * (gz[p] + gz[q]) / 2; b[q] += d; b[p] -= d; diag[p]++; diag[q]++; }
  }
  const aw = new Float64Array(N);
  for (const [p, a] of anchors) { aw[p] += weight; b[p] += weight * a; }
  const eps = anchors.length ? 1e-9 : 1e-6;
  const mul = (v, out) => {
    for (let p = 0; p < N; p++) out[p] = (diag[p] + aw[p] + eps) * v[p];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const p = y * n + x;
      if (x + 1 < n) { out[p] -= v[p + 1]; out[p + 1] -= v[p]; }
      if (y > 0) { out[p] -= v[p - n]; out[p - n] -= v[p]; }
    }
  };
  const h = init ? Float64Array.from(init) : new Float64Array(N), r = Float64Array.from(b);
  if (init) { mul(h, r); for (let p = 0; p < N; p++) r[p] = b[p] - r[p]; }
  const d = Float64Array.from(r), q = new Float64Array(N);
  let rr = r.reduce((s, v) => s + v * v, 0);
  for (let it = 0; it < iterations && rr > 1e-12; it++) {
    mul(d, q);
    let dq = 0; for (let p = 0; p < N; p++) dq += d[p] * q[p];
    const alpha = rr / dq; let next = 0;
    for (let p = 0; p < N; p++) { h[p] += alpha * d[p]; r[p] -= alpha * q[p]; next += r[p] * r[p]; }
    const beta = next / rr; rr = next;
    for (let p = 0; p < N; p++) d[p] = r[p] + beta * d[p];
  }
  return h;
}
// Least-squares fit a = s * h + c over anchor cells; returns { s, c, rms }.
function fit(h, anchors) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [p, a] of anchors) { n++; sx += h[p]; sy += a; sxx += h[p] * h[p]; sxy += h[p] * a; }
  const s = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - s * sx) / n;
  let e = 0; for (const [p, a] of anchors) e += (s * h[p] + c - a) ** 2;
  return { s, c, rms: Math.sqrt(e / n) };
}
// Lambert shading from the normals, light from the north-west and above. 0 = darkest, 255 = brightest.
function shade(gx, gz, w, h) {
  const L = [-1, 1, 1.4], m = Math.hypot(...L), out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const nx = -gx[p], nz = -gz[p], len = Math.hypot(nx, nz, 1);
    out[p] = Math.max(0, Math.min(255, 255 * (nx * L[0] + nz * L[1] + L[2]) / (len * m)));
  }
  return out;
}
// Bilinear resample of an n x n grid to m x m (cell centres aligned).
function upsample(grid, n, m) {
  const out = new Float64Array(m * m), k = n / m;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const fx = Math.min(n - 1, Math.max(0, (x + 0.5) * k - 0.5)), fy = Math.min(n - 1, Math.max(0, (y + 0.5) * k - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    out[y * m + x] = (grid[y0 * n + x0] * (1 - tx) + grid[y0 * n + x1] * tx) * (1 - ty) + (grid[y1 * n + x0] * (1 - tx) + grid[y1 * n + x1] * tx) * ty;
  }
  return out;
}
// The game's normal map: rows stored from the south. Returns RGBA with rows from the north like every other layer.
function northUp(rgba, w) {
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < w; y++) rgba.copy(out, (w - 1 - y) * w * 4, y * w * 4, (y + 1) * w * 4);
  return out;
}
// Heights (metres, n x n, rows from north) from the normal map and ground anchors [x, height, z]:
// fits the slope scale, then solves coarse-to-fine with the anchors as soft constraints.
function buildHeights(normals, w, size, points, n = 512) {
  const { gx, gz } = slopes(northUp(normals, w), w, w, -1, 1);
  const cells = (pts, m) => pts.map(([x, y, z]) =>
    [Math.min(m - 1, Math.floor((size - z) / (size / m))) * m + Math.min(m - 1, Math.floor(x / (size / m))), y]);
  const solve = (m, anchors, weight, iterations, init) =>
    integrate(downsample(gx, w, m), downsample(gz, w, m), m, size / m, anchors, weight, iterations, init);
  // 1. Free integration at 128 x 128, then fit the slope scale and offset to the anchors.
  const coarse = 128, free = solve(coarse, [], 0, 3000);
  const { s, c, rms: freeRms } = fit(free, cells(points, coarse));
  for (let p = 0; p < gx.length; p++) { gx[p] *= s; gz[p] *= s; }
  // 2. Pin to anchors, refining 128 -> 256 -> n. Every tenth anchor is held back to measure the result.
  const train = points.filter((_, i) => i % 10), test = points.filter((_, i) => !(i % 10));
  let m = coarse, h = solve(m, cells(train, m), 0.2, 3000, free.map(v => s * v + c));
  while (m < n) { h = solve(m * 2, cells(train, m * 2), 0.2, 1200, upsample(h, m, m * 2)); m *= 2; }
  const testRms = Math.sqrt(cells(test, n).reduce((e, [p, a]) => e + (h[p] - a) ** 2, 0) / test.length);
  return { heights: h, n, scale: s, freeRms, testRms, shade: shade(gx, gz, w, w) };
}
module.exports = { slopes, downsample, integrate, fit, shade, upsample, northUp, buildHeights };
