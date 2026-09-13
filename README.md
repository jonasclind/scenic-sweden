# Scenic View Finder — Sweden

Find locations with long, open, water-facing views, for picking a plot to build on or a spot
to watch a sunset. See [PLAN.md](PLAN.md) for the design and the decisions behind it.

## Layout

    scenic/tessadem.py   raw TessaDEM tile reader + lat/lon mosaic
    scenic/grid.py       local metric projection and bilinear sampling
    scenic/viewshed.py   the kernel: running-max-angle ray marching
    scenic/water.py      lake/sea mask (flat-surface detection, pilot only)
    scenic/score.py      filters, scoring modes, sunset azimuth
    scenic/render.py     hillshade + heatmap PNG
    scripts/verify_dem.py  landmark check — run this first, always
    scripts/build_pilot.py orchestrates the Alingsås pilot

Code lives on the internal SSD. Bulk data lives on `/Volumes/T7/scenic` — the T7 is exFAT,
which has no symlinks, is case-insensitive, and has weak file locking, so git and SQLite
misbehave on it.

## Running

    ./.venv/bin/python scripts/verify_dem.py
    ./.venv/bin/python scripts/build_pilot.py --mode picnic
    ./.venv/bin/python scripts/build_pilot.py --mode plot

Outputs: signatures to `/Volumes/T7/scenic/pilot/*.npz`, heatmaps to `out/*.png`.

## The map

    ./.venv/bin/python scripts/build_region.py     # 45 tiles, ~95 min, resumable
    ./.venv/bin/python scripts/pack_region.py      # web tiles, ~20 s
    ./.venv/bin/python scripts/export_contours.py --bbox 55.30 59.20 11.10 14.60 \
        --interval 25 --major-every 4 --step 100 --tolerance 40 --no-elev \
        --out contours_region.geojson
    ./.venv/bin/python scripts/serve.py 8731

`export_web.py` builds the same layers for a single 50 km box and predates the
region pipeline; it is still useful for quick experiments on one area.

`serve.py` sends `no-store`. `python -m http.server` sends no cache headers at
all, so browsers fall back to heuristic freshness and quietly keep running a
stale `app.js` after you edit it - which looks exactly like your change having
had no effect. `index.html` also imports `app.js` through a dynamic import with
a cache-buster, because a browser's module map is a second cache that a plain
reload does not clear.

Then open http://localhost:8731.

- **Direction wheel** - drag either handle to set the arc of bearings that count,
  or drag the arc to swing it round. Presets for N/E/S/W and for today's sunset
  bearing, which at 58N swings from about 221 degrees at midwinter to 318 at
  midsummer.
- **How far you can see** - a two-handle band that both filters and sets the
  colour scale. The top handle at its maximum means "and above". Square-root
  spaced, because the distribution is long-tailed: median 1.9 km, best 12.3.
- **Clarity** - one slider covering the whole range from bare basemap to bare
  heatmap. Below the midpoint it fades the overlay in over untouched ground;
  above it the overlay is already solid, so further travel whitens the basemap
  behind it instead. The colours never weaken, which is the point: fading the
  heatmap to make it legible defeats the purpose.
- **Eye height** - ground (0 m), standing (1.7 m) or a second-floor window
  (5 m). Six signature sets exist (three heights x two vegetation states, ~53 MB
  in total), so each is fetched the first time it is asked for rather than up
  front.
- **Elevation contours** - 10 m lines, every 50 m heavier, traced from the same
  DEM the scores come from so they agree with the heatmap exactly. Minor lines
  appear from zoom 11; below that 10 m spacing across 50 km is a smear. Hovering
  a line names its height, and clicking anywhere reports the ground elevation.
- Satellite or OSM basemap, how-far-you-see vs sees-water, a checkbox that
  strips the forest, and the ten best spots as markers, each linking out to
  Google Maps in its own window.

Filtering happens in the browser over the shipped per-azimuth signature, not
against pre-rendered layers - about 40 ms for a full recompute of 251,001 cells,
so the wheel is live rather than a set of baked presets.

It has to run locally rather than as a published artifact, because artifact pages
cannot load map tiles from external hosts.

Overlays are reprojected to Web Mercator before export. Our grids are linear in
latitude and a web map is linear in Mercator y; over 50 km at 58N that is ~80 m
of vertical slip at the centre and more at the edges, which would slide the
heatmap off the terrain it describes.

## What the eye-height control shows

| median reach | ground | standing | second floor |
|---|---|---|---|
| bare earth | 1.53 km | 2.36 km | 3.32 km |
| with today's canopy | 0.03 km | 0.03 km | 0.03 km |

Under 20 m of spruce it makes no difference whether you are lying on the ground
or standing at a first-floor window, which is the right answer and a useful
check on the model. Height only buys a view once you are in the open, and that
is why per-pixel canopy heights matter more than any other refinement on the
list.

## Region

Skåne, Halland, southern Bohuslän and Västra Götaland: lat 55.30-59.20,
lon 11.10-14.60, **91,425 km²**, 9.18M observers at 100 m spacing. Three eye
heights times two vegetation states is six signature sets, 2 GB of memory-mapped
arrays on the T7, packed to 2.14 GB of web tiles.

The box is a rectangle, so its south-west corner takes in eastern Denmark and a
good deal of sea. That is not waste: seeing across Öresund from Skåne is a real
view, and the Danish coast is part of it.

    region 4344 x 2113 = 9.18M cells, land 67%
    elevation on land -6 to 373 m (highest ground in the region is ~360 m)

    set          median reach    sees water
    trees_0           0.00 km          4.2%
    trees_170         0.00 km          6.3%
    trees_500         0.00 km          8.0%
    bare_0            1.52 km         19.4%
    bare_170          2.93 km         31.8%
    bare_500          4.60 km         43.2%

## Data

Pilot terrain is TessaDEM v1.2 (~30 m, ODbL), already present on the T7 as a 54 GB global
tarball. Phase 2 moves to Lantmäteriet *Markhöjdmodell grid 1+* (1 m, CC BY 4.0) plus
Skogsstyrelsen tree heights (10 m, CC0) to build a surface model rather than buy one.
