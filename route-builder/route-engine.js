/* Bearing-compass route engine — pure JS, no DOM, no network.
 * Usable in the browser (attached to window.RouteEngine) and in Node
 * (module.exports) so the logic can be unit-tested offline.
 *
 * Given a walkable street graph and a target shape, it searches placements
 * (rotation x scale x offset), snaps shape vertices to roads, routes each leg
 * with Dijkstra, scores how closely the routed path traces the shape (plus a
 * length-budget term), and returns the best closed route starting/ending at a
 * fixed anchor (the church). It also simplifies the route into turn-by-turn
 * (bearing, distance) legs for compass navigation.
 */
(function (root) {
  "use strict";

  const R_EARTH = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;

  function haversine(a, b) {
    const p1 = toRad(a[0]), p2 = toRad(b[0]);
    const dphi = toRad(b[0] - a[0]), dlam = toRad(b[1] - a[1]);
    const h = Math.sin(dphi / 2) ** 2 +
              Math.cos(p1) * Math.cos(p2) * Math.sin(dlam / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDeg(a, b) {
    const p1 = toRad(a[0]), p2 = toRad(b[0]);
    const dlam = toRad(b[1] - a[1]);
    const y = Math.sin(dlam) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) -
              Math.sin(p1) * Math.cos(p2) * Math.cos(dlam);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Equirectangular projection around a centre, in metres.
  function localXY(center) {
    const mlat = 111320, mlon = 111320 * Math.cos(toRad(center[0]));
    return {
      toXY: (ll) => [(ll[1] - center[1]) * mlon, (ll[0] - center[0]) * mlat],
      toLL: (xy) => [center[0] + xy[1] / mlat, center[1] + xy[0] / mlon],
    };
  }

  // ---- shapes: closed rings in unit space (x right, y up, ~[-1,1]).
  // First vertex is the anchor (church), at bottom-centre. -----------------
  function star(points = 5, rOut = 1.0, rIn = 0.42) {
    const v = [];
    for (let i = 0; i < points * 2; i++) {
      const ang = Math.PI / 2 + i * Math.PI / points;
      const r = i % 2 === 0 ? rOut : rIn;
      v.push([r * Math.cos(ang), r * Math.sin(ang)]);
    }
    let lo = 0;
    for (let i = 1; i < v.length; i++)
      if (v[i][1] < v[lo][1] ||
         (v[i][1] === v[lo][1] && Math.abs(v[i][0]) < Math.abs(v[lo][0]))) lo = i;
    const rot = v.slice(lo).concat(v.slice(0, lo));
    return [[0, Math.min(...rot.map((p) => p[1]))]].concat(rot);
  }

  function heart(n = 24) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = Math.PI - 2 * Math.PI * i / n;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) -
                2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([x / 16, y / 16]);
    }
    let lo = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[lo][1]) lo = i;
    return pts.slice(lo).concat(pts.slice(0, lo));
  }

  // Bold, few-vertex outlines read best once snapped to the street grid.
  // Each is a closed ring; the FIRST vertex is the church anchor (bottom-centre).
  const SHAPES = {
    // bold & obvious
    diamond: [[0, -1], [-1, 0], [0, 1], [1, 0]],
    square:  [[0, -1], [-1, -1], [-1, 1], [1, 1], [1, -1]],
    arrow:   [[0, -1], [-0.33, -1], [-0.33, 0.2], [-0.66, 0.2],
              [0, 1], [0.66, 0.2], [0.33, 0.2], [0.33, -1]],   // up arrow
    cross:   [[0, -1], [-0.34, -1], [-0.34, -0.34], [-1, -0.34],
              [-1, 0.34], [-0.34, 0.34], [-0.34, 1], [0.34, 1],
              [0.34, 0.34], [1, 0.34], [1, -0.34], [0.34, -0.34], [0.34, -1]],
    heart:   heart(),
    star:    star(),
    bolt:    [[0, -1], [-0.15, -1], [0.25, -0.1], [-0.1, -0.1],
              [0.15, 1], [-0.45, 0.0], [0.0, 0.0], [-0.35, -1]], // lightning
    // recognisable scenes
    house:   [[0, -1], [-1, -1], [-1, 0.15], [0, 1], [1, 0.15], [1, -1]],
    tent:    [[0, -0.85], [-1, -0.85], [0, 1], [1, -0.85]],
    tree:    [[0, -1.0], [0.16, -1.0], [0.16, -0.55], [0.62, -0.55],
              [0.30, -0.18], [0.50, -0.18], [0.22, 0.22], [0.40, 0.22],
              [0.0, 0.95],
              [-0.40, 0.22], [-0.22, 0.22], [-0.50, -0.18], [-0.30, -0.18],
              [-0.62, -0.55], [-0.16, -0.55], [-0.16, -1.0]],
  };

  // ---- graph -------------------------------------------------------------
  // graph = { nodes: Map(id -> [lat,lng]), adj: Map(id -> [[to, w], ...]) }
  // ROADS ONLY: named carriageways you'd walk along — no footways, paths,
  // cycleways, steps, tracks, service roads or pedestrian precincts.
  const ROAD_TYPES = new Set(["primary", "primary_link", "secondary",
    "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "road"]);

  function graphFromOSM(osm) {
    const coord = new Map();
    for (const el of osm.elements)
      if (el.type === "node") coord.set(el.id, [el.lat, el.lon]);
    const nodes = new Map(), adj = new Map();
    const link = (a, b) => {
      const w = haversine(coord.get(a), coord.get(b));
      if (!nodes.has(a)) { nodes.set(a, coord.get(a)); adj.set(a, []); }
      if (!nodes.has(b)) { nodes.set(b, coord.get(b)); adj.set(b, []); }
      adj.get(a).push([b, w]); adj.get(b).push([a, w]);
    };
    for (const el of osm.elements) {
      if (el.type !== "way") continue;
      const hw = el.tags && el.tags.highway;
      if (!hw || !ROAD_TYPES.has(hw)) continue;
      const nd = el.nodes || [];
      for (let i = 1; i < nd.length; i++)
        if (coord.has(nd[i - 1]) && coord.has(nd[i])) link(nd[i - 1], nd[i]);
    }
    return largestComponent({ nodes, adj });
  }

  function largestComponent(g) {
    const seen = new Set();
    let best = null;
    for (const start of g.nodes.keys()) {
      if (seen.has(start)) continue;
      const comp = [], stack = [start]; seen.add(start);
      while (stack.length) {
        const u = stack.pop(); comp.push(u);
        for (const [v] of g.adj.get(u)) if (!seen.has(v)) { seen.add(v); stack.push(v); }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    const keep = new Set(best);
    const nodes = new Map(), adj = new Map();
    for (const id of keep) {
      nodes.set(id, g.nodes.get(id));
      adj.set(id, g.adj.get(id).filter(([v]) => keep.has(v)));
    }
    return { nodes, adj };
  }

  function demoGrid(center, radiusM, spacing = 55) {
    const { toLL } = localXY(center);
    const n = Math.floor(radiusM / spacing);
    const nodes = new Map(), adj = new Map();
    const id = (i, j) => i * 10000 + j;
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++) {
        nodes.set(id(i, j), toLL([i * spacing, j * spacing])); adj.set(id(i, j), []);
      }
    const link = (a, b) => {
      const w = haversine(nodes.get(a), nodes.get(b));
      adj.get(a).push([b, w]); adj.get(b).push([a, w]);
    };
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++) {
        if (i + 1 <= n) link(id(i, j), id(i + 1, j));
        if (j + 1 <= n) link(id(i, j), id(i, j + 1));
      }
    return { nodes, adj };
  }

  // ---- nearest node (linear scan; fine for ~mile-radius graphs) ----------
  function nearestNode(g, ll) {
    let best = null, bd = Infinity;
    for (const [id, c] of g.nodes) {
      const dx = (c[0] - ll[0]), dy = (c[1] - ll[1]);
      const d = dx * dx + dy * dy;               // cheap squared-deg metric
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // ---- binary min-heap for Dijkstra --------------------------------------
  function dijkstra(g, src, dst) {
    const dist = new Map(), prev = new Map();
    dist.set(src, 0);
    const heap = [[0, src]];
    const push = (d, n) => {
      heap.push([d, n]); let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let i = 0;
        for (;;) { let l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (u === dst) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const [v, w] of g.adj.get(u)) {
        const nd = d + w;
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); push(nd, v); }
      }
    }
    if (!prev.has(dst) && src !== dst) return null;
    const path = [dst]; let cur = dst;
    while (cur !== src) { cur = prev.get(cur); if (cur === undefined) return null; path.push(cur); }
    return path.reverse();
  }

  // Insert intermediate points so consecutive waypoints are <= maxStepM apart.
  // This pins the route to the shape outline at many points, so diagonal /
  // curved edges trace as staircases instead of being short-cut by one big
  // L-shaped Dijkstra path (which turns triangles & diamonds into boxes).
  function densify(waypoints, maxStepM) {
    if (!maxStepM || maxStepM <= 0) return waypoints;
    const out = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1], b = waypoints[i];
      const d = haversine(a, b);
      const n = Math.max(1, Math.ceil(d / maxStepM));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    return out;
  }

  // Collapse out-and-back spurs: any time the route walks to a node and comes
  // straight back the way it came (…A,B,A…), drop the detour. A stack pass
  // unwinds arbitrarily nested backtracks (like matching brackets), so a road
  // walked down and then back up cancels out entirely.
  function despur(ids) {
    const dd = [];
    for (const id of ids) if (!dd.length || dd[dd.length - 1] !== id) dd.push(id);
    const st = [];
    for (const x of dd) {
      if (st.length >= 2 && st[st.length - 2] === x) st.pop();  // …A,B + A -> …A
      else st.push(x);
    }
    return st;
  }

  function routeWaypoints(g, waypoints) {
    let nodes = waypoints.map((w) => nearestNode(g, w));
    nodes = nodes.filter((n, i) => i === 0 || n !== nodes[i - 1]); // dedupe snaps
    if (nodes.length < 2) return null;
    let ids = [];
    for (let i = 1; i < nodes.length; i++) {
      const path = dijkstra(g, nodes[i - 1], nodes[i]);
      if (!path) return null;
      const start = (ids.length && ids[ids.length - 1] === path[0]) ? 1 : 0;
      for (let k = start; k < path.length; k++) ids.push(path[k]);
    }
    ids = despur(ids);
    if (ids.length < 3) return null;
    return ids.map((id) => g.nodes.get(id));
  }

  const polyLen = (poly) => {
    let s = 0; for (let i = 1; i < poly.length; i++) s += haversine(poly[i - 1], poly[i]); return s;
  };

  // ---- placement + scoring ----------------------------------------------
  function placeShape(unit, center, radius, rotDeg, offset) {
    const { toLL } = localXY(center);
    const rot = toRad(rotDeg), c = Math.cos(rot), s = Math.sin(rot);
    const out = unit.map(([ux, uy]) => {
      const x = ux * radius + offset[0], y = uy * radius + offset[1];
      return toLL([x * c - y * s, x * s + y * c]);
    });
    out.push(out[0]);
    return out;
  }

  function segPointDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    if (L2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function segsOf(poly) {
    const s = [];
    for (let i = 1; i < poly.length; i++) s.push([poly[i - 1], poly[i]]);
    return s;
  }

  // Mean distance from points sampled along `poly` to the nearest segment in
  // `segs` (sampling ~ every `step` metres).
  function meanDistToSegs(poly, segs, step) {
    let tot = 0, cnt = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.floor(L / step));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        let m = Infinity;
        for (const [s0, s1] of segs) { const d = segPointDist(p, s0, s1); if (d < m) m = d; }
        tot += m; cnt++;
      }
    }
    return tot / Math.max(1, cnt);
  }

  // Symmetric shape-match error (metres). Averages:
  //  - how far the routed path strays from the ideal outline, and
  //  - how well the routed path COVERS the ideal outline (so a route that
  //    only traces part of the shape is penalised).
  function matchScore(center, idealLL, routedLL) {
    const { toXY } = localXY(center);
    const ideal = idealLL.map(toXY), routed = routedLL.map(toXY);
    if (ideal.length < 2 || routed.length < 2) return 1e9;
    const a = meanDistToSegs(routed, segsOf(ideal), 10);   // stray
    const b = meanDistToSegs(ideal, segsOf(routed), 10);   // coverage
    return 0.5 * (a + b);
  }

  // ---- RDP simplify -> compass legs -------------------------------------
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let dmax = 0, idx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segPointDist(pts[i], a, b);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) {
      const left = rdp(pts.slice(0, idx + 1), eps);
      const right = rdp(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  function toLegs(center, routedLL, opts) {
    opts = opts || {};
    const epsM = opts.epsM ?? 9, minSeg = opts.minSegM ?? 6, mergeDeg = opts.mergeDeg ?? 12;
    const { toXY, toLL } = localXY(center);
    const simp = rdp(routedLL.map(toXY), epsM).map(toLL);
    let legs = [];
    for (let i = 1; i < simp.length; i++) {
      const d = haversine(simp[i - 1], simp[i]);
      if (d < 0.5) continue;
      legs.push([bearingDeg(simp[i - 1], simp[i]), d, simp[i - 1], simp[i]]);
    }
    const merged = [];
    for (const leg of legs) {
      if (merged.length) {
        const prev = merged[merged.length - 1];
        let db = Math.abs(((leg[0] - prev[0]) + 180) % 360 - 180);
        if (db < mergeDeg) {
          const a = prev[2], b = leg[3];
          merged[merged.length - 1] = [bearingDeg(a, b), haversine(a, b), a, b];
          continue;
        }
      }
      merged.push(leg);
    }
    const kept = merged.filter((m) => m[1] >= minSeg);
    return {
      legs: kept.map((m) => [m[0], m[1]]),
      points: kept.length ? [kept[0][2]].concat(kept.map((m) => m[3])) : [],
    };
  }

  // ---- search ------------------------------------------------------------
  function evaluate(g, center, name, unit, radius, rot, offset, targetM, lenWeight, stepM) {
    const wp = placeShape(unit, center, radius, rot, offset);
    const routed = routeWaypoints(g, densify(wp, stepM ?? 110));
    if (!routed || routed.length < 3) return null;
    const length = polyLen(routed);
    const score = matchScore(center, wp, routed);
    const lenPen = Math.abs(length - targetM) / Math.max(1, targetM);
    const rotPen = (Math.abs(((rot + 180) % 360) - 180) / 45) ** 2;
    // Detour penalty: how much longer the routed path is than the ideal
    // outline. ~1.2-1.3x is normal road wobble; big ratios mean the snapping
    // forced ugly detours that wreck the shape.
    const idealPerim = polyLen(wp);
    const detour = idealPerim > 0 ? length / idealPerim : 1;
    const detourPen = Math.max(0, detour - 1.5);
    const cost = score + lenWeight * lenPen * 100 + rotPen * 8 + detourPen * 60;
    return { shape: name, rot, radius, offset, waypoints: wp, routed,
             length, score, detour, cost };
  }

  // Binary-search the radius that brings routed length closest to target.
  function bestRadius(g, center, name, unit, rot, offset, targetM, lenWeight, rMin, rMax, stepM) {
    let lo = rMin, hi = rMax, best = null;
    for (let it = 0; it < 7; it++) {
      const mid = (lo + hi) / 2;
      const c = evaluate(g, center, name, unit, mid, rot, offset, targetM, lenWeight, stepM);
      if (c) {
        if (!best || c.cost < best.cost) best = c;
        if (c.length < targetM) lo = mid; else hi = mid;
      } else { hi = mid; }
    }
    return best;
  }

  /* search(graph, center, opts) -> best candidate (with .legs added).
   * opts: { shapes:[names], targetM, lenWeight, rotations, offsets,
   *         rMin, rMax, onProgress(frac) } */
  function search(g, center, opts) {
    opts = opts || {};
    const shapeNames = opts.shapes || Object.keys(SHAPES);
    const targetM = opts.targetM ?? 6000;
    const lenWeight = opts.lenWeight ?? 1.0;
    const rotations = opts.rotations || [-12, 0, 12];
    const offsets = opts.offsets || [[0, 0], [0, 140], [0, -140]];
    const rMin = opts.rMin ?? 200, rMax = opts.rMax ?? 900;
    const stepM = opts.stepM ?? 110;
    const total = shapeNames.length * rotations.length * offsets.length;
    let done = 0, best = null;
    for (const name of shapeNames) {
      const unit = opts.customShape && opts.customShape.name === name
        ? opts.customShape.verts : SHAPES[name];
      if (!unit) { done += rotations.length * offsets.length; continue; }
      for (const rot of rotations)
        for (const off of offsets) {
          const c = bestRadius(g, center, name, unit, rot, off, targetM, lenWeight, rMin, rMax, stepM);
          if (c && (!best || c.cost < best.cost)) best = c;
          done++;
          if (opts.onProgress) opts.onProgress(done / total);
        }
    }
    if (best) Object.assign(best, toLegs(center, best.routed, opts));
    return best;
  }

  // Async variant that yields to the event loop so the UI can update.
  async function searchAsync(g, center, opts) {
    opts = opts || {};
    const shapeNames = opts.shapes || Object.keys(SHAPES);
    const targetM = opts.targetM ?? 6000;
    const lenWeight = opts.lenWeight ?? 1.0;
    const rotations = opts.rotations || [-12, 0, 12];
    const offsets = opts.offsets || [[0, 0], [0, 140], [0, -140]];
    const rMin = opts.rMin ?? 200, rMax = opts.rMax ?? 900;
    const stepM = opts.stepM ?? 110;
    const total = shapeNames.length * rotations.length * offsets.length;
    let done = 0, best = null;
    for (const name of shapeNames) {
      const unit = opts.customShape && opts.customShape.name === name
        ? opts.customShape.verts : SHAPES[name];
      if (!unit) { done += rotations.length * offsets.length; continue; }
      for (const rot of rotations) {
        for (const off of offsets) {
          const c = bestRadius(g, center, name, unit, rot, off, targetM, lenWeight, rMin, rMax, stepM);
          if (c && (!best || c.cost < best.cost)) best = c;
          done++;
          if (opts.onProgress) opts.onProgress(done / total, best);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (best) Object.assign(best, toLegs(center, best.routed, opts));
    return best;
  }

  // Build the Overpass query string for the ROAD network around a centre.
  function overpassQuery(center, radiusM) {
    const re = [...ROAD_TYPES].sort().join("|");
    return `[out:json][timeout:90];(way["highway"~"^(${re})$"]` +
      `(around:${Math.round(radiusM)},${center[0]},${center[1]}););` +
      `(._;>;);out body;`;
  }

  const api = {
    haversine, bearingDeg, localXY, SHAPES, star, heart,
    graphFromOSM, largestComponent, demoGrid,
    nearestNode, dijkstra, despur, routeWaypoints, polyLen,
    placeShape, matchScore, rdp, toLegs,
    evaluate, bestRadius, search, searchAsync, overpassQuery,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RouteEngine = api;
})(typeof self !== "undefined" ? self : this);
