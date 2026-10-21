// Separates the printed labels (black names, blue water names, grid numbers, icons) from the paper map so the
// viewer can draw them upright when the map is rotated. Works on RGBA buffers; no text recognition is involved.
const lum = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
function isInk(px, i) {
  const r = px[i], g = px[i + 1], b = px[i + 2], mx = Math.max(r, g, b);
  return (mx < 95 && mx - Math.min(r, g, b) < 40) || (b > r + 15 && b >= g && mx < 175);
}
function dilate(mask, w, h, radius) {
  let cur = mask;
  for (let n = 0; n < radius; n++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!cur[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) next[ny * w + nx] = 1;
      }
    }
    cur = next;
  }
  return cur;
}
// Fills masked pixels from the outside in with the average of known neighbours.
function inpaint(px, mask, w, h) {
  const known = Uint8Array.from(mask, m => (m ? 0 : 1));
  let front = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) front.push(i);
  while (front.length) {
    const ready = [], rest = [];
    for (const p of front) {
      const x = p % w, y = (p / w) | 0; let n = 0, r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, q = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !known[q]) continue;
        r += px[q * 4]; g += px[q * 4 + 1]; b += px[q * 4 + 2]; n++;
      }
      if (n) ready.push([p, r / n, g / n, b / n]); else rest.push(p);
    }
    if (!ready.length) break;
    for (const [p, r, g, b] of ready) { px[p * 4] = r; px[p * 4 + 1] = g; px[p * 4 + 2] = b; known[p] = 1; }
    front = rest;
  }
}
// Connected components (8-way) of the core ink mask, merged into same-line words and phrases.
function findLabels(core, w, h) {
  const comp = new Int32Array(w * h).fill(-1), boxes = [];
  for (let s = 0; s < core.length; s++) {
    if (!core[s] || comp[s] >= 0) continue;
    const box = { x0: w, y0: h, x1: 0, y1: 0, n: 0 }, stack = [s]; comp[s] = boxes.length;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y); box.n++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, q = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && core[q] && comp[q] < 0) { comp[q] = boxes.length; stack.push(q); }
      }
    }
    boxes.push(box);
  }
  const parent = boxes.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = 48, grid = new Map();
  boxes.forEach((b, i) => {
    for (let gy = Math.floor(b.y0 / cell); gy <= Math.floor(b.y1 / cell); gy++)
      for (let gx = Math.floor(b.x0 / cell); gx <= Math.floor(b.x1 / cell); gx++) {
        const key = gy * 1000 + gx; (grid.get(key) || grid.set(key, []).get(key)).push(i);
      }
  });
  boxes.forEach((a, i) => {
    const ha = a.y1 - a.y0 + 1, reach = Math.ceil(ha * 0.9);
    for (let gy = Math.floor((a.y0 - 2) / cell); gy <= Math.floor((a.y1 + 2) / cell); gy++)
      for (let gx = Math.floor((a.x0 - reach) / cell); gx <= Math.floor((a.x1 + reach) / cell); gx++)
        for (const j of grid.get(gy * 1000 + gx) || []) {
          if (j <= i) continue;
          const b = boxes[j], hb = b.y1 - b.y0 + 1;
          const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
          const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) - 1;
          // Same text line: vertical overlap, similar-ish height, letter/word spacing apart.
          if (overlap >= Math.min(ha, hb) * 0.5 && gap <= Math.max(ha, hb) * 0.9 && Math.max(ha, hb) <= 3 * Math.min(ha, hb) + 4)
            parent[find(j)] = find(i);
        }
  });
  const labels = new Map();
  boxes.forEach((b, i) => {
    const r = find(i), l = labels.get(r) || { root: r, x0: w, y0: h, x1: 0, y1: 0, n: 0, parts: 0 };
    l.x0 = Math.min(l.x0, b.x0); l.y0 = Math.min(l.y0, b.y0); l.x1 = Math.max(l.x1, b.x1); l.y1 = Math.max(l.y1, b.y1); l.n += b.n; l.parts++;
    labels.set(r, l);
  });
  // Attach small marks (i-dots, hyphens, accents) to the multi-glyph label whose line they sit on.
  boxes.forEach((b, i) => {
    if (b.n >= 20 || labels.get(find(i)).parts > 1) return;
    for (const j of grid.get(Math.floor(b.y0 / cell) * 1000 + Math.floor(b.x0 / cell)) || []) {
      const l = labels.get(find(j));
      if (l === labels.get(find(i)) || l.parts < 2) continue;
      const lh = l.y1 - l.y0 + 1, slack = Math.ceil(lh * 0.6);
      if (b.x0 >= l.x0 - 2 && b.x1 <= l.x1 + 2 && b.y0 >= l.y0 - slack && b.y1 <= l.y1 + 2) {
        labels.delete(find(i)); parent[i] = l.root;
        l.x0 = Math.min(l.x0, b.x0); l.y0 = Math.min(l.y0, b.y0); l.x1 = Math.max(l.x1, b.x1); l.y1 = Math.max(l.y1, b.y1);
        l.n += b.n; l.parts++;
        break;
      }
    }
  });
  // Text only: several glyphs on one line, text-sized, ink density of lettering, away from the darkened map edge.
  // Single symbols, line fragments, dashes and the scale bar stay painted on the map (they rotate with it).
  const text = [...labels.values()].filter(l => {
    const lw = l.x1 - l.x0 + 1, lh = l.y1 - l.y0 + 1, fill = l.n / (lw * lh), edge = 24;
    return l.parts >= 2 && lh >= 6 && lh <= 40 && lw >= lh * 0.9 && lw < 500 && fill >= 0.15 && fill <= 0.6 &&
      l.x0 > edge && l.y0 > edge && l.x1 < w - edge && l.y1 < h - edge;
  });
  // owner[p]: index of the label whose glyph covers pixel p, or -1 (e.g. a grid line crossing a label).
  const index = new Map(text.map((l, i) => [l.root, i])), owner = new Int32Array(w * h).fill(-1);
  for (let p = 0; p < comp.length; p++) if (comp[p] >= 0) owner[p] = index.get(find(comp[p])) ?? -1;
  return { labels: text, owner };
}
// Returns the cleaned map (labels painted out) and each label as an RGBA sprite in map pixels.
function extractLabels(rgba, w, h, pad = 2) {
  const core = new Uint8Array(w * h);
  for (let p = 0; p < core.length; p++) core[p] = isInk(rgba, p * 4) ? 1 : 0;
  const { labels, owner } = findLabels(core, w, h);
  const area = dilate(Uint8Array.from(owner, o => (o >= 0 ? 1 : 0)), w, h, pad);
  const clean = Buffer.from(rgba);
  inpaint(clean, area, w, h);
  const sprites = labels.map((l, index) => {
    const x0 = Math.max(0, l.x0 - pad), y0 = Math.max(0, l.y0 - pad), x1 = Math.min(w - 1, l.x1 + pad), y1 = Math.min(h - 1, l.y1 + pad);
    const sw = x1 - x0 + 1, sh = y1 - y0 + 1, out = Buffer.alloc(sw * sh * 4);
    // Only this label's own glyphs (plus anti-aliased edges), not other ink inside its box.
    const own = new Uint8Array(sw * sh);
    let ink = 255;
    for (let y = l.y0; y <= l.y1; y++) for (let x = l.x0; x <= l.x1; x++) {
      if (owner[y * w + x] !== index) continue;
      own[(y - y0) * sw + (x - x0)] = 1; ink = Math.min(ink, lum(rgba, (y * w + x) * 4));
    }
    const near = dilate(own, sw, sh, pad);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const p = y * w + x; if (!near[(y - y0) * sw + (x - x0)]) continue;
      const i = p * 4, bg = lum(clean, i), a = Math.max(0, Math.min(1, (bg - lum(rgba, i)) / Math.max(30, bg - ink)));
      if (a < 0.04) continue;
      const o = ((y - y0) * sw + (x - x0)) * 4;
      // Un-blend the ink colour from the parchment it was drawn on.
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, (rgba[i + c] - (1 - a) * clean[i + c]) / a));
      out[o + 3] = Math.round(a * 255);
    }
    return { x: x0, y: y0, w: sw, h: sh, rgba: out };
  });
  return { clean, sprites };
}
// Shelf-packs sprites into one atlas; returns the atlas RGBA and each sprite's atlas position.
function packAtlas(sprites, width = 2048) {
  const order = sprites.map((s, i) => i).sort((a, b) => sprites[b].h - sprites[a].h);
  let x = 0, y = 0, shelf = 0;
  const at = [];
  for (const i of order) {
    const s = sprites[i];
    if (x + s.w > width) { x = 0; y += shelf + 1; shelf = 0; }
    at[i] = [x, y]; x += s.w + 1; shelf = Math.max(shelf, s.h);
  }
  const height = y + shelf, atlas = Buffer.alloc(width * height * 4);
  sprites.forEach((s, i) => {
    for (let r = 0; r < s.h; r++) s.rgba.copy(atlas, ((at[i][1] + r) * width + at[i][0]) * 4, r * s.w * 4, (r + 1) * s.w * 4);
  });
  return { atlas, width, height, at };
}
module.exports = { extractLabels, packAtlas, findLabels, isInk };
