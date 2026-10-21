const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractLabels, packAtlas } = require('../tools/labels');
// Parchment with a two-glyph black word and a long brown road crossing below it.
function sample() {
  const w = 120, h = 80, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) px.set([222, 205, 170, 255], i);
  const paint = (x0, y0, x1, y1, rgb) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px.set(rgb, (y * w + x) * 4); };
  const glyph = (x0, x1) => { const k = [10, 10, 10]; paint(x0, 30, x0 + 1, 41, k); paint(x1 - 1, 30, x1, 41, k); paint(x0, 30, x1, 31, k); paint(x0, 40, x1, 41, k); };
  glyph(40, 46); glyph(49, 55); paint(52, 26, 53, 27, [10, 10, 10]); // two hollow glyphs and an i-dot
  paint(0, 60, w - 1, 61, [120, 80, 30]);
  return { w, h, px };
}
test('labels are lifted off the map and the map underneath is restored', () => {
  const { w, h, px } = sample();
  const { clean, sprites } = extractLabels(px, w, h);
  assert.equal(sprites.length, 1);
  const s = sprites[0];
  assert.ok(s.x <= 40 && s.y <= 26 && s.x + s.w > 55 && s.y + s.h > 41, 'sprite covers both glyphs and the dot');
  const at = (x, y) => [...clean.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];
  assert.ok(at(40, 35).every((v, i) => Math.abs(v - [222, 205, 170][i]) < 8), 'glyph painted out');
  assert.deepEqual(at(60, 60), [120, 80, 30], 'road untouched');
  const opaque = (x, y) => s.rgba[((y - s.y) * s.w + (x - s.x)) * 4 + 3];
  assert.ok(opaque(40, 35) > 240 && opaque(43, 35) < 20);
  const pack = packAtlas(sprites);
  assert.equal(pack.at.length, 1); assert.ok(pack.height >= s.h);
});
