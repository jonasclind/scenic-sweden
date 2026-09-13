"""Summarise the region arrays, and inspect one known point.

Run after a rebuild to see whether the numbers moved the way they should.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

SRC = Path("/Volumes/T7/scenic/region")
POINT = (57.9776, 12.8976)      # Jonas: "nice northern view, steep slope, lake NW"


def main():
    m = json.loads((SRC / "region.json").read_text())
    R, C, A = m["rows"], m["cols"], m["azimuths"]
    dlat = (m["lat1"] - m["lat0"]) / (R - 1)
    dlon = (m["lon1"] - m["lon0"]) / (C - 1)
    valid = np.memmap(SRC / "valid.u8", dtype=np.uint8, mode="r", shape=(R, C))
    site = np.memmap(SRC / "canopy.u8", dtype=np.uint8, mode="r", shape=(R, C))

    land = valid > 0
    sc = site[land]
    print(f"region {R} x {C}, land {land.mean()*100:.0f}%")
    print(f"canopy where you stand: median {np.median(sc):.0f} m, "
          f"open (<2 m) {(sc < 2).mean()*100:.0f}%, "
          f"forest (>10 m) {(sc > 10).mean()*100:.0f}%\n")

    print(f"{'set':14s} {'median':>8} {'p90':>7} {'max':>7} {'sees water':>11}")
    for v in m["veg"]:
        for ey in m["eyes"]:
            d = np.memmap(SRC / f"dist_{v}_{ey['cm']}.u8", dtype=np.uint8,
                          mode="r", shape=(R, C, A))
            w = np.memmap(SRC / f"water_{v}_{ey['cm']}.u32", dtype=np.uint32,
                          mode="r", shape=(R, C))
            x = d[::7].astype(np.float32).mean(axis=2)[valid[::7] > 0] / 255 * 20
            print(f"{v}_{ey['cm']:<3}{'':7s} {np.median(x):6.2f} km {np.percentile(x,90):6.1f} "
                  f"{x.max():6.1f} {(w[land] > 0).mean()*100:9.1f}%")

    y = int(round((POINT[0] - m["lat0"]) / dlat))
    x = int(round((POINT[1] - m["lon0"]) / dlon))
    print(f"\nat {POINT[0]}, {POINT[1]} (the spot Jonas knows):")
    print(f"  canopy where you stand: {site[y, x]} m")
    for v in m["veg"]:
        for ey in m["eyes"]:
            d = np.memmap(SRC / f"dist_{v}_{ey['cm']}.u8", dtype=np.uint8,
                          mode="r", shape=(R, C, A))
            w = np.memmap(SRC / f"water_{v}_{ey['cm']}.u32", dtype=np.uint32,
                          mode="r", shape=(R, C))
            r = d[y, x].astype(np.float32) / 255 * 20
            print(f"  {v}_{ey['cm']:<3}: mean {r.mean():5.2f} km, best {r.max():5.2f} km, "
                  f"{int((r > 5).sum()):2d}/32 reach 5 km, "
                  f"water {'yes' if w[y, x] else 'no'}")


if __name__ == "__main__":
    main()
