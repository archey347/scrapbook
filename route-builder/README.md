# Bearing-compass route generator

Generates a closed walking route that **starts and finishes at the Church of
the Ascension, Oldfield Park**, sticks to real roads, fits a chosen walk
budget (default ~1.5 h), and traces out a recognisable **shape** — `cross`,
`heart`, `star`, `house`, `diamond`, `square`, `arrow`, `tent`, `tree`,
`bolt`, or an imported SVG.

Shapes are drawn boldly: the outline is **densified** before routing (extra
waypoints every ~110 m) so diagonal and curved edges trace as staircases that
actually read, instead of being short-cut into boxes. The placement search
scores each candidate on a **symmetric** shape-match (stray + coverage), a
length-budget term, an upright preference, and a detour penalty.

There are two front-ends sharing one engine:

- **`../oldfield-park-shape-route.html`** — *the main one.* A browser page (a
  copy of the Oldfield Park map) that downloads the streets and runs the whole
  search **client-side**, so it works on the static web server with no backend.
  Open it, pick shapes, hit **Generate**, then print to A4. It needs internet
  (it fetches OpenStreetMap from your browser).
- **`build_route.py`** — a command-line version of the same pipeline, for
  generating files offline/in batch. Documented below.
- **`route-engine.js`** — the shared, DOM-free engine (graph build, snapping,
  Dijkstra, placement search, scoring, simplify-to-legs). Loaded by the page;
  also runnable in Node for testing.

It also pairs with the manual builder (`../oldfield-park-bearings.html`) — the
generator produces a course automatically; the builder lets you tweak by hand.

## How it works

1. **Geocode** the church (or pass `--church "lat,lng"`).
2. **Download** the walkable street network around it from OpenStreetMap
   (Overpass) and build a graph (edges weighted by length).
3. **Search placements**: for each shape it sweeps rotation × scale × offset,
   snaps every shape vertex to the nearest road node, routes each leg along
   roads (Dijkstra), then **scores** the result on
   *how closely the routed path matches the ideal shape* + *how close the
   total length is to the budget* (upright shapes preferred). Best wins.
4. **Simplify** the routed path into turn-by-turn **(bearing, distance)** legs.
5. **Write** three files:
   - `<out>.geojson` — full road-following route + the snapped shape outline
   - `<out>.directions.txt` — the numbered compass course
   - `<out>.html` — a copy of the Oldfield Park map with the route baked in
     and the directions listed (print to A4 like the other maps)

## Usage

```bash
pip install requests networkx numpy
# optional, only for --svg import:
pip install svgpathtools

# Try several shapes, keep the closest match, ~90 min budget:
python3 build_route.py \
    --church "51.374094,-2.382752" \
    --shapes tent,house,tree,star,heart \
    --minutes 90 \
    --out oldfield-park-route

# Force one shape, round bearings to 5° (kinder for compass work):
python3 build_route.py --church "51.374094,-2.382752" --shapes house --round5

# Import your own outline (e.g. a tree SVG) and match it to the streets:
python3 build_route.py --church "51.374094,-2.382752" --svg shapes/tree.svg
```

Useful flags: `--pace` (km/h, default 4.6), `--max-radius-m` (graph reach /
biggest shape, default 1300), `--len-weight` (length-budget vs shape-fit),
`--save-graph cache.json` / `--graph cache.json` (cache the OSM download so you
can iterate shapes offline), `--demo-grid` (synthetic street lattice, no
network — for testing the pipeline).

## Iterating to a close match

The search already iterates internally. To explore further: cache the network
once (`--save-graph bath.json`), then re-run with `--graph bath.json` over
different `--shapes`, `--svg` files, `--minutes`, and `--len-weight` values —
each run prints the best candidate's deviation (`dev`, mean metres off the
ideal outline) and length so you can compare matches quickly.

## Network requirement

The data steps need OpenStreetMap hosts (`nominatim.openstreetmap.org`,
`overpass-api.de`). In restricted sandboxes these are blocked, so run the
generator on a machine with internet — or cache the graph there once with
`--save-graph` and copy the JSON in. `--demo-grid` runs fully offline but only
draws on a synthetic grid, not real Bath streets.
