const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore, createTapper } = require('../src/map/pins');

test('pins save, move, reload and delete while rejecting invalid coordinates', () => {
  let saved;
  const store = createStore(1000, null, points => { saved = points; });
  assert.equal(store.add(-1, 100), null);
  assert.equal(store.add(NaN, 100), null);
  const point = store.add(100, 200);
  assert.deepEqual(saved, [{ id: point.id, x: 100, z: 200 }]);
  assert.equal(store.move(point.id, 500, 600), true);
  assert.equal(store.move(point.id, 5000, 600), false);
  const restored = createStore(1000, saved, points => { saved = points; });
  assert.deepEqual(restored.points, [{ id: point.id, x: 500, z: 600 }]);
  restored.remove(point.id);
  assert.deepEqual(saved, []);
});

test('saved pins reject malformed and duplicate entries', () => {
  const store = createStore(1000, [null, {}, {id:'a',x:10,z:20}, {id:'a',x:30,z:40}, {id:'b',x:Infinity,z:20}, {id:'c',x:10,z:1001}], () => {});
  assert.deepEqual(store.points, [{id:'a',x:10,z:20}]);
});

test('double tap requires nearby taps within the time limit and resets after a drag', () => {
  const tapper = createTapper();
  assert.equal(tapper.tap(100, 100, 0), false);
  assert.equal(tapper.tap(105, 103, 250), true);
  assert.equal(tapper.tap(105, 103, 300), false);
  assert.equal(tapper.tap(105, 103, 900), false);
  assert.equal(tapper.tap(200, 200, 1000), false);
  tapper.reset();
  assert.equal(tapper.tap(200, 200, 1100), false);
});
