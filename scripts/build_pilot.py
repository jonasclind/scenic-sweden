"""Build the Alingsas pilot: signatures + heatmaps from TessaDEM."""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic import score as sc
from scenic.grid import build_local_grid
from scenic.render import compose, downsample
from scenic.tessadem import Mosaic
from scenic.viewshed import compute
from scenic.water import detect_water

ALINGSAS = (57.930, 12.533)
DEM_ROOT = Path("/Volumes/T7/scenic/dem/tessadem/raw")
DATA_OUT = Path("/Volumes/T7/scenic/pilot")
IMG_OUT = Path(__file__).resolve().parents[1] / "out"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core-km", type=float, default=50.0, help="analysed box side")
    ap.add_argument("--max-dist", type=float, default=20000.0)
    ap.add_argument("--dem-step", type=float, default=25.0, help="terrain grid spacing")
    ap.add_argument("--obs-step", type=float, default=100.0, help="observer spacing")
    ap.add_argument("--azimuths", type=int, default=32)
    ap.add_argument("--mode", choices=["picnic", "plot"], default="picnic")
    ap.add_argument("--limit", type=int, default=0, help="debug: cap observer count")
    args = ap.parse_args()

    lat0, lon0 = ALINGSAS
    eye = sc.MODES[args.mode]["eye_height"]
    half_km = args.core_km / 2 + args.max_dist / 1000.0   # core + view buffer

    DATA_OUT.mkdir(parents=True, exist_ok=True)
    IMG_OUT.mkdir(parents=True, exist_ok=True)

    t = time.time()
    lat_lo = int(np.floor(lat0 - half_km / 111.0))
    lat_hi = int(np.floor(lat0 + half_km / 111.0))
    lon_lo = int(np.floor(lon0 - half_km / 60.0))
    lon_hi = int(np.floor(lon0 + half_km / 60.0))
    print(f"tiles lat {lat_lo}..{lat_hi}  lon {lon_lo}..{lon_hi}")
    mos = Mosaic.build(DEM_ROOT, lat_lo, lat_hi, lon_lo, lon_hi)
    print(f"  mosaic {mos.z.shape}  ({time.time()-t:.1f}s)")

    t = time.time()
    grid = build_local_grid(mos, lat0, lon0, half_km, args.dem_step)
    del mos
    print(f"  grid {grid.z.shape} @ {args.dem_step:.0f} m  ({time.time()-t:.1f}s)")

    t = time.time()
    water = detect_water(grid.z, args.dem_step)
    print(f"  water {water.mean()*100:.1f}% of grid  ({time.time()-t:.1f}s)")

    half_core = args.core_km * 1000 / 2
    n = int(round(2 * half_core / args.obs_step)) + 1
    ax = (np.arange(n) - (n - 1) / 2) * args.obs_step
    OX, OY = np.meshgrid(ax, ax)
    ox, oy = OX.ravel(), OY.ravel()
    if args.limit:
        ox, oy = ox[:args.limit], oy[:args.limit]
    print(f"  observers {ox.size:,} ({n} x {n} @ {args.obs_step:.0f} m), eye {eye} m")

    t = time.time()
    last = [time.time()]

    def prog(done, total):
        if time.time() - last[0] > 15:
            last[0] = time.time()
            el = time.time() - t
            print(f"    {done}/{total} rays  {el:.0f}s elapsed, "
                  f"~{el/done*(total-done):.0f}s left", flush=True)

    sig = compute(grid, ox, oy, eye_height=eye, n_azimuth=args.azimuths,
                  water_mask=water, max_dist=args.max_dist, progress=prog)
    print(f"  signatures ({time.time()-t:.1f}s)")

    npz = DATA_OUT / f"alingsas_{args.mode}_{int(args.obs_step)}m.npz"
    np.savez_compressed(
        npz, x=sig.x, y=sig.y, ground=sig.ground, horizon=sig.horizon,
        max_dist=sig.max_dist, water_near=sig.water_near, water_far=sig.water_far,
        n_azimuth=sig.n_azimuth, lat0=lat0, lon0=lon0, obs_step=args.obs_step,
        eye_height=eye, mode=args.mode)
    print(f"  saved {npz} ({npz.stat().st_size/1e6:.1f} MB)")

    if args.limit:
        return
    def crop_core(a):
        ys = np.abs(np.arange(a.shape[0]) * grid.step + grid.y0) <= half_core
        xs = np.abs(np.arange(a.shape[1]) * grid.step + grid.x0) <= half_core
        return a[np.ix_(ys, xs)]

    terrain = downsample(crop_core(grid.z), n, n)
    wat = downsample(crop_core(water), n, n)

    views = {
        "openness": sc.Filters(),
        "water": sc.Filters(require_water=True, min_water_distance=300),
        "sunset_midsummer": sc.Filters(directions=(295, 345), min_distance=2000),
    }
    for name, f in views.items():
        r = sc.apply(sig, f)
        v = np.where(r["keep"], r["openness"], 0.0).reshape(n, n)
        img = compose(v, terrain, args.obs_step, water=wat)
        p = IMG_OUT / f"alingsas_{args.mode}_{name}.png"
        img.save(p)
        print(f"  {p.name}: {int(r['keep'].sum()):,} cells pass, "
              f"best reach {r['best_dist'].max()/1000:.1f} km")


if __name__ == "__main__":
    main()
