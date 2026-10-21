// Finds the paper map's contour lines: thin strokes darker and greyer than the parchment around them
// (roads are more saturated, labels are already removed). Returns a 0-255 strength per pixel.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w) { s += src[y * w + x + r]; n++; }
      if (x - r - 1 >= 0) { s -= src[y * w + x - r - 1]; n--; }
      if (x >= 0) tmp[y * w + x] = s / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) { s += tmp[(y + r) * w + x]; n++; }
      if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; n--; }
      if (y >= 0) out[y * w + x] = s / n;
    }
  }
  return out;
}
function contourStrength(rgba, w, h) {
  const L = new Float32Array(w * h), S = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    L[p] = 0.299 * r + 0.587 * g + 0.114 * b; S[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const bL = boxBlur(L, w, h, 4), bS = boxBlur(S, w, h, 4), out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const d = bL[p] - L[p];
    if (d > 10 && S[p] < bS[p] - 4) out[p] = Math.min(255, (d - 6) * 14);
  }
  // Grid lines: rows/columns mostly covered by such strokes. Clear them (and their anti-aliased neighbours).
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[y * w + x]) { rows[y]++; cols[x]++; }
  for (let y = 0; y < h; y++) if (rows[y] > w * 0.35) for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < h) out.fill(0, (y + d) * w, (y + d + 1) * w);
  for (let x = 0; x < w; x++) if (cols[x] > h * 0.35) for (let d = -1; d <= 1; d++) if (x + d >= 0 && x + d < w) for (let y = 0; y < h; y++) out[y * w + x + d] = 0;
  // Drop specks from parchment texture.
  removeSmall(out, w, h, 12);
  return out;
}
// Clears 8-connected fragments of a mask smaller than minSize pixels, in place.
function removeSmall(mask, w, h, minSize) {
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const stack = [s], part = []; seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); part.push(p);
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, q = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (part.length < minSize) for (const p of part) mask[p] = 0;
  }
}
module.exports = { contourStrength };
// Square min/max filter (separable): erode with op=Math.min on a 0/1 mask, dilate with Math.max.
function squareFilter(mask, w, h, r, erode) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), pass = (src, dst, stride, count, len) => {
    for (let line = 0; line < count; line++) {
      const base = (stride === 1 ? line * w : line);
      for (let i = 0; i < len; i++) {
        let v = erode ? 1 : 0;
        for (let d = -r; d <= r; d++) {
          const j = i + d, s = j < 0 || j >= len ? 0 : src[base + j * stride];
          if (erode ? !s : s) { v = erode ? 0 : 1; break; }
        }
        dst[base + i * stride] = v;
      }
    }
  };
  pass(mask, tmp, 1, h, w); pass(tmp, out, w, w, h);
  return out;
}
// The widest printed roads (highway, boulevards, main streets): road-coloured strokes that survive a
// 5 px opening. Thin tracks and ordinary roads are drawn alike on this map, so they are not split further.
function mainRoads(rgba, w, h) {
  // The darkened paper edge also looks road-coloured; skip a margin around the map.
  const road = new Uint8Array(w * h), margin = Math.round(w / 17);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], sat = Math.max(r, g, b) - Math.min(r, g, b), x = p % w, y = (p / w) | 0;
    road[p] = x >= margin && y >= margin && x < w - margin && y < h - margin && sat >= 62 && 0.299 * r + 0.587 * g + 0.114 * b < 165 && r > b ? 1 : 0;
  }
  const opened = squareFilter(squareFilter(road, w, h, 2, true), w, h, 3, false);
  for (let p = 0; p < w * h; p++) opened[p] &= road[p];
  // Reddish rock shading also passes the colour test; real road pieces are long, connected strokes.
  removeSmall(opened, w, h, 300);
  return squareFilter(opened, w, h, 1, false);
}
module.exports.mainRoads = mainRoads;
