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
    ./.venv/bin/python scripts/build_relief.py     # sustained descent, ~2 min
    ./.venv/bin/python scripts/pack_region.py      # web tiles, ~20 s
    ./.venv/bin/python scripts/export_contours.py --bbox 55.30 59.20 11.10 14.60 \
        --interval 25 --major-every 4 --step 100 --tolerance 40 --no-elev \
        --out contours_region.geojson
    ./scripts/sync_region.sh                       # 2 GB into web/, once per repack
    ./.venv/bin/python scripts/serve.py            # or the scenic-web launch config

`sync_region.sh` copies the packed region from the T7 into `web/`. The preview
launcher runs its server sandboxed and cannot read external volumes, so serving
the region straight off the drive works from a hand-started server and returns
404 under the launcher - the same code, two different answers. A local copy also
means the site does not care which drive is plugged in. `serve.py` prefers
`web/region` and falls back to the T7.

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

## Elevated spots

Being high is not the same as standing on something steep. A 5 m cliff is
near-vertical at the spot and gone a hundred metres out; a long hillside is what
gives a commanding view. So descent is measured at 250 m, 500 m, 1 km and 2 km
and the *worst* angle wins - a slope only counts if it is still falling at every
scale.

                        250 m   500 m    1 km    2 km     min
    5 m cliff, flat      1.15    0.57    0.29    0.14    0.14
    50 m step, flat     11.31    5.71    2.86    1.43    1.43
    long 6% slope        3.43    3.43    3.43    2.86    2.86

The filter uses the mean across the chosen directions rather than the best one,
so a single steep gully cannot qualify an otherwise flat field. Averaged over
all 32 directions the numbers are small - p90 is 0.25 degrees, p99 is 0.82 - so
the slider tops out at 1.20 and shows metres per kilometre alongside.

    >= 0.20 deg    12.9% of land
    >= 0.40 deg     5.2%
    >= 0.60 deg     2.4%
    >= 1.00 deg     0.5%

## Sun

"Can see the sun" takes a date and a time and keeps only the spots where the
sun's upper limb clears the local skyline. Upper limb, not centre: the two are
nearly three minutes apart here and the whole of a sunset happens inside that
gap. The Sunset button jumps the time to sunset at the middle of the map.

Position is NOAA's algorithm, checked against day lengths rather than against
remembered clock times - 18h05m at Gothenburg on midsummer, 7h01m at Lund at
midwinter, 12h10m at the equinox, 24h at Kiruna.

Visibility is not the 32-bin signature, which would smear a sunset over the
45 minutes one bin is worth. It is a fresh shadow sweep over the elevation and
canopy rasters at the exact solar azimuth. Marching every cell's ray would be
a couple of hundred samples each, so instead the grid is swept once in the
sun's direction, carrying the shadow envelope from line to line: O(cells)
rather than O(cells x ray). Against a brute-force ray march on random terrain
it disagrees on 0.0-0.5% of cells, all of them on a shadow's edge.

Two details that are not details:

  * The sun's elevation is computed per cell, not per window. Across the region
    it varies by 4.5 degrees, which at sunset is the difference between
    daylight and an hour past dark - the terminator really does cross the map.
    Dropping the envelope by the *local* angle at each step is also what
    accounts for the curve of the earth, since the sun stands higher by one
    part in R for every metre you walk towards it. Only refraction's 13% of
    that term is left out, 3.5 m over the longest shadow this relief throws.
  * Ground that falls away can see a sun the valley below has lost, by up to
    sqrt(2z/R) - 0.58 degrees for the 380 m of relief here. That band is the
    whole point, so the sweep is allowed to argue inside it and is only cut off
    a degree under the horizon.

Limits: terrain is pulled 20 km up-sun, which covers every shadow this relief
can throw down to about half a degree of elevation. A single azimuth serves the
whole window - it varies by 3 degrees across the region, which slews a 10 km
shadow by less than one 400 m cell. At the overview level the canopy is the
*quietest* cover in each 400 m block rather than the tallest, so trees
under-block there; zoom in for the honest answer. Date and time are read as the
device's own clock, which is the Swedish one for anyone standing in the region.

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
    canopy where you stand: median 2 m, open (<2 m) 49%, forest (>10 m) 24%

    set          median reach    sees water
    trees_0           0.05 km          6.0%
    trees_170         0.15 km         10.1%
    trees_500         0.48 km         15.5%
    bare_0            1.52 km         19.4%
    bare_170          2.93 km         31.8%
    bare_500          4.60 km         43.2%

Region-wide medians are dominated by forest interiors, which genuinely see
nothing. Split by cover at the observer, with today's canopy:

    cover at spot     ground   standing   2nd floor   reach 2 km (2nd floor)
    open   <2 m      0.41 km    0.81 km     1.49 km                    41%
    light 2-6 m      0.02 km    0.10 km     0.46 km                    15%
    forest >10 m     0.00 km    0.00 km     0.00 km                     1%

## Data

Pilot terrain is TessaDEM v1.2 (~30 m, ODbL), already present on the T7 as a 54 GB global
tarball. Phase 2 moves to Lantmäteriet *Markhöjdmodell grid 1+* (1 m, CC BY 4.0) plus
Skogsstyrelsen tree heights (10 m, CC0) to build a surface model rather than buy one.

## Deploying

`scripts/build_dist.py` assembles `dist/` for a static host: the app shell, a
`_headers` file, and every payload gzipped. Compression is done here rather than
left to the host because static hosts negotiate `Content-Encoding` for text but
not for `application/octet-stream`, which is what every `.bin` is. The client
inflates with `DecompressionStream`, so the host needs no configuration.

    2,463 MB -> 968 MB (61% saved), 2,470 files, largest 13.9 MB

What that buys on a phone:

    first screen (overview, standing + trees)   41.3 MB -> 10.7 MB
    contours                                     5.6 MB ->  1.3 MB
    one detail tile (~25 x 25 km)                4.7 MB ->  0.8 MB

Each build stamps a `build` id into `meta.json` which the client appends to
every payload URL, so `_headers` can claim a year of immutable caching without
a rebuild ever serving stale data.

    ./scripts/sync_region.sh              # T7 -> web/region
    .venv/bin/python scripts/build_dist.py
    .venv/bin/python scripts/serve.py --root dist 8732    # try it before uploading
    npx wrangler pages deploy dist --project-name scenic-sweden

Cloudflare Pages caps a project at 20,000 files and 25 MiB per file; this build
is well inside both.
