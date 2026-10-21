// Decoder for Bohemia PAA textures (DXT1/DXT5, optionally LZO-compressed mipmaps) to RGBA.
// Port of the reference lzo1x_decompress state machine.
function lzo1x(src, outSize) {
  const out = Buffer.alloc(outSize); let ip = 0, op = 0, t, state;
  const lit = n => { while (n--) out[op++] = src[ip++]; };
  const copy = (dist, n) => { let m = op - dist; while (n--) out[op++] = out[m++]; };
  const extend = base => { let n = 0; while (src[ip] === 0) { n += 255; ip++; } return n + base + src[ip++]; };
  if (src[0] > 17) { t = src[ip++] - 17; if (t < 4) state = 'next'; else { lit(t); state = 'first'; } }
  else state = 'loop';
  for (;;) {
    if (state === 'loop') {
      t = src[ip++];
      if (t >= 16) state = 'match';
      else { lit((t === 0 ? extend(15) : t) + 3); state = 'first'; }
      continue;
    }
    if (state === 'first') {
      t = src[ip++];
      if (t >= 16) { state = 'match'; continue; }
      copy(1 + 0x800 + (t >> 2) + (src[ip++] << 2), 3); state = 'done'; continue;
    }
    if (state === 'match') {
      if (t >= 64) { copy(1 + ((t >> 2) & 7) + (src[ip++] << 3), (t >> 5) + 1); }
      else if (t >= 32) {
        const len = (t & 31) || extend(31);
        const dist = 1 + (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2; copy(dist, len + 2);
      } else if (t >= 16) {
        const hi = (t & 8) << 11; const len = (t & 7) || extend(7);
        const dist = hi + (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
        if (dist === 0) { if (op !== outSize) throw new Error(`lzo: ${op}/${outSize} bytes`); return out; }
        copy(dist + 0x4000, len + 2);
      } else { copy(1 + (t >> 2) + (src[ip++] << 2), 2); }
      state = 'done'; continue;
    }
    if (state === 'done') { t = src[ip - 2] & 3; if (t === 0) { state = 'loop'; continue; } state = 'next'; }
    if (state === 'next') { lit(t); t = src[ip++]; state = 'match'; }
  }
}
function rgb565(c) { return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }
function dxt(data, w, h, dxt5) {
  const out = Buffer.alloc(w * h * 4), bs = dxt5 ? 16 : 8; let p = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4, p += bs) {
    const cOff = dxt5 ? p + 8 : p, c0 = data.readUInt16LE(cOff), c1 = data.readUInt16LE(cOff + 2);
    const a = rgb565(c0), b = rgb565(c1);
    const pal = [a, b, c0 > c1 || dxt5 ? a.map((v, i) => (2 * v + b[i]) / 3 | 0) : a.map((v, i) => (v + b[i]) / 2 | 0),
      c0 > c1 || dxt5 ? a.map((v, i) => (v + 2 * b[i]) / 3 | 0) : [0, 0, 0]];
    const bits = data.readUInt32LE(cOff + 4);
    let alpha = null;
    if (dxt5) {
      const a0 = data[p], a1 = data[p + 1];
      const ap = [a0, a1]; for (let i = 1; i < 7; i++) ap.push(a0 > a1 ? ((7 - i) * a0 + i * a1) / 7 | 0 : i < 5 ? ((5 - i) * a0 + i * a1) / 5 | 0 : i === 5 ? 0 : 255);
      if (a0 <= a1) { ap.length = 6; ap.push(0, 255); }
      let abits = 0n; for (let i = 0; i < 6; i++) abits |= BigInt(data[p + 2 + i]) << BigInt(8 * i);
      alpha = i => ap[Number((abits >> BigInt(3 * i)) & 7n)];
    }
    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2); if (x >= w || y >= h) continue;
      const col = pal[(bits >>> (2 * i)) & 3], o = (y * w + x) * 4;
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
      out[o + 3] = alpha ? alpha(i) : (c0 <= c1 && ((bits >>> (2 * i)) & 3) === 3 ? 0 : 255);
    }
  }
  return out;
}
// Returns every mipmap header plus a decode(index) function.
function readPaa(buf) {
  const type = buf.readUInt16LE(0);
  if (type !== 0xff01 && type !== 0xff05) throw new Error(`unsupported PAA type ${type.toString(16)}`);
  let pos = 2;
  while (buf.toString('latin1', pos, pos + 4) === 'GGAT') pos += 8 + buf.readUInt32LE(pos + 8) + 4;
  pos += 2 + buf.readUInt16LE(pos) * 3; // palette
  const mips = [];
  for (;;) {
    let w = buf.readUInt16LE(pos), h = buf.readUInt16LE(pos + 2);
    if (!w || !h) break;
    const lzo = !!(w & 0x8000); w &= 0x7fff;
    const size = buf.readUIntLE(pos + 4, 3);
    mips.push({ w, h, lzo, offset: pos + 7, size }); pos += 7 + size;
  }
  return {
    mips,
    decode(i) {
      const m = mips[i], raw = buf.subarray(m.offset, m.offset + m.size);
      const blocks = (Math.max(4, m.w) / 4) * (Math.max(4, m.h) / 4) * (type === 0xff05 ? 16 : 8);
      return { w: m.w, h: m.h, rgba: dxt(m.lzo ? lzo1x(raw, blocks) : raw, m.w, m.h, type === 0xff05) };
    }
  };
}
module.exports = { readPaa };
