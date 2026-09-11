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

    ./.venv/bin/python scripts/export_web.py      # recompute the four layers
    ./.venv/bin/python -m http.server 8731 --directory web

Then open http://localhost:8731.

- **Direction wheel** - drag either handle to set the arc of bearings that count,
  or drag the arc to swing it round. Presets for N/E/S/W and for today's sunset
  bearing, which at 58N swings from about 221 degrees at midwinter to 318 at
  midsummer.
- **How far you can see** - a two-handle band that both filters and sets the
  colour scale. The top handle at its maximum means "and above". Square-root
  spaced, because the distribution is long-tailed: median 1.9 km, best 12.3.
- Satellite or OSM basemap, how-far-you-see vs sees-water, a checkbox that
  strips the forest, opacity, and the ten best spots as markers.

Filtering happens in the browser over the shipped per-azimuth signature, not
against pre-rendered layers - about 40 ms for a full recompute of 251,001 cells,
so the wheel is live rather than a set of baked presets.

It has to run locally rather than as a published artifact, because artifact pages
cannot load map tiles from external hosts.

Overlays are reprojected to Web Mercator before export. Our grids are linear in
latitude and a web map is linear in Mercator y; over 50 km at 58N that is ~80 m
of vertical slip at the centre and more at the edges, which would slide the
heatmap off the terrain it describes.

## Data

Pilot terrain is TessaDEM v1.2 (~30 m, ODbL), already present on the T7 as a 54 GB global
tarball. Phase 2 moves to Lantmäteriet *Markhöjdmodell grid 1+* (1 m, CC BY 4.0) plus
Skogsstyrelsen tree heights (10 m, CC0) to build a surface model rather than buy one.
