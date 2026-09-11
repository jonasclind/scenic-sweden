"""Compute the Alingsas layers and export them for the web map."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic import score as sc
from scenic.grid import build_local_grid, metres_per_degree
from scenic.tessadem import Mosaic
from scenic.vegetation import obstruction_height, surface
from scenic.viewshed import compute
from scenic.water import detect_water
from scenic.webmap import RAMP_HEX, to_mercator_png

ALINGSAS = (57.930, 12.533)
CORE_KM = 50.0
MAX_DIST = 20000.0
OBS_STEP = 100.0
DEM = Path("/Volumes/T7/scenic/dem/tessadem/raw")
WEB = Path(__file__).resolve().parents[1] / "web"


def main():
    lat0, lon0 = ALINGSAS
    half_km = CORE_KM / 2 + MAX_DIST / 1000
    m_lat, m_lon = metres_per_degree(lat0)

    mos = Mosaic.build(DEM, int(np.floor(lat0 - half_km/111)), int(np.floor(lat0 + half_km/111)),
                       int(np.floor(lon0 - half_km/60)), int(np.floor(lon0 + half_km/60)))
    grid = build_local_grid(mos, lat0, lon0, half_km, 25.0); del mos
    water = detect_water(grid.z, 25.0)
    veg = obstruction_height(grid)
    surf = surface(grid, veg)
    print(f"grid {grid.z.shape}   tree cover {(veg>10).mean()*100:.0f}%   "
          f"water {water.mean()*100:.1f}%")

    half_core = CORE_KM * 1000 / 2
    n = int(round(2 * half_core / OBS_STEP)) + 1
    ax = (np.arange(n) - (n - 1) / 2) * OBS_STEP
    OX, OY = np.meshgrid(ax, ax)

    layers, manifest = {}, []
    for veg_on, tag in ((False, "bare"), (True, "trees")):
        t = time.time()
        sig = compute(grid, OX.ravel(), OY.ravel(), eye_height=1.7, n_azimuth=32,
                      water_mask=water, max_dist=MAX_DIST,
                      surface=surf if veg_on else None)
        print(f"  {tag}: {time.time()-t:.0f}s")
        layers[tag] = sig

    # A shared scale across both vegetation states: the checkbox must show the
    # view being taken away, not silently renormalise the colours. Fixed round
    # numbers rather than percentiles - the distribution is heavily skewed
    # (median 1.9 km, max 12.3), so a p97 cap threw away the entire top end,
    # which is the only part worth looking at.
    lo_hi = (0.0, 8000.0)

    for tag, sig in layers.items():
        for view, filt in (("openness", sc.Filters()),
                           ("water", sc.Filters(require_water=True, min_water_distance=300))):
            r = sc.apply(sig, filt)
            v = sc.robust(np.where(r["keep"], r["openness"], 0.0), (n, n), OBS_STEP)
            valid = r["keep"].reshape(n, n) & (v.reshape(n, n) > 0)
            img, bounds, used = to_mercator_png(
                v.reshape(n, n), valid, lat0, lon0, half_core, m_lat, m_lon, lo_hi=lo_hi)
            name = f"{view}_{tag}.png"
            img.save(WEB / "layers" / name)
            spots = sc.top_spots(np.where(valid.ravel(), v, 0.0), (n, n), sig,
                                 n=10, separation_cells=int(2000 / OBS_STEP))
            for sp in spots:
                sp["lat"] = lat0 + sp["y"] / m_lat
                sp["lon"] = lon0 + sp["x"] / m_lon
            manifest.append(dict(view=view, vegetation=tag, file=f"layers/{name}",
                                 bounds=bounds, cells=int(valid.sum()),
                                 median_km=float(np.median(v[valid.ravel()]) / 1000),
                                 spots=spots))
            print(f"  wrote {name}  {int(valid.sum()):,} cells  "
                  f"median {np.median(v[valid.ravel()])/1000:.1f} km")

    (WEB / "data.json").write_text(json.dumps(dict(
        centre=[lat0, lon0], layers=manifest, ramp=RAMP_HEX,
        scale_km=[lo_hi[0] / 1000, lo_hi[1] / 1000],
        max_dist_km=MAX_DIST / 1000, obs_step_m=OBS_STEP), indent=2))
    print(f"\nwrote web/data.json  scale {lo_hi[0]/1000:.1f}-{lo_hi[1]/1000:.1f} km")


if __name__ == "__main__":
    main()
