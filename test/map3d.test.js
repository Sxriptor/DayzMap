const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const THREE = require('three');

function viewer(enabled = {}) {
  const draws = [], arcs = [];
  const context = new Proxy({}, { get(target, name) {
    if (name === 'drawImage') return (...args) => draws.push(args);
    if (name === 'arc') return (...args) => arcs.push(args);
    return target[name] || (() => {});
  }, set(target, name, value) { target[name] = value; return true; } });
  class Image {
    constructor() { this.width = this.height = this.naturalWidth = this.naturalHeight = 512; this.complete = true; }
    set src(value) { this.path = value; queueMicrotask(() => this.onload()); }
  }
  const sandbox = {
    THREE, Image, console, window: {}, ROOT: 'example/', base: 'satellite', view: { s: 0.7 },
    innerHeight: 900, layers: enabled, NEEDS: { roadnet: 'roadnet', mainroads: 'mainroads' },
    data: { size: 16384, tile: 512, levels: [2, 4, 8], satLevels: [2, 4, 8, 16, 32],
      animals: [], infected: [], outlines: [15800, 15700, 8, 6, 0], zones: [{ x: 15800, z: 15700, r: 50 }] },
    baseKind: () => 'sat', levelsOf: () => [2, 4, 8, 16, 32],
    document: { createElement: () => ({ getContext: () => context }) },
    reliefImage: null, forestImage: null, tierImage: null,
    INFECTED_COLORS: [], COLORS: {}, animalLayer: () => 'game',
  };
  // Expose the compositor only inside this isolated test context.
  const source = fs.readFileSync(require.resolve('../src/map/map3d.js'), 'utf8').replace(
    /  return \{\r?\n    async open\(\)/,
    '  window.testViewer = { composePatch, setRenderer(value) { renderer = value; } };\n  return {\n    async open()');
  vm.runInNewContext(source, sandbox);
  sandbox.window.testViewer.setRenderer({ capabilities: { maxTextureSize: 4096 } });
  draws.length = 0; arcs.length = 0;
  return { sandbox, api: sandbox.window.testViewer, draws, arcs };
}

test('3D uses full-resolution satellite tiles and crops the sharpest available overlay parent', async () => {
  const { api, draws } = viewer({ topo: true });
  const image = await api.composePatch({ level: 4, x: 30, y: 1, span: 512 });
  assert.equal(image.width, 512);
  assert.equal(draws[0][0].path, 'example/sat/4/30_1.jpg');
  assert.equal(draws[1][0].path, 'example/contours/2/7_0.png');
  assert.deepEqual(draws[1].slice(1), [256, 128, 128, 128, 0, 0, 512, 512]);
});

test('3D retains enabled area overlays and leaves disabled areas out', async () => {
  const { api, arcs, sandbox } = viewer({ zones: true });
  const patch = { level: 4, x: 30, y: 1, span: 512 };
  await api.composePatch(patch);
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0][2], 50);
  sandbox.layers.zones = false;
  await api.composePatch(patch);
  assert.equal(arcs.length, 1);
});

test('3D white base preserves overlays without loading satellite imagery', async () => {
  const { api, sandbox, draws } = viewer({ topo: true });
  sandbox.base = 'white';
  await api.composePatch({ level: 0, x: 0, y: 0, span: 8192 });
  assert.equal(draws.length, 1);
  assert.equal(draws[0][0].path, 'example/contours/0/0_0.png');
});
