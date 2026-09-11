"""Full view report for a single location.

Answers "what does the model actually think of this spot?" - the per-azimuth
detail behind a single score, which is what you need to judge whether a ranking
is sensible.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic.grid import build_local_grid
from scenic.tessadem import Mosaic
from scenic.viewshed import compute
from scenic.water import detect_water

DEM_ROOT = Path("/Volumes/T7/scenic/dem/tessadem/raw")
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--max-dist", type=float, default=20000.0)
    ap.add_argument("--azimuths", type=int, default=32)
    args = ap.parse_args()

    half_km = args.max_dist / 1000.0 + 1.0
    lo_la, hi_la = int(np.floor(args.lat - half_km / 111)), int(np.floor(args.lat + half_km / 111))
    lo_lo, hi_lo = int(np.floor(args.lon - half_km / 60)), int(np.floor(args.lon + half_km / 60))
    mos = Mosaic.build(DEM_ROOT, lo_la, hi_la, lo_lo, hi_lo)
    grid = build_local_grid(mos, args.lat, args.lon, half_km, 25.0)
    del mos
    water = detect_water(grid.z, 25.0)

    o = np.array([0.0])
    print(f"\npoint {args.lat:.4f} N  {args.lon:.4f} E")
    sigs = {}
    for mode, eye in (("picnic", 1.7), ("plot", 5.0)):
        sigs[mode] = compute(grid, o, o, eye_height=eye, n_azimuth=args.azimuths,
                             water_mask=water, max_dist=args.max_dist)
    s = sigs["picnic"]
    print(f"ground elevation        {s.ground[0]:.1f} m")
    print(f"standing in water?      {bool(s.on_water[0])}")
    rel = grid.z[np.abs(np.arange(grid.z.shape[0]) * 25 + grid.y0) <= 1000][:, np.abs(
        np.arange(grid.z.shape[1]) * 25 + grid.x0) <= 1000]
    print(f"local relief (+/-1 km)  {np.nanmin(rel):.0f} to {np.nanmax(rel):.0f} m "
          f"-> stands {s.ground[0]-np.nanmedian(rel):+.1f} m above the local median")

    step = 360.0 / args.azimuths
    print(f"\n{'dir':>5} {'az':>5}  {'picnic view':>12} {'plot view':>10} "
          f"{'horizon':>8}  water")
    for a in range(args.azimuths):
        az = a * step
        d1 = s.max_dist[0, a] / 1000
        d2 = sigs["plot"].max_dist[0, a] / 1000
        hz = np.degrees(s.horizon[0, a])
        wf = s.water_far[0, a] / 1000
        bar = "#" * int(round(d1 / args.max_dist * 1000 * 20))
        w = f"{wf:5.1f} km" if wf > 0 else "     -"
        print(f"{COMPASS[int(round(az/22.5))%16]:>5} {az:5.0f}  {d1:7.1f} km {d2:7.1f} km "
              f"{hz:+7.2f} deg  {w}  {bar}")

    for mode in ("picnic", "plot"):
        m = sigs[mode]
        d = m.max_dist[0]
        print(f"\n{mode:6s} (eye {1.7 if mode=='picnic' else 5.0} m): "
              f"mean {d.mean()/1000:.1f} km, median {np.median(d)/1000:.1f} km, "
              f"best {d.max()/1000:.1f} km "
              f"{COMPASS[int(round(np.argmax(d)*step/22.5))%16]}, "
              f"{int((d > 5000).sum())}/{args.azimuths} directions reach 5 km")
        # Describe the water rather than counting bins. "water in 1/32" reads as
        # noise; "a lake 3.7 km NNW, 79 m below you" is the thing you can judge.
        vis = np.flatnonzero(m.water_far[0] > 0)
        if len(vis) == 0:
            print("        no water visible")
        for a in vis:
            near, far = m.water_near[0, a] / 1000, m.water_far[0, a] / 1000
            drop = m.ground[0] - float(grid.sample(
                np.array([np.sin(np.radians(a * step)) * far * 1000]),
                np.array([np.cos(np.radians(a * step)) * far * 1000]))[0])
            span = f"{near:.1f}-{far:.1f}" if far - near > 0.1 else f"{far:.1f}"
            print(f"        water {span} km to the "
                  f"{COMPASS[int(round(a*step/22.5))%16]}, {drop:.0f} m below you")


if __name__ == "__main__":
    main()
