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

## Data

Pilot terrain is TessaDEM v1.2 (~30 m, ODbL), already present on the T7 as a 54 GB global
tarball. Phase 2 moves to Lantmäteriet *Markhöjdmodell grid 1+* (1 m, CC BY 4.0) plus
Skogsstyrelsen tree heights (10 m, CC0) to build a surface model rather than buy one.
