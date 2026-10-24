// How well the place index finds a spot, with the app's own search (src/places.js):
//   npm run places:eval -- <world> [--sample 400] [--sharpness 0.02] [--cluster 1.6]
// Leave one out: for a sample of captured points, each picture taken there is searched as if it were a
// screenshot, with that point hidden from the index, so the answer has to come from the neighbouring points,
// a grid spacing or more away (a harder test than a real screenshot, which usually falls between points).
// Reports how far the answers land from the truth for one screenshot and for three taken on the spot while
// turning (every other heading), and how far off the facing is.
const path = require('node:path');
const { loadIndex, locate } = require('../src/places');

function percentile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN; }

function evaluate(index, sample, options = {}, seed = 1) {
  // Each point's pictures, and a fixed pseudo-random sample of points.
  const byPoint = new Map();
  index.shots.forEach(([p, heading], s) => { if (!byPoint.has(p)) byPoint.set(p, []); byPoint.get(p).push({ s, heading }); });
  const ids = [...byPoint.keys()];
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const picked = ids.slice(0, sample);
  const query = s => {
    const q = new Float32Array(index.dim);
    let norm = 0;
    for (let k = 0; k < index.dim; k++) { q[k] = index.rows[s * index.dim + k]; norm += q[k] * q[k]; }
    norm = Math.sqrt(norm);
    for (let k = 0; k < index.dim; k++) q[k] /= norm;
    return q;
  };
  const one = [], three = [], facing = [];
  let lookups = 0;
  const started = Date.now();
  for (const p of picked) {
    const shots = byPoint.get(p), tx = index.pointX[p], tz = index.pointZ[p], skip = i => i === p;
    for (const { s, heading } of shots) {
      const answer = locate(index, [query(s)], skip, options);
      lookups++;
      const error = Math.hypot(answer.x - tx, answer.z - tz);
      one.push(error);
      if (error <= 2 * index.spacing) facing.push(Math.abs(((answer.heading - heading) % 360 + 540) % 360 - 180));
    }
    const turn = shots.filter((_, i) => i % 2 === 0).map(({ s }) => query(s));
    if (turn.length >= 2) {
      const answer = locate(index, turn, skip, options);
      lookups++;
      three.push(Math.hypot(answer.x - tx, answer.z - tz));
    }
  }
  return { points: picked.length, one, three, facing, msPerLookup: (Date.now() - started) / lookups };
}

function summary(label, errors, spacing) {
  const sorted = [...errors].sort((a, b) => a - b), within = d => `${Math.round(100 * sorted.filter(e => e <= d).length / sorted.length)}%`;
  return `${label.padEnd(26)} median ${String(Math.round(percentile(sorted, 0.5))).padStart(5)} m, 90% within ${String(Math.round(percentile(sorted, 0.9))).padStart(5)} m · ` +
    `within ${spacing} m ${within(spacing)}, ${2 * spacing} m ${within(2 * spacing)}, 500 m ${within(500)}, 1 km ${within(1000)} (${sorted.length})`;
}

if (require.main === module) {
  const args = process.argv.slice(2), world = args.find(a => !a.startsWith('--')) || 'nasdara';
  const flag = name => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : undefined);
  const sample = flag('sample') || 400, options = { sharpness: flag('sharpness'), cluster: flag('cluster') };
  for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];
  const index = loadIndex(path.join(__dirname, '..', 'src', 'map', world, 'places'));
  const spacing = Math.round(index.spacing);
  console.log(`${world}: ${index.points.length} points, ${index.shots.length} pictures, ${index.model} ${index.dim}-d, grid ${spacing} m`);
  const result = evaluate(index, sample, options);
  console.log(summary('one screenshot', result.one, spacing));
  console.log(summary('three while turning', result.three, spacing));
  const facing = [...result.facing].sort((a, b) => a - b);
  console.log(`facing (answers within ${2 * spacing} m)  median off ${Math.round(percentile(facing, 0.5))}°, 90% within ${Math.round(percentile(facing, 0.9))}°`);
  console.log(`${result.msPerLookup.toFixed(0)} ms per search`);
}
module.exports = { evaluate, summary };
