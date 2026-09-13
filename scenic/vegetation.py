"""Vegetation and buildings as an obstruction surface.

TessaDEM is bare earth, so without this every score is a view of a clear-felled
county. The heights come from the Meta/WRI canopy model (CC BY 4.0), reduced to
a region raster by scripts/build_canopy.py.

Real per-pixel heights replaced a flat 20 m assumption, and the difference is
not cosmetic. At a viewpoint Jonas knows, WorldCover called 93% of the
surrounding 200 m "tree cover" and we therefore modelled 20 m of spruce; the
actual canopy there averages 7.6 m, 28% of it is open ground, and 46% is under
5 m. Eight metres of imagined forest is exactly the margin that decides whether
you see over a slope.

Both the blocking surface and the site filter read the *mean* statistic, for
different reasons.

For blocking it is the unbiased estimate of canopy height where a ray actually
samples. The obvious alternative - the tallest pixel in the cell - sounds
conservative and is badly wrong: it widens every isolated tree to the full 21 m
cell, so a ray crossing farmland is stopped by trees it would have passed
beside. Measured over 1,681 observers on open ground near Lund, the max
statistic gives a median reach of 0.52 km where bare earth gives 5.51; the mean
gives 2.19 km, which is what hedgerows and tree lines really cost you. In closed
forest the two agree within a few metres, so little is given up where it counts.

For the site filter it answers "could I stand here in the open", which is a
question about typical cover, not about the one tall tree nearby.

The max raster is still produced. It is the right input for a future
worst-case mode, and it costs nothing extra to reduce.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .grid import LocalGrid

LANDCOVER_DIR = Path("/Volumes/T7/scenic/landcover")
CANOPY_DIR = Path("/Volumes/T7/scenic/canopy_region")

TREE_COVER = 10
SHRUBLAND = 20
BUILT_UP = 50

SHRUB_M = 2.0
BUILDING_M = 6.0
ROW_BAND = 512            # process the grid in bands; the whole thing in float64 is 600 MB


class CanopyRegion:
    """The reduced canopy raster: Web Mercator, aligned to the source tile grid."""

    def __init__(self, root: Path = CANOPY_DIR):
        self.meta = json.loads((root / "canopy.json").read_text())
        shape = (self.meta["rows"], self.meta["cols"])
        self.max = np.memmap(root / "canopy_max.u8", dtype=np.uint8, mode="r", shape=shape)
        self.mean = np.memmap(root / "canopy_mean.u8", dtype=np.uint8, mode="r", shape=shape)

    def _index(self, lon, lat):
        # Longitude scales by half the world width; latitude scales by the
        # earth radius. They differ by a factor of pi.
        m = self.meta
        x = lon / 180.0 * m["half"]
        y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * m["r_earth"]
        c = np.rint((x + m["half"]) / m["cell"]).astype(np.int64) - m["col0"]
        r = np.rint((m["half"] - y) / m["cell"]).astype(np.int64) - m["row0"]
        ok = (c >= 0) & (c < m["cols"]) & (r >= 0) & (r < m["rows"])
        return np.clip(r, 0, m["rows"] - 1), np.clip(c, 0, m["cols"] - 1), ok

    def sample(self, lon, lat, which: str = "max") -> np.ndarray:
        r, c, ok = self._index(lon, lat)
        src = self.max if which == "max" else self.mean
        return np.where(ok, src[r, c], 0).astype(np.float32)


def _landcover_class(grid: LocalGrid, lat, lon, out, sel_rows):
    """WorldCover classes for a band of the grid. Used only for built-up now."""
    import rasterio
    for p in _tiles_for(np.nanmin(lat), np.nanmax(lat), np.nanmin(lon), np.nanmax(lon)):
        if not p.exists():
            continue
        with rasterio.open(p) as src:
            b = src.bounds
            sel = ((lon >= b.left) & (lon < b.right) & (lat >= b.bottom) & (lat < b.top))
            if not sel.any():
                continue
            tr = src.transform
            cols = ((lon[sel] - tr.c) / tr.a).astype(np.int64)
            rows = ((lat[sel] - tr.f) / tr.e).astype(np.int64)
            rows = np.clip(rows, 0, src.height - 1)
            cols = np.clip(cols, 0, src.width - 1)
            r0, r1 = int(rows.min()), int(rows.max()) + 1
            c0, c1 = int(cols.min()), int(cols.max()) + 1
            block = src.read(1, window=((r0, r1), (c0, c1)))
            out[sel_rows][sel] = block[rows - r0, cols - c0]


def _tiles_for(lat_lo: float, lat_hi: float, lon_lo: float, lon_hi: float):
    """WorldCover tiles are 3x3 degrees, named after their south-west corner."""
    for la in range(int(np.floor(lat_lo / 3) * 3), int(np.floor(lat_hi / 3) * 3) + 1, 3):
        for lo in range(int(np.floor(lon_lo / 3) * 3), int(np.floor(lon_hi / 3) * 3) + 1, 3):
            ns = f"N{la:02d}" if la >= 0 else f"S{-la:02d}"
            ew = f"E{lo:03d}" if lo >= 0 else f"W{-lo:03d}"
            yield LANDCOVER_DIR / f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"


def _bands(grid: LocalGrid):
    ny, nx = grid.z.shape
    xs = np.arange(nx) * grid.step + grid.x0
    for y0 in range(0, ny, ROW_BAND):
        y1 = min(y0 + ROW_BAND, ny)
        ys = np.arange(y0, y1) * grid.step + grid.y0
        X, Y = np.meshgrid(xs, ys)
        lon, lat = grid.xy_to_lonlat(X, Y)
        yield slice(y0, y1), lon, lat


def obstruction_height(grid: LocalGrid, canopy: CanopyRegion | None = None) -> np.ndarray:
    """Height above bare earth that blocks a view, per cell."""
    import rasterio  # noqa: F401  (checked early so a missing dep fails here)
    canopy = canopy or CanopyRegion()
    out = np.zeros(grid.z.shape, np.float32)
    cls = np.zeros(grid.z.shape, np.uint8)
    for sl, lon, lat in _bands(grid):
        out[sl] = canopy.sample(lon, lat, "mean")
        _landcover_class(grid, lat, lon, cls, sl)
    # Buildings are not in a canopy model, and WorldCover still knows where they
    # are. Take whichever is taller rather than adding them.
    out = np.maximum(out, np.where(cls == BUILT_UP, BUILDING_M, 0.0))
    out = np.maximum(out, np.where((cls == SHRUBLAND) & (out < SHRUB_M), SHRUB_M, 0.0))
    return out


def site_canopy(grid: LocalGrid, canopy: CanopyRegion | None = None) -> np.ndarray:
    """Typical canopy height at each cell: is this spot itself in forest?"""
    canopy = canopy or CanopyRegion()
    out = np.zeros(grid.z.shape, np.float32)
    for sl, lon, lat in _bands(grid):
        out[sl] = canopy.sample(lon, lat, "mean")
    return out


def surface(grid: LocalGrid, height: np.ndarray) -> LocalGrid:
    """Bare earth plus obstructions: what blocks a view, as opposed to what you
    stand on. Observers keep standing on `grid`; rays are tested against this."""
    return LocalGrid(z=(grid.z + height).astype(np.float32), x0=grid.x0, y0=grid.y0,
                     step=grid.step, lat0=grid.lat0, lon0=grid.lon0)
