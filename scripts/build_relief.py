"""How far the ground keeps falling away from each spot, per direction.

Being high is not the same as standing on something steep. A 5 m cliff is
near-vertical at the spot and irrelevant a hundred metres out; a long hillside
is what actually gives a commanding view. So steepness is measured at several
distances and the WORST one wins: a slope only scores if it is still falling at
every scale.

                        250 m   500 m    1 km    2 km     min
    5 m cliff, flat      1.15    0.57    0.29    0.14    0.14
    50 m step, flat     11.31    5.71    2.86    1.43    1.43
    long 6% slope        3.43    3.43    3.43    2.86    2.86

Stored per azimuth, in quarter-degrees, and independent of eye height and
vegetation - it is a property of the terrain alone.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic import safe
from scenic.grid import build_local_grid, metres_per_degree
from scenic.tessadem import Mosaic

DISTANCES = (250.0, 500.0, 1000.0, 2000.0)
SCALE = 4.0                      # quarter-degree steps into a uint8
DEM = Path("/Volumes/T7/scenic/dem/tessadem/raw")
OUT = Path("/Volumes/T7/scenic/region")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile-lat", type=float, default=0.45)
    ap.add_argument("--tile-lon", type=float, default=0.75)
    args = ap.parse_args()

    meta = json.loads((OUT / "region.json").read_text())
    LAT0, LAT1 = meta["lat0"], meta["lat1"]
    LON0, LON1 = meta["lon0"], meta["lon1"]
    R, C, A = meta["rows"], meta["cols"], meta["azimuths"]
    m_lat, m_lon = metres_per_degree((LAT0 + LAT1) / 2)
    lats = np.arange(LAT0, LAT1 + 1e-9, meta["obs_m"] / m_lat)[:R]
    lons = np.arange(LON0, LON1 + 1e-9, meta["obs_m"] / m_lon)[:C]

    path = safe.guard(OUT / "drop.u8")
    drop = np.memmap(path, dtype=np.uint8,
                     mode="r+" if path.exists() else "w+", shape=(R, C, A))
    print(f"relief {R} x {C} x {A}, distances {DISTANCES} m")

    thetas = 2 * np.pi * np.arange(A) / A
    tiles = [(a, o) for a in np.arange(LAT0, LAT1, args.tile_lat)
             for o in np.arange(LON0, LON1, args.tile_lon)]
    t_start = time.time()

    for k, (a0, o0) in enumerate(tiles, 1):
        a1, o1 = min(a0 + args.tile_lat, LAT1), min(o0 + args.tile_lon, LON1)
        rows = np.flatnonzero((lats >= a0) & (lats < a1))
        cols = np.flatnonzero((lons >= o0) & (lons < o1))
        if not rows.size or not cols.size:
            continue
        lat_c, lon_c = (a0 + a1) / 2, (o0 + o1) / 2
        ml, mo = metres_per_degree(lat_c)
        # only a small halo is needed: the farthest sample is 2 km out
        half_km = np.hypot((a1 - a0) * ml, (o1 - o0) * mo) / 2000 + max(DISTANCES) / 1000 + 1

        mos = Mosaic.build(DEM, int(np.floor(lat_c - half_km / 111)),
                           int(np.floor(lat_c + half_km / 111)),
                           int(np.floor(lon_c - half_km / 60)),
                           int(np.floor(lon_c + half_km / 60)))
        grid = build_local_grid(mos, lat_c, lon_c, half_km, 25.0); del mos

        LA, LO = np.meshgrid(lats[rows], lons[cols], indexing="ij")
        ox = ((LO - lon_c) * mo).ravel()
        oy = ((LA - lat_c) * ml).ravel()
        z0 = grid.sample(ox, oy)

        out = np.zeros((ox.size, A), np.uint8)
        for a, th in enumerate(thetas):
            dx, dy = np.sin(th), np.cos(th)
            worst = np.full(ox.size, np.inf, np.float32)
            for d in DISTANCES:
                z = grid.sample(ox + dx * d, oy + dy * d)
                ang = np.degrees(np.arctan2(z0 - z, d))
                worst = np.minimum(worst, np.where(np.isfinite(ang), ang, 0.0))
            out[:, a] = np.clip(worst * SCALE, 0, 255).astype(np.uint8)
        drop[np.ix_(rows, cols)] = out.reshape(rows.size, cols.size, A)

        el = time.time() - t_start
        print(f"[{k:2d}/{len(tiles)}] {a0:.2f}_{o0:.2f}  {el/k:4.1f}s/tile  "
              f"eta {(len(tiles)-k)*el/k/60:4.1f} min", flush=True)

    drop.flush()
    s = np.asarray(drop[::11, ::11]).astype(np.float32).max(axis=2) / SCALE
    print(f"\nsustained descent, best direction per cell (degrees):")
    for q in (50, 75, 90, 99):
        print(f"  p{q:<3} {np.percentile(s, q):5.2f}")
    print(f"  max  {s.max():5.2f}")


if __name__ == "__main__":
    main()
