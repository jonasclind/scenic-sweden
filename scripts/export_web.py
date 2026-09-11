"""Compute the Alingsas layers and export them for the web map.

Ships the per-azimuth signature itself rather than pre-rendered pictures. That
is the point of the signature format: every filter the UI offers - direction
wedge, minimum distance, water - is then arithmetic over 32 numbers per cell,
done live in the browser, instead of a layer we had to bake in advance.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic.grid import build_local_grid, metres_per_degree
from scenic.tessadem import Mosaic
from scenic.vegetation import CANOPY_M, obstruction_height, surface
from scenic.viewshed import compute
from scenic.water import detect_water
from scenic.webmap import RAMP_HEX

ALINGSAS = (57.930, 12.533)
CORE_KM = 50.0
MAX_DIST = 20000.0
OBS_STEP = 100.0
N_AZ = 32

# Eye heights, in metres, keyed in the filenames by centimetres so the names
# stay free of decimal points. 0 m is a genuine extreme: on flat ground an eye
# exactly at the surface sees one cell and stops.
EYES = [(0, 0.0, "Ground"), (170, 1.7, "Standing"), (500, 5.0, "Second floor")]
DEM = Path("/Volumes/T7/scenic/dem/tessadem/raw")
WEB = Path(__file__).resolve().parents[1] / "web"


def main():
    lat0, lon0 = ALINGSAS
    half_km = CORE_KM / 2 + MAX_DIST / 1000
    m_lat, m_lon = metres_per_degree(lat0)
    (WEB / "layers").mkdir(parents=True, exist_ok=True)

    mos = Mosaic.build(DEM, int(np.floor(lat0 - half_km/111)), int(np.floor(lat0 + half_km/111)),
                       int(np.floor(lon0 - half_km/60)), int(np.floor(lon0 + half_km/60)))
    grid = build_local_grid(mos, lat0, lon0, half_km, 25.0); del mos
    water = detect_water(grid.z, 25.0)
    veg = obstruction_height(grid)
    surf = surface(grid, veg)
    print(f"grid {grid.z.shape}  tree cover {(veg >= CANOPY_M).mean()*100:.0f}%  "
          f"water {water.mean()*100:.1f}%")

    half_core = CORE_KM * 1000 / 2
    n = int(round(2 * half_core / OBS_STEP)) + 1
    ax = (np.arange(n) - (n - 1) / 2) * OBS_STEP
    OX, OY = np.meshgrid(ax, ax)

    for veg_on, tag in ((True, "trees"), (False, "bare")):
        for cm, eye, label in EYES:
            t = time.time()
            sig = compute(grid, OX.ravel(), OY.ravel(), eye_height=eye, n_azimuth=N_AZ,
                          water_mask=water, max_dist=MAX_DIST,
                          surface=surf if veg_on else None)

            # distance per azimuth, quantised to 8 bits (78 m per step at 20 km)
            dist = np.clip(sig.max_dist / MAX_DIST * 255.0, 0, 255).astype(np.uint8)
            # one bit per azimuth: is water visible that way
            bits = (sig.water_far > 0).astype(np.uint32)
            wmask = (bits << np.arange(N_AZ, dtype=np.uint32)).sum(axis=1).astype(np.uint32)
            valid = (~sig.on_water & np.isfinite(sig.ground)).astype(np.uint8)

            key = f"{tag}_{cm}"
            (WEB / "layers" / f"dist_{key}.bin").write_bytes(dist.tobytes())
            (WEB / "layers" / f"water_{key}.bin").write_bytes(wmask.tobytes())
            (WEB / "layers" / f"valid_{key}.bin").write_bytes(valid.tobytes())
            reach = sig.max_dist.mean(axis=1)[valid.astype(bool)]
            print(f"  {tag:5s} {label:12s} {time.time()-t:4.0f}s   "
                  f"median reach {np.median(reach)/1000:5.2f} km   "
                  f"{int((wmask > 0).sum()):7,} see water")

    lat_s, lat_n = lat0 - half_core / m_lat, lat0 + half_core / m_lat
    lon_w, lon_e = lon0 - half_core / m_lon, lon0 + half_core / m_lon
    (WEB / "data.json").write_text(json.dumps(dict(
        centre=[lat0, lon0], bounds=[lon_w, lat_s, lon_e, lat_n],
        n=n, azimuths=N_AZ, states=["trees", "bare"], ramp=RAMP_HEX,
        eyes=[dict(cm=cm, m=eye, label=label) for cm, eye, label in EYES],
        max_dist_km=MAX_DIST / 1000, obs_step_m=OBS_STEP,
        scale_km=[0.0, 8.0], canopy_m=CANOPY_M), indent=2))
    print(f"\nwrote web/data.json  ({n}x{n} cells, {N_AZ} azimuths)")


if __name__ == "__main__":
    main()
