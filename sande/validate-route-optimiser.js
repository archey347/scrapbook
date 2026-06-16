'use strict';
// Validation harness for the route optimiser embedded in sande2025map.html.
//
// It extracts the real optimiser source (route + optimizeOrder, the routable
// graph build, Dijkstra) and the real event data straight out of the HTML,
// runs them under Node with no browser/Leaflet, and checks the correctness
// properties the optimiser relies on:
//   - output is a permutation of the input (no dropped/duplicated stops)
//   - the start and end stops stay pinned
//   - the optimised order is never longer than the user's input order
//   - it matches the brute-force optimum on the small instances this map uses
//   - route() is internally consistent (total == sum of legs)
//
// Run:  node validate-route-optimiser.js   (exit code 0 == all checks passed)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, 'sande2025map.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// extract the real DATA object via balanced-brace slice from `const DATA = `
function extractData(src) {
  const key = 'const DATA = ';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('DATA not found');
  const objStart = src.indexOf('{', start);
  let i = objStart, depth = 0, inStr = false, esc = false, q = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(objStart, i);
}

// extract the algorithm block (geometry helpers .. end of optimizeOrder)
const algoStart = html.indexOf('/* ---------- geometry helpers ---------- */');
const algoEnd = html.indexOf('/* ---------- formatting ---------- */');
if (algoStart < 0 || algoEnd < 0) throw new Error('algorithm markers not found');
const algoSrc = html.slice(algoStart, algoEnd);

const moduleSrc = `
const DATA = ${extractData(html)};
${algoSrc}
module = { exports: {} };
module.exports = { route, optimizeOrder, _stats: { nodes: nodes.length, edges: edges.length } };
`;

const sandbox = { module: {}, console, Math, Map, Set, Infinity, Array, Number };
vm.createContext(sandbox);
vm.runInContext(moduleSrc, sandbox, { filename: 'algo.js' });
const M = sandbox.module.exports;

console.log(`Graph built from event data: ${M._stats.nodes} nodes, ${M._stats.edges} edges\n`);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  (cond ? pass++ : fail++);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const key = p => p.lat + ',' + p.lng;
const sameMultiset = (a, b) => {
  if (a.length !== b.length) return false;
  const ca = {}, cb = {};
  a.forEach(p => ca[key(p)] = (ca[key(p)] || 0) + 1);
  b.forEach(p => cb[key(p)] = (cb[key(p)] || 0) + 1);
  return Object.keys(ca).every(k => ca[k] === cb[k]) &&
         Object.keys(cb).every(k => cb[k] === ca[k]);
};
const realTotal = (pts, mode, avoid) =>
  M.route(pts.map(p => ({ lat: p.lat, lng: p.lng })), mode, avoid).total;

const data = JSON.parse(vm.runInContext('JSON.stringify(DATA)', sandbox));
const pool = [];
data.groups.forEach(g => g.waypoints.forEach(w => pool.push({ lat: w.lat, lng: w.lng, label: w.name })));
console.log(`Waypoint pool: ${pool.length} real checkpoints\n`);

function rngFactory(seed) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

function permute(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => permute(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(p => out.push([x, ...p])));
  return out;
}
function bruteOptimum(pts, mode, avoid) {
  const start = pts[0], end = pts[pts.length - 1], mid = pts.slice(1, -1);
  let best = Infinity;
  permute(mid).forEach(perm => {
    const t = realTotal([start, ...perm, end], mode, avoid);
    if (t < best) best = t;
  });
  return best;
}

console.log('=== Property tests (random small instances) ===');
const rnd = rngFactory(42);
let permOK = true, pinOK = true, worseThanInput = 0, optimalHits = 0, optimalTotal = 0, maxGapPct = 0;

for (let trial = 0; trial < 40; trial++) {
  const mode = trial % 3 === 0 ? 'drive' : 'walk';
  const avoid = trial % 5 === 0;
  const n = 4 + Math.floor(rnd() * 4);
  const pts = [], used = new Set();
  while (pts.length < n) {
    const k = Math.floor(rnd() * pool.length);
    if (used.has(k)) continue;
    used.add(k); pts.push(pool[k]);
  }
  const out = M.optimizeOrder(pts, mode, avoid);
  if (!sameMultiset(pts, out)) permOK = false;
  if (out[0].label !== pts[0].label || out[out.length - 1].label !== pts[pts.length - 1].label) pinOK = false;
  if (realTotal(out, mode, avoid) > realTotal(pts, mode, avoid) + 1) worseThanInput++;
  const best = bruteOptimum(pts, mode, avoid);
  optimalTotal++;
  const gap = best > 0 ? (realTotal(out, mode, avoid) - best) / best * 100 : 0;
  if (realTotal(out, mode, avoid) <= best + 1) optimalHits++;
  if (gap > maxGapPct) maxGapPct = gap;
}
check('output is a permutation of input (multiset)', permOK);
check('start & end points stay pinned', pinOK);
check('optimised never longer than original input order', worseThanInput === 0,
      worseThanInput ? worseThanInput + ' trial(s) got worse' : 'all <= input');
check('matches brute-force optimum on small instances', optimalHits === optimalTotal,
      `${optimalHits}/${optimalTotal} optimal, worst gap ${maxGapPct.toFixed(2)}%`);

console.log('\n=== Larger instances (nearest-neighbour + 2-opt branch) ===');
const rndL = rngFactory(7);
let lWorse = 0, lStruct = true, lTests = 0;
for (let t = 0; t < 25; t++) {
  const mode = t % 2 ? 'walk' : 'drive', avoid = t % 4 === 0;
  const n = Math.min(10 + Math.floor(rndL() * 16), pool.length);
  const pts = [], used = new Set();
  while (pts.length < n) {
    const k = Math.floor(rndL() * pool.length);
    if (used.has(k)) continue;
    used.add(k); pts.push(pool[k]);
  }
  const out = M.optimizeOrder(pts, mode, avoid); lTests++;
  if (!sameMultiset(pts, out) ||
      out[0].label !== pts[0].label ||
      out[out.length - 1].label !== pts[pts.length - 1].label) lStruct = false;
  if (realTotal(out, mode, avoid) > realTotal(pts, mode, avoid) + 1) lWorse++;
}
check('large instances stay structurally valid (permutation + pinned ends)', lStruct, `${lTests} trials`);
check('large instances never longer than input order', lWorse === 0,
      lWorse ? lWorse + ' worse' : 'all <= input');

console.log('\n=== Degenerate inputs ===');
const two = [pool[0], pool[1]];
check('n=2 returns unchanged', JSON.stringify(M.optimizeOrder(two, 'walk', false)) === JSON.stringify(two));
const three = [pool[0], pool[1], pool[2]];
check('n=3 returns unchanged (single mid stop)', JSON.stringify(M.optimizeOrder(three, 'walk', false)) === JSON.stringify(three));

console.log('\n=== route() consistency ===');
const sample = [pool[0], pool[5], pool[12], pool[20]];
const r = M.route(sample.map(p => ({ lat: p.lat, lng: p.lng })), 'walk', false);
const legSum = r.legs.reduce((s, l) => s + (l ? l.dist : 0), 0);
check('total equals sum of leg distances', Math.abs(r.total - legSum) < 1e-6,
      `total=${r.total.toFixed(1)} legSum=${legSum.toFixed(1)}`);
check('one leg per consecutive pair', r.legs.length === sample.length - 1);
check('offs reported per point', r.offs.length === sample.length);

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + fail + ' CHECK(S) FAILED'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
