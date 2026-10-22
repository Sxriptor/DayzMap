const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lootBuildings, typeBuildings, search } = require('../src/map/loot');
const MILITARY = 1, TOWN = 1 << 7, CONTAMINATED = 1 << 15;
const data = {
  types: [
    { name: 'Land_Mil_Barracks1', usage: MILITARY, points: 10, categories: ['weapons', 'clothes'] },
    { name: 'Land_House_1M1', usage: TOWN, points: 4, categories: ['tools'] },
    { name: 'Land_Mil_Tower', usage: MILITARY, points: 0, categories: [] }
  ],
  stride: 5,
  // type, x, z, tier bits, area usage bits
  buildings: [0, 10, 10, 1, 0, 0, 20, 20, 4, 0, 1, 30, 30, 1, 0, 2, 40, 40, 4, 0, 1, 50, 50, 4, CONTAMINATED],
  items: [
    { name: 'AKM', category: 'weapons', usage: MILITARY, tiers: 4 },
    { name: 'Hammer', category: 'tools', usage: TOWN | MILITARY, tiers: 0 },
    { name: 'Apple', category: 'food', usage: TOWN, tiers: 0 },
    { name: 'GasMask', category: 'tools', usage: CONTAMINATED, tiers: 0 }
  ]
};
test('loot needs shared usage, an accepting container and an allowed tier', () => {
  assert.deepEqual(lootBuildings(data, data.items[0]), [1]);
  assert.deepEqual(lootBuildings(data, data.items[1]), [2, 4]);
  assert.deepEqual(lootBuildings(data, data.items[2]), []);
  assert.deepEqual(lootBuildings(data, data.items[3]), [4], 'area usage counts too');
});
test('building type lookup and ranked search', () => {
  assert.deepEqual(typeBuildings(data, 0), [0, 1]);
  assert.deepEqual(search(data, 'a'), []);
  assert.deepEqual(search(data, 'mil').map(h => h.label), ['Mil Tower', 'Mil Barracks1']);
  assert.equal(search(data, 'akm')[0].kind, 'item');
});
for (const id of ['nasdara', 'chernarusplus', 'sakhal']) {
const built = path.join(__dirname, '..', 'src', 'map', id, 'data.js');
test(`generated ${id} data is consistent`, { skip: !fs.existsSync(built) && `run npm run build:map -- ${id} first` }, () => {
  const sandbox = {}; new Function('window', fs.readFileSync(built, 'utf8'))(sandbox);
  const d = sandbox.MAP_DATA;
  assert.equal(d.id, id);
  assert.equal(d.buildings.length % d.stride, 0);
  for (let i = 0; i < d.buildings.length; i += d.stride) {
    assert.ok(d.types[d.buildings[i]]);
    assert.ok(d.buildings[i + 1] >= 0 && d.buildings[i + 1] <= d.size && d.buildings[i + 2] >= 0 && d.buildings[i + 2] <= d.size);
  }
  for (const [level, n] of d.levels.entries()) {
    assert.ok(fs.existsSync(path.join(path.dirname(built), 'tiles', String(level), `${n - 1}_${n - 1}.jpg`)));
    for (const kind of d.mainroads ? ['contours', 'roads'] : ['contours']) assert.ok(fs.existsSync(path.join(path.dirname(built), kind, String(level), `${n - 1}_${n - 1}.png`)));
  }
  const top = d.satLevels.length - 1, n = d.satLevels[top];
  assert.ok(fs.existsSync(path.join(path.dirname(built), 'sat', String(top), `${n - 1}_${n - 1}.jpg`)), 'full-resolution satellite');
  // Printed names are lifted off Nasdara's paper map only.
  if (id === 'nasdara') assert.ok(d.labels.length > 100 && d.labels.every(l => l.length === 6));
  assert.ok(d.infected.length > 100 && d.infected.every(([, , , type]) => d.zoneTypes[type]));
  assert.ok(d.animals.length > 100);
  if (id === 'nasdara') assert.ok(d.underground.length > 10);
  // Most world-loot items can be traced to some building (AKM, for one, does not spawn on Sakhal).
  const found = d.items.filter(item => lootBuildings(d, item).length > 0).length;
  assert.ok(found > d.items.length / 2, `${found} of ${d.items.length} items found in buildings`);
  if (d.places) assert.ok(d.places.every(([x, z, name]) => x >= 0 && x <= d.size && z >= 0 && z <= d.size && !/[Ѐ-ӿ]/.test(name)), 'places on the map, in Latin letters');
});
}
