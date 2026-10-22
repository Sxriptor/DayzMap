// Full-resolution satellite tiles straight from the terrain's layers/S_<col>_<row>_lco.paa textures:
// each is 512 px = 512 m, repeating every `step` m with `edge` px of overlap on each side (Nasdara 384 / 64,
// Chernarus and Sakhal 480 / 16; see layerGrid in build-map.js), row 0 at the north edge. Output tiles of
// `tile` px at 1 m/px (and a 2 m/px level averaged from them) are produced one row at a time, so the full
// mosaic never has to exist in memory.

// writeTile(levelOffset, tx, ty, rgba): levelOffset 0 = full resolution, 1 = half resolution.
function satelliteTiles(sources, decode, size, tile, writeTile, { step: STEP = 384, edge: EDGE = 64 } = {}) {
  const n = size / tile, rows = new Map(); // source row -> decoded RGBA by column
  const sourceRow = r => {
    if (!rows.has(r)) rows.set(r, new Map(sources.filter(s => s.row === r).map(s => [s.col, decode(s.name)])));
    return rows.get(r);
  };
  let previous = null; // full-resolution tiles of the even row, for the half-resolution level
  for (let ty = 0; ty < n; ty++) {
    const row = [];
    for (let tx = 0; tx < n; tx++) {
      const out = Buffer.alloc(tile * tile * 4);
      for (let y = 0; y < tile; y++) {
        const gy = ty * tile + y, r = Math.floor(gy / STEP), src = sourceRow(r);
        for (let x = 0; x < tile; x++) {
          const gx = tx * tile + x, c = Math.floor(gx / STEP), t = src.get(c);
          const o = (y * tile + x) * 4;
          if (!t) { out[o + 3] = 255; continue; }
          const i = ((EDGE + gy - r * STEP) * t.w + EDGE + gx - c * STEP) * 4;
          out[o] = t.rgba[i]; out[o + 1] = t.rgba[i + 1]; out[o + 2] = t.rgba[i + 2]; out[o + 3] = 255;
        }
      }
      writeTile(0, tx, ty, out);
      row.push(out);
    }
    if (ty % 2) {
      for (let tx = 0; tx < n; tx += 2) {
        const half = Buffer.alloc(tile * tile * 4);
        for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
          const src = (y < tile / 2 ? previous : row)[tx + (x < tile / 2 ? 0 : 1)];
          const sx = (x % (tile / 2)) * 2, sy = (y % (tile / 2)) * 2, o = (y * tile + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const at = (dx, dy) => src[((sy + dy) * tile + sx + dx) * 4 + ch];
            half[o + ch] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4;
          }
          half[o + 3] = 255;
        }
        writeTile(1, tx / 2, (ty - 1) / 2, half);
      }
    }
    previous = row;
    // Source rows above the next output row are no longer needed.
    const keepFrom = Math.floor(((ty + 1) * tile) / STEP);
    for (const r of rows.keys()) if (r < keepFrom) rows.delete(r);
  }
}
module.exports = { satelliteTiles };
