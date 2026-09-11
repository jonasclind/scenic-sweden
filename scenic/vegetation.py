"""Vegetation as an obstruction surface.

TessaDEM is bare earth, so without this every score is a view of a clear-felled
county - which is why the first ranked list put most spots in forest. ESA
WorldCover gives a 10 m tree mask for free and without an account; we pair it
with a nominal canopy height.

A mask plus one height is crude. It is also enough for the question being asked,
because the thing that ruins a view is the presence of a 20 m wall of spruce,
not whether it is 19 m or 23 m. Real per-pixel heights (Skogsstyrelsen, CC0, or
the ETH 10 m global model) are the upgrade path.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from .grid import LocalGrid

LANDCOVER_DIR = Path("/Volumes/T7/scenic/landcover")

# ESA WorldCover v200 classes
TREE_COVER = 10
SHRUBLAND = 20
BUILT_UP = 50

# Nominal heights, metres. Managed spruce and pine in Vastergotland runs 20-25 m
# at harvest age; 20 m is deliberately a little conservative.
CANOPY_M = 20.0
SHRUB_M = 2.0
BUILDING_M = 6.0


def _tiles_for(lat_lo: float, lat_hi: float, lon_lo: float, lon_hi: float):
    """WorldCover tiles are 3x3 degrees, named after their south-west corner."""
    for la in range(int(np.floor(lat_lo / 3) * 3), int(np.floor(lat_hi / 3) * 3) + 1, 3):
        for lo in range(int(np.floor(lon_lo / 3) * 3), int(np.floor(lon_hi / 3) * 3) + 1, 3):
            ns = f"N{la:02d}" if la >= 0 else f"S{-la:02d}"
            ew = f"E{lo:03d}" if lo >= 0 else f"W{-lo:03d}"
            yield LANDCOVER_DIR / f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"


def obstruction_height(grid: LocalGrid) -> np.ndarray:
    """Height to add to bare earth at every cell of `grid`, in metres."""
    import rasterio

    ny, nx = grid.z.shape
    ys = np.arange(ny) * grid.step + grid.y0
    xs = np.arange(nx) * grid.step + grid.x0
    X, Y = np.meshgrid(xs, ys)
    lon, lat = grid.xy_to_lonlat(X, Y)

    cls = np.zeros(grid.z.shape, np.uint8)
    paths = list(_tiles_for(lat.min(), lat.max(), lon.min(), lon.max()))
    missing = [p for p in paths if not p.exists()]
    if missing:
        raise FileNotFoundError(
            "missing WorldCover tiles:\n  " + "\n  ".join(str(p) for p in missing))

    for p in paths:
        with rasterio.open(p) as src:
            b = src.bounds
            sel = ((lon >= b.left) & (lon < b.right) &
                   (lat >= b.bottom) & (lat < b.top))
            if not sel.any():
                continue
            # src.index() is scalar-only, so map through the affine directly.
            # WorldCover is north-up, so the rotation terms are zero.
            tr = src.transform
            cols = ((lon[sel] - tr.c) / tr.a).astype(np.int64)
            rows = ((lat[sel] - tr.f) / tr.e).astype(np.int64)
            rows = np.clip(rows, 0, src.height - 1)
            cols = np.clip(cols, 0, src.width - 1)
            r0, r1 = int(rows.min()), int(rows.max()) + 1
            c0, c1 = int(cols.min()), int(cols.max()) + 1
            block = src.read(1, window=((r0, r1), (c0, c1)))
            cls[sel] = block[rows - r0, cols - c0]

    h = np.zeros(grid.z.shape, np.float32)
    h[cls == TREE_COVER] = CANOPY_M
    h[cls == SHRUBLAND] = SHRUB_M
    h[cls == BUILT_UP] = BUILDING_M
    return h


def surface(grid: LocalGrid, height: np.ndarray) -> LocalGrid:
    """Bare earth plus obstructions: what blocks a view, as opposed to what you
    stand on. Observers keep standing on `grid`; rays are tested against this."""
    return LocalGrid(z=(grid.z + height).astype(np.float32), x0=grid.x0, y0=grid.y0,
                     step=grid.step, lat0=grid.lat0, lon0=grid.lon0)
