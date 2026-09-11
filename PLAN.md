# Scenic View Finder — Sweden

Find locations with long, open, water-facing views. Two modes: **plot** (buying land to
build on) and **picnic** (a spot to sit and watch a sunset).

## Decisions (locked)

| Question | Decision |
|---|---|
| Use case | Both, as modes. Swaps eye height, tree assumptions, accessibility weighting. |
| Max view range | 20 km |
| Water definition | Sea + lakes ≥ ~10 ha. Rivers excluded for now. |
| Stack | Python/numpy pilot → Rust kernel once scoring is settled |
| Pilot area | 50 × 50 km centred on Alingsås (57.930 N, 12.533 E) |
| Code location | `~/code/scenic-sweden` (internal SSD — exFAT breaks git) |
| Data location | `/Volumes/T7/scenic` (bulk only) |

## Data

| Layer | Source | Res | License | Phase |
|---|---|---|---|---|
| Terrain (pilot) | TessaDEM v1.2 (already on T7) | ~30 m | ODbL | 1 |
| Terrain (final) | Lantmäteriet *Markhöjdmodell grid 1+* | 1 m → stored at 2 m | CC BY 4.0 | 2 |
| Tree height | Skogsstyrelsen *Skogliga grunddata* | 10 m | CC0 | 2 |
| Buildings | OSM footprints, 3 m/level | vector | ODbL | 3 |
| Water | Lantmäteriet Topografi 50 | vector | CC BY 4.0 | 2 |

**Surface model is built, not bought.** Lantmäteriet's DSM (*Ythöjdmodell från flygbilder*)
is licensed and costs money. We synthesise ours as `DTM + tree height + building height`.
That is free, and better: it lets the plot mode answer "what if I clear the trees?", which a
purchased DSM cannot.

**Licensing.** TessaDEM and OSM are ODbL (share-alike on derived databases). Fine for
personal use. If this ever goes public and we want that off the table, drop both: Lantmäteriet
(CC BY) + Skogsstyrelsen (CC0) cover everything, with Topografi 50 for water instead of OSM.

## Storage budget (T7 has 966 GB free)

Download once, keep forever — refetching Lantmäteriet is the slowest, most fragile step.

| Item | Size |
|---|---|
| Terrain, 2 m `int16` decimetres, full focus region | ~50 GB |
| Pyramid levels (10/50/200 m) | ~5 GB |
| View signatures | ~1.5 GB |
| **Total** | **~60 GB** |

True 1 m is 200 GB even as `int16` and buys nothing for viewsheds — a 30 m elevation error at
20 km is 0.09° of angle. 2 m is the sweet spot.

## exFAT constraints (measured)

660 MB/s sequential write, 1.3 GB/s read — but only **~200 small files/sec**. Therefore:

- **Few large memory-mapped container files + an index.** Never a directory tree of millions
  of tiles. This is what the WebGL pipeline wants anyway, but it is painful to reverse later.
- No symlinks, case-insensitive, weak file locking → **no git repo and no SQLite on the T7.**
- USB can sleep or be unplugged → **per-tile checkpointing and resume** on every long job.

## Algorithm

The primitive is the **running maximum elevation angle**, not "is the next point lower".
Marching outward along a ray from eye height `z0`:

```
drop_d   = d² / (2 · 1.17 · R_earth)      # curvature + standard refraction
angle_d  = (h_d − drop_d − z0) / d
visible  = angle_d > max(angle_0 … angle_{d−1})
```

The refraction term matters: at 20 km the drop is ~27 m, which decides whether you see the far
shore of Vänern.

Per location we store a **view signature**: 32 azimuth bins × 11.25°, each holding

- horizon elevation angle (how hemmed in that direction is)
- max visible distance — the farthest visible point is always the farthest point attaining the
  maximum angle, so one pass yields both
- water visible: flag + nearest/farthest visible water distance

≈34 bytes per location. At 50 m sampling over 100,000 km² that is ~1.4 GB. **Every filter the
UI offers is then arithmetic on 32 numbers** — direction wedge, min distance, water checkbox
all run in a WebGL shader at 60 fps with no server round-trip.

Vectorisation: loop over `(azimuth, radial step)`, vectorise over all observers. Radial steps
grow with distance (25 m near, capped at 100 m) so a ray is ~300 samples rather than 800.

**Known approximation:** growing step size can step over a thin ridge. Bounded by keeping
`step/distance ≤ 2.5%`. The correct fix is a max-pooled DEM pyramid for the far field
(conservative — never misses an occluder). Deferred to phase 2.

## Scoring

Both modes read the same signature; only the weights differ.

| | plot | picnic |
|---|---|---|
| Eye height | 5 m (second floor) | 1.7 m (standing) |
| Trees | optional "assume cleared" toggle | as-is |
| Accessibility | road/power proximity | walking distance from parking |
| Time horizon | permanence | the moment |

**Sunset mode** takes a date, computes the solar azimuth at sunset for that latitude, and
scores the view in that specific direction. At 58 °N the sunset azimuth swings from roughly
southwest in midwinter to far northwest at midsummer, so "good sunset spot" is genuinely
date-dependent — this is where the tool beats eyeballing a contour map.

## Observer spacing drives correctness, not just detail

A ranked spot near Alingsas turned out to sit 100 m short of its summit, trading
3.2 m of height for the entire southern half of its view: a 203.6 m crest 100 m
south blocks a standing eye at 200.4 m but not a 5 m one. At 100 m observer
spacing the ranker cannot see the difference, because the robustness window can
never be finer than the spacing. At 25 m it picks the crest and the score rises
from 10.5 to 13.3 km.

So **final rankings need 25 m observer spacing**. That is 160M observers over the
full region, ~24 h in numpy, which is where a Rust port would finally earn its
keep. The cheaper answer is **two-stage**: scan at 100 m to find promising areas,
then re-rank only those at 25 m. Roughly 95% less compute for the same answer.

## Two things that will bite us

0. **Vegetation is not modelled at all.** Confirmed against the pilot: TessaDEM
   is bare earth (only 0.26% of raw cells step >8 m to a neighbour), so every
   score is a view as if the county were clear-felled, and Jonas's verdict on the
   first ranked list was that most spots sit in forest. This is a prerequisite,
   not a refinement. Free options without an account: ESA WorldCover 10 m for a
   tree mask, or the ETH 10 m global canopy height model for real heights.

1. **Heatmaps smear along ridgelines.** Every cell on a 3 km ridge scores alike, so "best
   spots" becomes a stripe. Needs non-max suppression / clustering to produce a ranked list of
   discrete candidates.
2. **The top scorer is often a clearcut, a quarry, or a power line corridor.** Openness ≠
   scenic. Fix is to weight by view *content* using Naturvårdsverket's Nationella Marktäckedata
   (free). Deferred, but the signature layout leaves room for it.

## Phases

1. **Pilot** — Alingsås 50×50 km, TessaDEM 30 m, pure Python, static heatmap. Zero downloads.
   Goal: does the scoring match Jonas's gut? This is the cheapest place to iterate on taste.
2. **Real data** — Lantmäteriet 2 m + tree height, Rust kernel, interactive filters.
3. **Scale + polish** — full region, sunset mode, 360° horizon profile and synthetic panorama
   on click, candidate clustering.
