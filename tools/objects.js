// Turns the export mod's object list (one JSON object per line) into map layers: powerlines (from the wire
// objects where the map has them, else joined up from poles/towers) and sign positions.
const FAMILIES = [
  // [family, model test, longest span between neighbours in metres]
  ['hv', /hv3?_tower|vhv_tower|power_hv_line|hv_tower/, 450],
  ['pole', /power_pole/, 90]
];
function parseExport(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      // '#animator' and other engine helpers are not map objects.
      if (typeof o.m === 'string' && !o.m.startsWith('#') && [o.x, o.z].every(Number.isFinite)) out.push(o);
    } catch {}
  }
  return out;
}
const familyOf = model => (FAMILIES.find(([, test]) => test.test(model)) || [])[0];
// Some maps (Nasdara) place the wires themselves as objects: one straight span along the model's z axis.
// Only local lines: high-voltage wire pieces leave gaps at the towers, which are mapped and joined instead.
const WIRES = [['pole', /power_wire(tel)?_\d/]];
const wireFamily = model => (WIRES.find(([, test]) => test.test(model)) || [])[0];
// Wire spans as segments, from the position, yaw and model box (export mod files with "b"). The parallel
// conductors of one span collapse into a single segment.
function wireSegments(objects) {
  const out = [], seen = new Set();
  for (const o of objects) {
    const family = wireFamily(o.m);
    if (!family || !Array.isArray(o.b)) continue;
    const yaw = (o.yaw || 0) * Math.PI / 180, half = (o.b[5] - o.b[2]) / 2, mid = (o.b[5] + o.b[2]) / 2;
    const dx = Math.sin(yaw), dz = Math.cos(yaw), cx = o.x + dx * mid, cz = o.z + dz * mid;
    const key = `${family}${Math.round(cx / 4)},${Math.round(cz / 4)},${Math.round(((o.yaw % 180) + 180) % 180 / 10)}`;
    if (half < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push([round(cx - dx * half), round(cz - dz * half), round(cx + dx * half), round(cz + dz * half), family]);
  }
  return out;
}
// Wires where the map has them; otherwise each family's nodes linked shortest-first, at most two links per
// node and no loops, so lines come out as chains.
function powerlines(objects) {
  const segments = wireSegments(objects), poles = [], wired = new Set(segments.map(s => s[4]));
  for (const [family, , span] of FAMILIES) {
    const nodes = objects.filter(o => familyOf(o.m) === family);
    if (wired.has(family)) { for (const o of nodes) poles.push([round(o.x), round(o.z), family]); continue; }
    for (const o of nodes) poles.push([round(o.x), round(o.z), family]);
    const cell = span, grid = new Map(), key = (gx, gz) => gx * 100000 + gz;
    nodes.forEach((o, i) => { const k = key(Math.floor(o.x / cell), Math.floor(o.z / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    const edges = [];
    nodes.forEach((a, i) => {
      const gx = Math.floor(a.x / cell), gz = Math.floor(a.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const j of grid.get(key(gx + dx, gz + dz)) || []) {
        if (j <= i) continue;
        const d = Math.hypot(nodes[j].x - a.x, nodes[j].z - a.z);
        if (d > 1 && d <= span) edges.push([d, i, j]);
      }
    });
    edges.sort((a, b) => a[0] - b[0]);
    const degree = new Uint8Array(nodes.length), parent = nodes.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const [, i, j] of edges) {
      if (degree[i] >= 2 || degree[j] >= 2 || find(i) === find(j)) continue;
      parent[find(i)] = find(j); degree[i]++; degree[j]++;
      segments.push([round(nodes[i].x), round(nodes[i].z), round(nodes[j].x), round(nodes[j].z), family]);
    }
  }
  return { segments, poles };
}
const signs = objects => objects.filter(o => /sign|billboard/.test(o.m) && !familyOf(o.m))
  .map(o => [round(o.x), round(o.z), o.m.split('/').pop().replace(/\.p3d$/, '')]);
const round = v => Math.round(v * 10) / 10;
module.exports = { parseExport, powerlines, signs };
