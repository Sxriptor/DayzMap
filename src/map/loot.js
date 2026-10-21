// Pure map-data helpers shared by the map page and the Node tests.
(function (root) {
  const TIER_BITS = 15; // Tier1-4; the Unique bit does not restrict location.
  const pretty = name => name.replace(/^Land_/, '').replace(/_/g, ' ');

  // Buildings (record indices into data.buildings) where the Central Economy can place an item: a usage flag
  // shared with the building or its area, a container accepting its category, and an area tier the item allows.
  // This mirrors the economy rules closely but is not an exact simulation.
  function lootBuildings(data, item) {
    const fits = data.types.map(t => t.points > 0 &&
      (!item.category || !t.categories.length || t.categories.includes(item.category)));
    const tiers = item.tiers & TIER_BITS, s = data.stride, out = [];
    for (let i = 0, b = data.buildings; i < b.length; i += s) {
      if (fits[b[i]] && ((data.types[b[i]].usage | b[i + 4]) & item.usage) && (!tiers || (b[i + 3] & tiers))) out.push(i / s);
    }
    return out;
  }
  function typeBuildings(data, typeIndex) {
    const s = data.stride, out = [];
    for (let i = 0, b = data.buildings; i < b.length; i += s) if (b[i] === typeIndex) out.push(i / s);
    return out;
  }
  // Ranked search over loot items and building types; prefix matches first.
  function search(data, query, limit = 40) {
    const q = query.trim().toLowerCase().replace(/[\s_]+/g, '');
    if (q.length < 2) return [];
    const hits = [];
    const add = (kind, index, label) => {
      const key = label.toLowerCase().replace(/[\s_]+/g, ''), at = key.indexOf(q);
      if (at >= 0) hits.push({ kind, index, label, rank: (at === 0 ? 0 : 1) + key.length / 1000 });
    };
    data.items.forEach((item, i) => add('item', i, item.name));
    data.types.forEach((type, i) => add('building', i, pretty(type.name)));
    return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }
  const api = { lootBuildings, typeBuildings, search, pretty };
  if (typeof module !== 'undefined') module.exports = api; else root.MapLoot = api;
})(this);
