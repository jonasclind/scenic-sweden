"""Elevation contours, generated from the same DEM the scores come from.

Using our own terrain rather than a contour tile service means the lines agree
with the analysis exactly - a ridge the heatmap lights up is the same ridge the
contours draw, at the same place.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from contourpy import contour_generator
from scipy import ndimage

from scenic.grid import build_local_grid, metres_per_degree
from scenic.tessadem import Mosaic

ALINGSAS = (57.930, 12.533)
DEM = Path("/Volumes/T7/scenic/dem/tessadem/raw")
WEB = Path(__file__).resolve().parents[1] / "web"


def simplify(pts: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker, iterative so long lines cannot blow the stack."""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        L = np.hypot(*seg)
        rel = pts[a + 1:b] - pts[a]
        if L < 1e-9:
            d = np.hypot(rel[:, 0], rel[:, 1])
        else:
            d = np.abs(rel[:, 0] * seg[1] - rel[:, 1] * seg[0]) / L
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack.append((a, k))
            stack.append((k, b))
    return pts[keep]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=10.0, help="minor interval, metres")
    ap.add_argument("--major-every", type=int, default=5, help="label every Nth line")
    ap.add_argument("--step", type=float, default=50.0, help="grid spacing for tracing")
    ap.add_argument("--smooth", type=float, default=1.0, help="gaussian sigma, in cells")
    ap.add_argument("--tolerance", type=float, default=18.0, help="simplification, metres")
    ap.add_argument("--half-km", type=float, default=25.0)
    args = ap.parse_args()

    lat0, lon0 = ALINGSAS
    m_lat, m_lon = metres_per_degree(lat0)

    mos = Mosaic.build(DEM, int(np.floor(lat0 - args.half_km/111)),
                       int(np.floor(lat0 + args.half_km/111)),
                       int(np.floor(lon0 - args.half_km/60)),
                       int(np.floor(lon0 + args.half_km/60)))
    grid = build_local_grid(mos, lat0, lon0, args.half_km, args.step); del mos

    # A little smoothing first: at 30 m source resolution the raw isolines are
    # visibly stepped, and the wobble is sampling noise rather than terrain.
    z = np.where(np.isfinite(grid.z), grid.z, np.nan)
    z = ndimage.gaussian_filter(np.nan_to_num(z, nan=float(np.nanmin(z))), args.smooth)

    ny, nx = z.shape
    xs = np.arange(nx) * grid.step + grid.x0
    ys = np.arange(ny) * grid.step + grid.y0
    gen = contour_generator(x=xs, y=ys, z=z, name="serial", line_type="SeparateCode")

    lo = int(np.floor(np.nanmin(z) / args.interval) * args.interval)
    hi = int(np.ceil(np.nanmax(z) / args.interval) * args.interval)
    levels = np.arange(max(lo, 0), hi + 1, args.interval)

    feats, vtot, vkept = [], 0, 0
    for lv in levels:
        lines, _ = gen.lines(float(lv))
        for pts in lines:
            pts = np.asarray(pts, dtype=np.float64)
            if len(pts) < 2:
                continue
            vtot += len(pts)
            pts = simplify(pts, args.tolerance)
            if len(pts) < 2:
                continue
            vkept += len(pts)
            lon = np.round(lon0 + pts[:, 0] / m_lon, 5)
            lat = np.round(lat0 + pts[:, 1] / m_lat, 5)
            feats.append({
                "type": "Feature",
                "properties": {"e": int(lv),
                               "major": int(lv) % int(args.interval * args.major_every) == 0},
                "geometry": {"type": "LineString",
                             "coordinates": np.stack([lon, lat], 1).tolist()},
            })

    # A coarse elevation grid alongside, so the map can answer "how high is
    # this spot?" on click. 501x501 int16 is half a megabyte.
    eg = build_local_grid(Mosaic.build(DEM, int(np.floor(lat0 - args.half_km/111)),
                                       int(np.floor(lat0 + args.half_km/111)),
                                       int(np.floor(lon0 - args.half_km/60)),
                                       int(np.floor(lon0 + args.half_km/60))),
                          lat0, lon0, args.half_km, 100.0)
    ez = np.rint(np.nan_to_num(eg.z, nan=-32768)).astype(np.int16)
    (WEB / "layers" / "elev.bin").write_bytes(ez.tobytes())
    print(f"elev.bin  {ez.shape}  {ez.nbytes/1e6:.2f} MB")

    out = WEB / "layers" / "contours.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")))
    majors = sum(f["properties"]["major"] for f in feats)
    print(f"{len(levels)} levels {levels[0]:.0f}-{levels[-1]:.0f} m at {args.interval:.0f} m")
    print(f"{len(feats):,} lines ({majors:,} major)   "
          f"vertices {vtot:,} -> {vkept:,} ({vkept/max(vtot,1)*100:.0f}% kept)")
    print(f"{out.name}  {out.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
