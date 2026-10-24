const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, SHORTCUTS, MAP_COMMANDS } = require('../src/config');
test('preferences recover defaults, clamp opacity and drop old map settings', () => {
  const settings = sanitize({ map: 'chernarus', url: 'https://www.izurvive.com/', keys: { up: 'Control+Alt+Up' }, opacity: 0.1 });
  assert.deepEqual(settings, { alwaysOnTop: true, unloadHidden: true, opacity: 0.4, bounds: undefined });
  assert.deepEqual(sanitize(null), sanitize({}));
});
test('window bounds are kept only when valid', () => {
  assert.deepEqual(sanitize({ bounds: { x: 10.4, y: -5, width: 800, height: 600 } }).bounds, { x: 10, y: -5, width: 800, height: 600 });
  for (const bounds of [{ x: 0, y: 0, width: 50, height: 600 }, { x: 'a', y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: Infinity, height: 600 }])
    assert.equal(sanitize({ bounds }).bounds, undefined);
});
test('numpad layout matches the requested controls', () => {
  const keys = Object.fromEntries(Object.entries(SHORTCUTS).map(([id, [, key]]) => [id, key]));
  assert.deepEqual(keys, { toggle: 'Control+Alt+M', clickThrough: 'Control+Alt+T', locate: 'Control+Alt+L', locateMore: 'Control+Alt+Shift+L', up: 'num8', left: 'num4', right: 'num6', down: 'num2',
    rotateLeft: 'num1', rotateRight: 'num3', zoomIn: 'num9', zoomOut: 'num7' });
  assert.ok(MAP_COMMANDS.every(id => SHORTCUTS[id]));
  assert.equal(new Set(Object.values(keys)).size, Object.keys(keys).length);
});
