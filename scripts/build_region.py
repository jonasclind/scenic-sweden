"""Compute view signatures for south and west Sweden.

The region is far too large to hold in one local projection, so it is worked in
tiles: each tile gets its own metric frame and a 20 km halo of terrain around
its core, and results are written straight into region-wide memory-mapped
arrays. Observers are the region's own lat/lon grid, so tiles fill in disjoint
slabs of one seamless result rather than needing to be stitched afterwards.

Every tile is checkpointed. The T7 is USB and the run takes hours; losing the
lot to an unplugged cable at hour two is not acceptable.
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
from scenic.vegetation import CANOPY_M, _tiles_for, obstruction_height, surface
from scenic.viewshed import compute_multi
from scenic.water import detect_water

# Skane, Halland, southern Bohuslan and Vastra Gotaland
LAT0, LAT1 = 55.30, 59.20
LON0, LON1 = 11.10, 14.60
VIEW_KM = 20.0
OBS_M = 100.0
DEM_M = 25.0
N_AZ = 32
EYES = [(0, 0.0), (170, 1.7), (500, 5.0)]
VEG = ["trees", "bare"]

DEM = Path("/Volumes/T7/scenic/dem/tessadem/raw")
OUT = Path("/Volumes/T7/scenic/region")


def region_grid():
    """Lat/lon sample points, row 0 at the south edge."""
    m_lat, m_lon = metres_per_degree((LAT0 + LAT1) / 2)
    lats = np.arange(LAT0, LAT1, OBS_M / m_lat)
    lons = np.arange(LON0, LON1, OBS_M / m_lon)
    return lats, lons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile-lat", type=float, default=0.45)
    ap.add_argument("--tile-lon", type=float, default=0.75)
    ap.add_argument("--only", type=int, default=0, help="stop after N tiles (smoke test)")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("LAT0", "LAT1", "LON0", "LON1"),
                    help="override the region, for smoke tests")
    ap.add_argument("--out", default=None, help="override output directory")
    args = ap.parse_args()

    global LAT0, LAT1, LON0, LON1, OUT
    if args.bbox:
        LAT0, LAT1, LON0, LON1 = args.bbox
    if args.out:
        OUT = Path(args.out)

    lats, lons = region_grid()
    R, C = lats.size, lons.size
    safe.ensure_dir(OUT)
    safe.check_free_space(need_gb=3.0)
    print(f"region {R} x {C} = {R*C/1e6:.2f}M observers, "
          f"lat {lats[0]:.3f}-{lats[-1]:.3f}, lon {lons[0]:.3f}-{lons[-1]:.3f}")

    def mm(name, shape, dtype):
        return np.memmap(safe.guard(OUT / name), dtype=dtype, mode="r+" if
                         (OUT / name).exists() else "w+", shape=shape)

    elev = mm("elev.i16", (R, C), np.int16)
    valid = mm("valid.u8", (R, C), np.uint8)
    dist = {}
    water = {}
    for v in VEG:
        for cm, _ in EYES:
            dist[(v, cm)] = mm(f"dist_{v}_{cm}.u8", (R, C, N_AZ), np.uint8)
            water[(v, cm)] = mm(f"water_{v}_{cm}.u32", (R, C), np.uint32)

    state_path = OUT / "progress.json"
    done = set(json.loads(state_path.read_text())["done"]) if state_path.exists() else set()

    tiles = [(a, o) for a in np.arange(LAT0, LAT1, args.tile_lat)
             for o in np.arange(LON0, LON1, args.tile_lon)]

    # Preflight every input the run will touch, including the halo. Discovering
    # a missing landcover tile ten minutes in wastes the work already done; the
    # halo reaches further than the region itself, which is exactly where the
    # gap was.
    # Mirror the half_km the loop below actually uses, rather than guessing a
    # margin: too generous a pad demands tiles the run will never read.
    _ml, _mo = metres_per_degree((LAT0 + LAT1) / 2)
    _half_km = (np.hypot(args.tile_lat * _ml, args.tile_lon * _mo) / 2000) + VIEW_KM + 1
    pad_lat = _half_km / (_ml / 1000)
    pad_lon = _half_km / (_mo / 1000)
    need_lc = sorted({p for p in _tiles_for(LAT0 - pad_lat, LAT1 + pad_lat,
                                            LON0 - pad_lon, LON1 + pad_lon)})
    gone = [p for p in need_lc if not p.exists()]
    if gone:
        raise SystemExit("missing landcover tiles:\n  " +
                         "\n  ".join(p.name for p in gone))
    dem_need = [(a, o) for a in range(int(np.floor(LAT0 - pad_lat)),
                                      int(np.floor(LAT1 + pad_lat)) + 1)
                for o in range(int(np.floor(LON0 - pad_lon)),
                               int(np.floor(LON1 + pad_lon)) + 1)]
    dem_have = sum(1 for a, o in dem_need if (DEM / f"{a}_{o}").exists())
    print(f"preflight: {len(need_lc)} landcover tiles present, "
          f"{dem_have}/{len(dem_need)} DEM tiles present "
          f"(absent DEM reads as no-data, which only affects halo padding)")
    print(f"{len(tiles)} tiles, {len(done)} already done\n")

    t_start = time.time()
    done_here = 0
    for k, (a0, o0) in enumerate(tiles):
        key = f"{a0:.3f}_{o0:.3f}"
        if key in done:
            continue
        a1, o1 = min(a0 + args.tile_lat, LAT1), min(o0 + args.tile_lon, LON1)
        rows = np.flatnonzero((lats >= a0) & (lats < a1))
        cols = np.flatnonzero((lons >= o0) & (lons < o1))
        if not rows.size or not cols.size:
            done.add(key)
            continue

        lat_c, lon_c = (a0 + a1) / 2, (o0 + o1) / 2
        m_lat, m_lon = metres_per_degree(lat_c)
        half_km = (np.hypot((a1 - a0) * m_lat, (o1 - o0) * m_lon) / 2000) + VIEW_KM + 1

        t0 = time.time()
        mos = Mosaic.build(DEM, int(np.floor(lat_c - half_km / 111)),
                           int(np.floor(lat_c + half_km / 111)),
                           int(np.floor(lon_c - half_km / 60)),
                           int(np.floor(lon_c + half_km / 60)))
        grid = build_local_grid(mos, lat_c, lon_c, half_km, DEM_M); del mos
        wmask = detect_water(grid.z, DEM_M)
        surf = surface(grid, obstruction_height(grid))
        t_prep = time.time() - t0

        LA, LO = np.meshgrid(lats[rows], lons[cols], indexing="ij")
        ox = ((LO - lon_c) * m_lon).ravel()
        oy = ((LA - lat_c) * m_lat).ravel()

        for v in VEG:
            sigs = compute_multi(grid, ox, oy, [e for _, e in EYES], n_azimuth=N_AZ,
                                 water_mask=wmask, max_dist=VIEW_KM * 1000,
                                 surface=surf if v == "trees" else None)
            for (cm, _), sg in zip(EYES, sigs):
                d = np.clip(sg.max_dist / (VIEW_KM * 1000) * 255.0, 0, 255).astype(np.uint8)
                dist[(v, cm)][np.ix_(rows, cols)] = d.reshape(rows.size, cols.size, N_AZ)
                bits = (sg.water_far > 0).astype(np.uint32)
                wm = (bits << np.arange(N_AZ, dtype=np.uint32)).sum(axis=1).astype(np.uint32)
                water[(v, cm)][np.ix_(rows, cols)] = wm.reshape(rows.size, cols.size)
            if v == VEG[0]:
                sg = sigs[0]
                elev[np.ix_(rows, cols)] = np.rint(
                    np.nan_to_num(sg.ground, nan=-32768)).reshape(rows.size, cols.size)
                valid[np.ix_(rows, cols)] = (
                    ~sg.on_water & np.isfinite(sg.ground)).reshape(rows.size, cols.size)

        done.add(key)
        done_here += 1
        state_path.write_text(json.dumps({"done": sorted(done)}))
        el = time.time() - t_start
        # rate from tiles finished in THIS run: dividing by the total, which
        # includes tiles restored from the checkpoint, understates the ETA badly
        left = (len(tiles) - len(done)) * el / done_here
        print(f"[{len(done):2d}/{len(tiles)}] {key}  {rows.size}x{cols.size} obs  "
              f"prep {t_prep:4.1f}s  total {time.time()-t0:5.1f}s  "
              f"eta {left/60:5.1f} min", flush=True)
        if args.only and len(done) >= args.only:
            print("stopping (--only)")
            break

    for m in list(dist.values()) + list(water.values()) + [elev, valid]:
        m.flush()
    (OUT / "region.json").write_text(json.dumps(dict(
        lat0=float(lats[0]), lat1=float(lats[-1]),
        lon0=float(lons[0]), lon1=float(lons[-1]),
        rows=int(R), cols=int(C), azimuths=N_AZ, obs_m=OBS_M,
        max_dist_km=VIEW_KM, canopy_m=CANOPY_M,
        eyes=[dict(cm=cm, m=e) for cm, e in EYES], veg=VEG), indent=2))
    print(f"\ndone in {(time.time()-t_start)/60:.1f} min")


if __name__ == "__main__":
    main()
