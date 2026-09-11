"""Confirm the TessaDEM tile orientation against known Swedish landmarks.

Row/column order is undocumented, so we assert it rather than assume it. If
this script disagrees, every downstream result is silently wrong.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic.tessadem import Mosaic

ROOT = Path("/Volumes/T7/scenic/dem/tessadem/raw")

# name, lat, lon, expected metres, tolerance
LANDMARKS = [
    ("Kattegat, open sea",   57.600, 11.500,   0.0, 12.0),
    ("Goteborg centre",      57.707, 11.967,  15.0, 30.0),
    ("Lake Mjorn surface",   57.960, 12.450,  60.5, 18.0),
    ("Alingsas centre",      57.930, 12.533,  70.0, 35.0),
    ("Boras centre",         57.721, 12.940, 140.0, 40.0),
    ("Hunneberg plateau",    58.345, 12.420, 150.0, 45.0),
]


def main():
    lats = [int(np.floor(l[1])) for l in LANDMARKS]
    lons = [int(np.floor(l[2])) for l in LANDMARKS]
    m = Mosaic.build(ROOT, min(lats), max(lats), min(lons), max(lons))
    print(f"mosaic {m.z.shape}  top={m.lat_top}  left={m.lon_left}  "
          f"dlat={m.dlat:.3e}  dlon={m.dlon:.3e}\n")

    lat = np.array([l[1] for l in LANDMARKS])
    lon = np.array([l[2] for l in LANDMARKS])
    got = m.sample(lat, lon)

    ok = True
    print(f"{'landmark':22s} {'expect':>8s} {'got':>8s} {'diff':>8s}  verdict")
    for (name, _, _, exp, tol), g in zip(LANDMARKS, got):
        d = g - exp
        good = np.isfinite(g) and abs(d) <= tol
        ok &= bool(good)
        print(f"{name:22s} {exp:8.1f} {g:8.1f} {d:+8.1f}  {'ok' if good else 'FAIL'}")

    print()
    if ok:
        print("orientation CONFIRMED: rows north->south, cols west->east")
    else:
        print("orientation WRONG or tiles missing -- do not trust downstream output")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
