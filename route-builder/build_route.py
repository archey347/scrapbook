#!/usr/bin/env python3
"""
Bearing-compass route generator for Oldfield Park, Bath.

Goal: produce a closed walking route that starts/ends at the Church of the
Ascension, sticks to real roads, fits inside a ~1.5 hour walk, and traces out
a recognisable shape (tent / house / tree / star / heart, or any imported SVG).

Pipeline
--------
1. Geocode the church (Nominatim) or take --church "lat,lng".
2. Download the walkable street network around it (Overpass) and build a graph.
3. For a target shape, try many placements (rotation x scale x offset),
   snap each shape vertex to the nearest road node, route the legs along roads
   with Dijkstra, and SCORE how closely the routed path matches the ideal
   shape and the length budget. Keep the best candidate.
4. Optionally sweep several shapes and keep the overall best match.
5. Emit:
     - <out>.geojson         full road-following route + waypoints
     - <out>.directions.txt  the compass course: numbered (bearing, distance)
     - <out>.html            a copy of the Oldfield Park map with the route
                             baked in and the directions listed.

Network note
------------
Nominatim/Overpass must be reachable. In sandboxes where OSM hosts are blocked,
run this on a machine with internet, or pass --graph cache.json after caching
once with --save-graph cache.json. A --demo-grid mode builds a synthetic street
lattice so the rest of the pipeline can be exercised offline.
"""

import argparse, json, math, sys, time
from dataclasses import dataclass, field

# ----------------------------------------------------------------------------
# Geometry helpers
# ----------------------------------------------------------------------------
R_EARTH = 6371000.0

def haversine(a, b):
    """a, b = (lat, lng) in degrees -> metres."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dlam = math.radians(b[1] - a[1])
    h = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlam/2)**2
    return 2*R_EARTH*math.asin(min(1.0, math.sqrt(h)))

def bearing(a, b):
    """True bearing a->b, 0..360, 0=N, 90=E."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dlam = math.radians(b[1] - a[1])
    y = math.sin(dlam)*math.cos(p2)
    x = math.cos(p1)*math.sin(p2) - math.sin(p1)*math.cos(p2)*math.cos(dlam)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0

def local_xy(center):
    """Return (to_xy, to_ll): equirectangular projection around center, metres."""
    lat0 = math.radians(center[0])
    mlat = 111320.0
    mlon = 111320.0 * math.cos(lat0)
    def to_xy(ll):
        return ((ll[1]-center[1])*mlon, (ll[0]-center[0])*mlat)
    def to_ll(xy):
        return (center[0] + xy[1]/mlat, center[1] + xy[0]/mlon)
    return to_xy, to_ll


# ----------------------------------------------------------------------------
# Shape library  (closed rings in unit space: x right, y up, ~[-1,1])
# First vertex is the church "anchor" (bottom-centre) so the route starts/ends
# there. The ring is implicitly closed back to the first vertex.
# ----------------------------------------------------------------------------
def _star(points=5, r_out=1.0, r_in=0.42):
    verts = []
    for i in range(points*2):
        ang = math.pi/2 + i*math.pi/points          # start at top
        r = r_out if i % 2 == 0 else r_in
        verts.append((r*math.cos(ang), r*math.sin(ang)))
    # rotate list so it starts near bottom-centre
    lo = min(range(len(verts)), key=lambda i: (verts[i][1], abs(verts[i][0])))
    verts = verts[lo:] + verts[:lo]
    return [(0, min(v[1] for v in verts))] + verts

def _heart(n=24):
    pts = []
    for i in range(n):
        t = math.pi - 2*math.pi*i/n                 # go around once
        x = 16*math.sin(t)**3
        y = 13*math.cos(t) - 5*math.cos(2*t) - 2*math.cos(3*t) - math.cos(4*t)
        pts.append((x/16.0, y/16.0))
    # bottom tip first
    lo = min(range(len(pts)), key=lambda i: pts[i][1])
    pts = pts[lo:] + pts[:lo]
    return pts

# Bold, few-vertex outlines read best once snapped to the street grid. Each is
# a closed ring; the FIRST vertex is the church anchor (bottom-centre).
SHAPES = {
    "diamond": [(0,-1), (-1,0), (0,1), (1,0)],
    "square":  [(0,-1), (-1,-1), (-1,1), (1,1), (1,-1)],
    "arrow":   [(0,-1), (-0.33,-1), (-0.33,0.2), (-0.66,0.2),
                (0,1), (0.66,0.2), (0.33,0.2), (0.33,-1)],
    "cross":   [(0,-1), (-0.34,-1), (-0.34,-0.34), (-1,-0.34),
                (-1,0.34), (-0.34,0.34), (-0.34,1), (0.34,1),
                (0.34,0.34), (1,0.34), (1,-0.34), (0.34,-0.34), (0.34,-1)],
    "bolt":    [(0,-1), (-0.15,-1), (0.25,-0.1), (-0.1,-0.1),
                (0.15,1), (-0.45,0.0), (0.0,0.0), (-0.35,-1)],
    # apex-up triangle, church at base midpoint
    "tent":  [(0,-0.85), (-1,-0.85), (0,1), (1,-0.85)],
    # square box + roof, church at bottom-centre
    "house": [(0,-1), (-1,-1), (-1,0.15), (0,1), (1,0.15), (1,-1)],
    # christmas tree with a trunk; church at the trunk base
    "tree":  [(0,-1.0), (0.16,-1.0), (0.16,-0.55), (0.62,-0.55),
              (0.30,-0.18), (0.50,-0.18), (0.22,0.22), (0.40,0.22),
              (0.0,0.95),
              (-0.40,0.22), (-0.22,0.22), (-0.50,-0.18), (-0.30,-0.18),
              (-0.62,-0.55), (-0.16,-0.55), (-0.16,-1.0)],
    "star":  _star(),
    "heart": _heart(),
}

def svg_shape(path):
    """Sample an SVG path into a closed unit ring (needs svgpathtools)."""
    from svgpathtools import svg2paths
    paths, _ = svg2paths(path)
    if not paths:
        raise ValueError("no paths in SVG")
    p = max(paths, key=lambda pp: pp.length())     # biggest path = outline
    n = 120
    pts = []
    for i in range(n):
        z = p.point(i/n)
        pts.append((z.real, -z.imag))              # SVG y is down -> flip
    # normalise to [-1,1] centred
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    cx = (min(xs)+max(xs))/2; cy = (min(ys)+max(ys))/2
    s = max(max(xs)-min(xs), max(ys)-min(ys))/2 or 1.0
    pts = [((x-cx)/s, (y-cy)/s) for x, y in pts]
    lo = min(range(len(pts)), key=lambda i: pts[i][1])
    pts = pts[lo:] + pts[:lo]
    return [(0, min(q[1] for q in pts))] + pts


# ----------------------------------------------------------------------------
# Street graph
# ----------------------------------------------------------------------------
# ROADS ONLY: named carriageways you'd walk along — no footways, paths,
# cycleways, steps, tracks, service roads or pedestrian precincts.
ROAD_TYPES = {"primary", "primary_link", "secondary", "secondary_link",
              "tertiary", "tertiary_link", "unclassified", "residential",
              "living_street", "road"}

def fetch_graph(center, radius_m):
    import requests, networkx as nx
    lat, lng = center
    road_re = "|".join(sorted(ROAD_TYPES))
    q = f"""
    [out:json][timeout:90];
    (way["highway"~"^({road_re})$"](around:{radius_m},{lat},{lng}););
    (._;>;);
    out body;
    """
    for host in ("https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"):
        try:
            r = requests.post(host, data={"data": q}, timeout=120,
                              headers={"User-Agent": "oldfield-route/1.0"})
            r.raise_for_status()
            return _graph_from_osm(r.json())
        except Exception as e:
            print(f"  overpass {host} failed: {e}", file=sys.stderr)
    raise SystemExit("Could not reach any Overpass endpoint.")

def _graph_from_osm(data):
    import networkx as nx
    nodes = {}
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
    G = nx.Graph()
    for el in data["elements"]:
        if el["type"] != "way":
            continue
        hw = el.get("tags", {}).get("highway")
        if not hw or hw not in ROAD_TYPES:
            continue
        nd = el["nodes"]
        for a, b in zip(nd, nd[1:]):
            if a in nodes and b in nodes:
                w = haversine(nodes[a], nodes[b])
                G.add_node(a, lat=nodes[a][0], lng=nodes[a][1])
                G.add_node(b, lat=nodes[b][0], lng=nodes[b][1])
                G.add_edge(a, b, weight=w)
    return _largest_component(G)

def demo_grid(center, radius_m, spacing=55.0):
    """Synthetic street lattice for offline testing."""
    import networkx as nx
    to_xy, to_ll = local_xy(center)
    n = int(radius_m/spacing)
    G = nx.Graph()
    def nid(i, j): return i*10000 + j
    for i in range(-n, n+1):
        for j in range(-n, n+1):
            ll = to_ll((i*spacing, j*spacing))
            G.add_node(nid(i, j), lat=ll[0], lng=ll[1])
    for i in range(-n, n+1):
        for j in range(-n, n+1):
            for di, dj in ((1, 0), (0, 1)):
                a, b = nid(i, j), nid(i+di, j+dj)
                if G.has_node(a) and G.has_node(b):
                    G.add_edge(a, b, weight=haversine(
                        (G.nodes[a]["lat"], G.nodes[a]["lng"]),
                        (G.nodes[b]["lat"], G.nodes[b]["lng"])))
    return _largest_component(G)

def _largest_component(G):
    import networkx as nx
    if G.number_of_nodes() == 0:
        raise SystemExit("Empty street graph.")
    comp = max(nx.connected_components(G), key=len)
    return G.subgraph(comp).copy()


# ----------------------------------------------------------------------------
# Routing
# ----------------------------------------------------------------------------
def nearest_node(G, ll):
    best, bd = None, 1e18
    for n, d in G.nodes(data=True):
        dd = haversine(ll, (d["lat"], d["lng"]))
        if dd < bd:
            best, bd = n, dd
    return best

def densify(waypoints, max_step_m):
    """Insert intermediate points so consecutive waypoints are <= max_step_m
    apart, pinning the route to the outline so diagonals trace as staircases
    instead of being short-cut into boxes by Dijkstra."""
    if not max_step_m or max_step_m <= 0:
        return waypoints
    out = [waypoints[0]]
    for a, b in zip(waypoints, waypoints[1:]):
        d = haversine(a, b)
        n = max(1, math.ceil(d / max_step_m))
        for k in range(1, n + 1):
            t = k / n
            out.append((a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])))
    return out

def _despur(ids):
    """Collapse out-and-back spurs (…A,B,A… -> …A…). A stack pass unwinds
    arbitrarily nested backtracks, so a road walked down then back cancels."""
    dd = []
    for i in ids:
        if not dd or dd[-1] != i:
            dd.append(i)
    st = []
    for x in dd:
        if len(st) >= 2 and st[-2] == x:
            st.pop()
        else:
            st.append(x)
    return st

def route_waypoints(G, waypoints):
    """waypoints: list of (lat,lng). Returns full polyline [(lat,lng)...]."""
    import networkx as nx
    nodes = [nearest_node(G, w) for w in waypoints]
    nodes = [n for i, n in enumerate(nodes) if i == 0 or n != nodes[i-1]]
    if len(nodes) < 2:
        return None
    ids = []
    for a, b in zip(nodes, nodes[1:]):
        try:
            path = nx.dijkstra_path(G, a, b, weight="weight")
        except nx.NetworkXNoPath:
            return None
        if ids and ids[-1] == path[0]:
            path = path[1:]
        ids.extend(path)
    ids = _despur(ids)
    if len(ids) < 3:
        return None
    return [(G.nodes[p]["lat"], G.nodes[p]["lng"]) for p in ids]

def polyline_length(poly):
    return sum(haversine(a, b) for a, b in zip(poly, poly[1:]))


# ----------------------------------------------------------------------------
# Placement + scoring
# ----------------------------------------------------------------------------
def place_shape(unit_verts, center, radius_m, rot_deg, offset_xy):
    """Map unit ring -> list of (lat,lng) waypoints, closed loop ending at start."""
    to_xy, to_ll = local_xy(center)
    rot = math.radians(rot_deg)
    cos, sin = math.cos(rot), math.sin(rot)
    out = []
    for (ux, uy) in unit_verts:
        x = ux*radius_m + offset_xy[0]
        y = uy*radius_m + offset_xy[1]
        xr = x*cos - y*sin
        yr = x*sin + y*cos
        out.append(to_ll((xr, yr)))
    out.append(out[0])                              # close
    return out

def _seg_point_dist(p, a, b):
    """Distance from point p to segment ab, all in planar xy."""
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx-ax, by-ay
    L2 = dx*dx + dy*dy
    if L2 == 0:
        return math.hypot(px-ax, py-ay)
    t = max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy)/L2))
    cx, cy = ax+t*dx, ay+t*dy
    return math.hypot(px-cx, py-cy)

def _mean_dist_to_segs(poly, segs, step=10.0):
    tot = 0.0; cnt = 0
    for (a, b) in zip(poly, poly[1:]):
        L = math.hypot(b[0]-a[0], b[1]-a[1])
        steps = max(1, int(L/step))
        for k in range(steps):
            t = k/steps
            p = (a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]))
            tot += min(_seg_point_dist(p, s0, s1) for s0, s1 in segs)
            cnt += 1
    return tot/max(1, cnt)

def match_score(center, ideal_ll, routed_ll):
    """Symmetric shape-match error (m): how far the route strays from the ideal
    outline AND how well it covers it. Lower is a closer match."""
    to_xy, _ = local_xy(center)
    ideal = [to_xy(p) for p in ideal_ll]
    routed = [to_xy(p) for p in routed_ll]
    if len(ideal) < 2 or len(routed) < 2:
        return 1e9
    iseg = list(zip(ideal, ideal[1:]))
    rseg = list(zip(routed, routed[1:]))
    return 0.5 * (_mean_dist_to_segs(routed, iseg) + _mean_dist_to_segs(ideal, rseg))

@dataclass
class Candidate:
    shape: str
    rot: float
    radius: float
    offset: tuple
    waypoints: list
    routed: list
    length: float
    score: float
    cost: float

def evaluate(G, center, shape_name, unit_verts, radius, rot, offset,
             target_m, len_weight, step_m=110.0):
    wp = place_shape(unit_verts, center, radius, rot, offset)
    routed = route_waypoints(G, densify(wp, step_m))
    if not routed or len(routed) < 3:
        return None
    length = polyline_length(routed)
    score = match_score(center, wp, routed)
    # length penalty: fraction over/under target, in metres-equivalent
    len_pen = abs(length - target_m) / max(1.0, target_m)
    # Prefer upright shapes: deviation is rotation-invariant (the ideal is
    # rotated with the route), so without this the optimiser tilts shapes
    # arbitrarily. A tree tilted 45deg is not a tree.
    rot_pen = (abs(((rot + 180) % 360) - 180) / 45.0) ** 2
    # Detour penalty: how much longer the route is than the ideal outline.
    ideal_perim = polyline_length(wp)
    detour = length / ideal_perim if ideal_perim > 0 else 1.0
    detour_pen = max(0.0, detour - 1.5)
    cost = (score + len_weight * len_pen * 100.0
            + rot_pen * 8.0 + detour_pen * 60.0)
    return Candidate(shape_name, rot, radius, offset, wp, routed,
                     length, score, cost)

def search(G, center, shapes, target_m, radii, rotations, offsets, len_weight,
           verbose=True):
    best = None
    tried = 0
    for name, verts in shapes:
        for radius in radii:
            for rot in rotations:
                for off in offsets:
                    c = evaluate(G, center, name, verts, radius, rot, off,
                                 target_m, len_weight)
                    tried += 1
                    if c and (best is None or c.cost < best.cost):
                        best = c
                        if verbose:
                            print(f"  [{name}] r={radius:.0f}m rot={rot:3.0f} "
                                  f"off=({off[0]:.0f},{off[1]:.0f}) "
                                  f"len={c.length:.0f}m dev={c.score:.0f}m "
                                  f"cost={c.cost:.1f}")
    if verbose:
        print(f"  evaluated {tried} candidates")
    return best


# ----------------------------------------------------------------------------
# Simplify routed path -> compass legs (turn-by-turn bearings + distances)
# ----------------------------------------------------------------------------
def rdp(points_xy, eps):
    if len(points_xy) < 3:
        return points_xy[:]
    dmax, idx = 0.0, 0
    a, b = points_xy[0], points_xy[-1]
    for i in range(1, len(points_xy)-1):
        d = _seg_point_dist(points_xy[i], a, b)
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = rdp(points_xy[:idx+1], eps)
        right = rdp(points_xy[idx:], eps)
        return left[:-1] + right
    return [a, b]

def to_legs(center, routed_ll, eps_m=9.0, min_seg_m=6.0, merge_deg=12.0):
    to_xy, to_ll = local_xy(center)
    xy = [to_xy(p) for p in routed_ll]
    simp_xy = rdp(xy, eps_m)
    simp = [to_ll(p) for p in simp_xy]
    # build raw legs
    legs = []
    for a, b in zip(simp, simp[1:]):
        d = haversine(a, b)
        if d < 0.5:
            continue
        legs.append([bearing(a, b), d, a, b])
    # merge consecutive near-collinear legs
    merged = []
    for leg in legs:
        if merged:
            db = abs(((leg[0]-merged[-1][0]) + 180) % 360 - 180)
            if db < merge_deg:
                # extend previous
                a = merged[-1][2]; b = leg[3]
                merged[-1] = [bearing(a, b), haversine(a, b), a, b]
                continue
        merged.append(leg)
    # drop tiny slivers
    merged = [m for m in merged if m[1] >= min_seg_m]
    return [(b, d) for b, d, _, _ in merged], simp


# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------
def fmt_bearing(deg, round5=False):
    b = round(deg/5)*5 % 360 if round5 else round(deg)
    return f"{b:03d}°"

def fmt_dist(m):
    return f"{m:.0f} m"

def write_geojson(path, routed, waypoints, legs_pts):
    feats = [{
        "type": "Feature",
        "properties": {"name": "route", "length_m": round(polyline_length(routed))},
        "geometry": {"type": "LineString",
                     "coordinates": [[ll[1], ll[0]] for ll in routed]},
    }, {
        "type": "Feature",
        "properties": {"name": "shape-waypoints"},
        "geometry": {"type": "LineString",
                     "coordinates": [[ll[1], ll[0]] for ll in waypoints]},
    }]
    json.dump({"type": "FeatureCollection", "features": feats},
              open(path, "w"), indent=1)

def write_directions(path, legs, total, minutes, shape, round5):
    lines = [f"Bearing-compass course  ({shape})",
             f"Start & finish: Church of the Ascension, Oldfield Park",
             f"{len(legs)} legs  ·  {total:.0f} m total  ·  ~{minutes:.0f} min walk",
             ""]
    for i, (b, d) in enumerate(legs, 1):
        lines.append(f"{i:2d}.  {fmt_bearing(b, round5)}   {fmt_dist(d)}")
    open(path, "w").write("\n".join(lines) + "\n")


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Oldfield Park, Bath — Compass Course (__SHAPE__)</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""/>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  html, body { margin:0; padding:0; background:#ddd;
    font-family:"Helvetica Neue",Arial,sans-serif; color:#111; }
  body { display:flex; justify-content:center; padding:12px; }
  .sheet { width:190mm; height:277mm; background:#fff; box-sizing:border-box;
    position:relative; box-shadow:0 2px 14px rgba(0,0,0,.18);
    display:flex; flex-direction:column; }
  @media print { html,body{background:#fff;padding:0;}
    .sheet{box-shadow:none;width:190mm;height:277mm;} .no-print{display:none!important;} }
  .header { text-align:center; padding:2mm 0 1mm; border-bottom:.4mm solid #222; }
  .header h1 { font-size:14pt; margin:0; letter-spacing:.04em; text-transform:uppercase; }
  .header .sub { font-size:8pt; color:#444; margin-top:.5mm; }
  .map-block { --gutter:7mm; position:relative; width:190mm; height:170mm; margin:4mm 0 0 0; }
  .map-frame { position:absolute; top:var(--gutter); left:var(--gutter);
    width:calc(100% - 2*var(--gutter)); height:calc(100% - 2*var(--gutter));
    border:.4mm solid #111; overflow:hidden; background:#f7f4ec; }
  #map { width:100%; height:100%; }
  .grid-overlay { position:absolute; inset:0; pointer-events:none;
    width:100%; height:100%; z-index:800; }
  .axis { position:absolute; color:#111; font-size:8.5pt; font-weight:600;
    pointer-events:none; font-variant-numeric:tabular-nums; }
  .axis-x-top,.axis-x-bot { left:var(--gutter); width:calc(100% - 2*var(--gutter)); height:var(--gutter); }
  .axis-x-top{top:0;} .axis-x-bot{bottom:0;}
  .axis-y-left,.axis-y-right { top:var(--gutter); height:calc(100% - 2*var(--gutter)); width:var(--gutter); }
  .axis-y-left{left:0;} .axis-y-right{right:0;}
  .axis .lbl { position:absolute; line-height:1; }
  .axis-x-top .lbl{bottom:1mm;transform:translateX(-50%);}
  .axis-x-bot .lbl{top:1mm;transform:translateX(-50%);}
  .axis-y-left .lbl{right:1mm;transform:translateY(-50%);}
  .axis-y-right .lbl{left:1mm;transform:translateY(-50%);}
  .footer { padding:2mm 4mm; font-size:7.5pt; color:#333;
    display:flex; justify-content:space-between; border-top:.4mm solid #222; }
  .directions { padding:2mm 6mm 3mm; font-size:8.5pt; column-count:3; column-gap:8mm;
    font-variant-numeric:tabular-nums; }
  .directions h2 { font-size:9pt; margin:0 0 1mm; column-span:all;
    border-bottom:.3mm solid #999; padding-bottom:1mm; }
  .directions ol { margin:0; padding-left:7mm; }
  .directions li { margin:.4mm 0; break-inside:avoid; }
  .route-marker { background:#1565c0; color:#fff; border:2px solid #fff;
    border-radius:50%; width:18px; height:18px; line-height:14px; text-align:center;
    font-size:9px; font-weight:700; box-shadow:0 1px 2px rgba(0,0,0,.4); }
  .route-marker.startpt { background:#2e7d32; width:24px; height:24px; line-height:20px; font-size:10px; }
  .leg-label { background:rgba(255,255,255,.85); border:1px solid #1565c0;
    border-radius:3px; padding:0 3px; font-size:8.5px; font-weight:700;
    color:#0d2f57; white-space:nowrap; font-variant-numeric:tabular-nums; }
  @media print { .leaflet-control-container{display:none;} }
</style>
</head>
<body>
<div class="sheet">
  <div class="header">
    <h1>Oldfield Park, Bath — Compass Course</h1>
    <div class="sub">Shape: __SHAPE__ · start &amp; finish at the Church of the Ascension · __TOTAL__ m · ~__MINS__ min</div>
  </div>
  <div class="map-block">
    <div class="map-frame">
      <div id="map"></div>
      <svg class="grid-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        <g stroke="#000" stroke-opacity="0.45" stroke-width="1" fill="none" vector-effect="non-scaling-stroke">
          <line x1="100" y1="0" x2="100" y2="1000"/><line x1="200" y1="0" x2="200" y2="1000"/>
          <line x1="300" y1="0" x2="300" y2="1000"/><line x1="400" y1="0" x2="400" y2="1000"/>
          <line x1="500" y1="0" x2="500" y2="1000"/><line x1="600" y1="0" x2="600" y2="1000"/>
          <line x1="700" y1="0" x2="700" y2="1000"/><line x1="800" y1="0" x2="800" y2="1000"/>
          <line x1="900" y1="0" x2="900" y2="1000"/>
          <line y1="100" x1="0" y2="100" x2="1000"/><line y1="200" x1="0" y2="200" x2="1000"/>
          <line y1="300" x1="0" y2="300" x2="1000"/><line y1="400" x1="0" y2="400" x2="1000"/>
          <line y1="500" x1="0" y2="500" x2="1000"/><line y1="600" x1="0" y2="600" x2="1000"/>
          <line y1="700" x1="0" y2="700" x2="1000"/><line y1="800" x1="0" y2="800" x2="1000"/>
          <line y1="900" x1="0" y2="900" x2="1000"/>
        </g>
        <g stroke="#c00" stroke-width="1.6" fill="none" vector-effect="non-scaling-stroke">
          <line x1="490" y1="500" x2="510" y2="500"/><line x1="500" y1="490" x2="500" y2="510"/>
          <circle cx="500" cy="500" r="3" fill="#c00" stroke="none"/>
        </g>
      </svg>
    </div>
    <div class="axis axis-x-top"><div class="lbl" style="left:10%">1</div><div class="lbl" style="left:20%">2</div><div class="lbl" style="left:30%">3</div><div class="lbl" style="left:40%">4</div><div class="lbl" style="left:50%">5</div><div class="lbl" style="left:60%">6</div><div class="lbl" style="left:70%">7</div><div class="lbl" style="left:80%">8</div><div class="lbl" style="left:90%">9</div></div>
    <div class="axis axis-x-bot"><div class="lbl" style="left:10%">1</div><div class="lbl" style="left:20%">2</div><div class="lbl" style="left:30%">3</div><div class="lbl" style="left:40%">4</div><div class="lbl" style="left:50%">5</div><div class="lbl" style="left:60%">6</div><div class="lbl" style="left:70%">7</div><div class="lbl" style="left:80%">8</div><div class="lbl" style="left:90%">9</div></div>
    <div class="axis axis-y-left"><div class="lbl" style="top:90%">1</div><div class="lbl" style="top:80%">2</div><div class="lbl" style="top:70%">3</div><div class="lbl" style="top:60%">4</div><div class="lbl" style="top:50%">5</div><div class="lbl" style="top:40%">6</div><div class="lbl" style="top:30%">7</div><div class="lbl" style="top:20%">8</div><div class="lbl" style="top:10%">9</div></div>
    <div class="axis axis-y-right"><div class="lbl" style="top:90%">1</div><div class="lbl" style="top:80%">2</div><div class="lbl" style="top:70%">3</div><div class="lbl" style="top:60%">4</div><div class="lbl" style="top:50%">5</div><div class="lbl" style="top:40%">6</div><div class="lbl" style="top:30%">7</div><div class="lbl" style="top:20%">8</div><div class="lbl" style="top:10%">9</div></div>
  </div>
  <div class="directions">
    <h2>Compass course — walk each leg on its bearing for the given distance</h2>
    <ol id="dirs"></ol>
  </div>
  <div class="footer">
    <div>Map data © OpenStreetMap contributors, ODbL.</div>
    <div>Bearings are true (grid north). __NLEGS__ legs · __TOTAL__ m.</div>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
        crossorigin=""></script>
<script>
  const CENTER = __CENTER__;
  const RANGE_M = __RANGE__;
  const ROUTE  = __ROUTE__;          // [[lat,lng],...]
  const WAYPTS = __WAYPTS__;         // simplified turn points [[lat,lng],...]
  const LEGS   = __LEGS__;           // [[bearingDeg, distM],...]

  const map = L.map('map', { zoomControl:false, attributionControl:false,
    scrollWheelZoom:true, doubleClickZoom:false, boxZoom:false, keyboard:false,
    zoomSnap:0, zoomDelta:0.5, fadeAnimation:false });

  function fitSquare() {
    const side = Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight);
    const mpp = RANGE_M/side;
    const z = Math.log2(156543.03392*Math.cos(CENTER[0]*Math.PI/180)/mpp);
    map.setView(CENTER, Math.min(z,19), {animate:false});
  }
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:19, crossOrigin:true}).addTo(map);
  fitSquare();
  setTimeout(()=>{map.invalidateSize();fitSquare();},200);
  setTimeout(()=>{map.invalidateSize();fitSquare();},800);

  // route
  L.polyline(ROUTE, {color:'#1565c0', weight:4, opacity:.9}).addTo(map);

  // turn markers + leg labels
  WAYPTS.forEach((p,i)=>{
    const start = (i===0);
    L.marker(p,{icon:L.divIcon({className:'',
      html:`<div class="route-marker ${start?'startpt':''}">${start?'S':i}</div>`,
      iconSize:start?[24,24]:[18,18], iconAnchor:start?[12,12]:[9,9]})}).addTo(map);
  });
  for (let i=0;i<LEGS.length && i+1<WAYPTS.length;i++){
    const a=WAYPTS[i], b=WAYPTS[i+1];
    const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    const bd=String(Math.round(LEGS[i][0])).padStart(3,'0');
    L.marker(mid,{interactive:false,icon:L.divIcon({className:'',
      html:`<div class="leg-label">${i+1}: ${bd}° ${Math.round(LEGS[i][1])}m</div>`,
      iconSize:[0,0]})}).addTo(map);
  }

  // directions list
  const ol=document.getElementById('dirs');
  LEGS.forEach(([b,d])=>{
    const li=document.createElement('li');
    li.textContent = String(Math.round(b)).padStart(3,'0')+'°  —  '+Math.round(d)+' m';
    ol.appendChild(li);
  });

  let saved=null;
  addEventListener('beforeprint',()=>{saved={c:map.getCenter(),z:map.getZoom()};map.invalidateSize();fitSquare();});
  addEventListener('afterprint',()=>{if(saved){map.setView(saved.c,saved.z,{animate:false});saved=null;}});
  addEventListener('resize',()=>map.invalidateSize());
</script>
</body>
</html>
"""

def write_html(path, center, range_m, routed, waypts, legs, shape, total, minutes):
    def fnum(x): return f"{x:.6f}"
    repl = {
        "__SHAPE__": shape,
        "__TOTAL__": f"{total:.0f}",
        "__MINS__": f"{minutes:.0f}",
        "__NLEGS__": str(len(legs)),
        "__CENTER__": f"[{fnum(center[0])},{fnum(center[1])}]",
        "__RANGE__": f"{range_m:.1f}",
        "__ROUTE__": json.dumps([[round(p[0],6),round(p[1],6)] for p in routed]),
        "__WAYPTS__": json.dumps([[round(p[0],6),round(p[1],6)] for p in waypts]),
        "__LEGS__": json.dumps([[round(b,1),round(d,1)] for b,d in legs]),
    }
    html = HTML_TEMPLATE
    for k, v in repl.items():
        html = html.replace(k, v)
    open(path, "w").write(html)


# ----------------------------------------------------------------------------
# Driver
# ----------------------------------------------------------------------------
DEFAULT_CHURCH = (51.374094, -2.382752)  # Church of the Ascension, Oldfield Park (user-supplied)

def geocode_church():
    import requests
    r = requests.get("https://nominatim.openstreetmap.org/search",
                     params={"q": "Church of the Ascension, Oldfield Park, Bath",
                             "format": "json", "limit": 1},
                     headers={"User-Agent": "oldfield-route/1.0"}, timeout=30)
    r.raise_for_status()
    j = r.json()
    if not j:
        raise SystemExit("Church not found via Nominatim; pass --church lat,lng")
    return (float(j[0]["lat"]), float(j[0]["lon"]))

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--church", help='lat,lng of the church (skip geocoding)')
    ap.add_argument("--shapes", default="cross,heart,star,house,diamond,arrow,tent,tree",
                    help="comma list of built-in shapes to try")
    ap.add_argument("--svg", help="import an SVG outline as the shape")
    ap.add_argument("--minutes", type=float, default=90.0, help="walk budget")
    ap.add_argument("--pace", type=float, default=4.6, help="km/h walking pace")
    ap.add_argument("--max-radius-m", type=float, default=1300.0,
                    help="graph download radius / max shape reach")
    ap.add_argument("--len-weight", type=float, default=1.0,
                    help="weight of length-budget penalty vs shape fit")
    ap.add_argument("--round5", action="store_true", help="round bearings to 5deg")
    ap.add_argument("--out", default="oldfield-park-route", help="output basename")
    ap.add_argument("--demo-grid", action="store_true",
                    help="use a synthetic street lattice (offline test)")
    ap.add_argument("--save-graph", help="cache the fetched graph to JSON")
    ap.add_argument("--graph", help="load a cached graph JSON instead of fetching")
    args = ap.parse_args()

    if args.church:
        center = tuple(float(x) for x in args.church.split(","))
    elif args.demo_grid:
        center = DEFAULT_CHURCH
    else:
        print("Geocoding church...")
        center = geocode_church()
    print(f"Church: {center[0]:.5f}, {center[1]:.5f}")

    target_m = args.pace * 1000.0 / 60.0 * args.minutes
    print(f"Target route length ~{target_m:.0f} m for {args.minutes:.0f} min @ {args.pace} km/h")

    # graph
    import networkx as nx
    if args.graph:
        data = json.load(open(args.graph))
        G = nx.node_link_graph(data, edges="links")
    elif args.demo_grid:
        print("Building synthetic demo grid...")
        G = demo_grid(center, args.max_radius_m)
    else:
        print("Fetching street network (Overpass)...")
        G = fetch_graph(center, args.max_radius_m)
    print(f"Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    if args.save_graph:
        json.dump(nx.node_link_data(G, edges="links"), open(args.save_graph, "w"))

    # shapes
    if args.svg:
        shapes = [(args.svg.split("/")[-1].rsplit(".",1)[0], svg_shape(args.svg))]
    else:
        shapes = [(s, SHAPES[s]) for s in args.shapes.split(",") if s in SHAPES]
    if not shapes:
        raise SystemExit("No valid shapes selected.")

    # placement search space
    radii = [r for r in (300, 400, 500, 600, 700, 800) if r <= args.max_radius_m]
    # Keep shapes roughly upright; small tilts let the shape settle onto the
    # street grid without becoming unrecognisable.
    rotations = [-20, -10, 0, 10, 20]
    offsets = [(0, 0), (0, 150), (0, -150), (150, 0), (-150, 0)]

    print("Searching placements...")
    best = search(G, center, shapes, target_m, radii, rotations, offsets,
                  args.len_weight)
    if not best:
        raise SystemExit("No routable candidate found.")

    print(f"\nBest: shape={best.shape} radius={best.radius:.0f}m rot={best.rot:.0f} "
          f"offset={best.offset} length={best.length:.0f}m dev={best.score:.1f}m")

    legs, simp = to_legs(center, best.routed)
    total = best.length
    minutes = total/1000.0/args.pace*60.0

    # fit map square to the route bounds (+margin), keep church centred-ish
    to_xy, _ = local_xy(center)
    xs = [abs(to_xy(p)[0]) for p in best.routed]
    ys = [abs(to_xy(p)[1]) for p in best.routed]
    reach = max(max(xs), max(ys)) if xs else 400
    range_m = max(400.0, reach*2*1.15)

    write_geojson(args.out + ".geojson", best.routed, best.waypoints, simp)
    write_directions(args.out + ".directions.txt", legs, total, minutes,
                     best.shape, args.round5)
    write_html(args.out + ".html", center, range_m, best.routed, simp, legs,
               best.shape, total, minutes)

    print(f"\nWrote:\n  {args.out}.geojson\n  {args.out}.directions.txt\n  {args.out}.html")
    print(f"Course: {best.shape} · {len(legs)} legs · {total:.0f} m · ~{minutes:.0f} min")

if __name__ == "__main__":
    main()
