"""Reader for TessaDEM v1.2 raw tiles.

One file per 1x1 degree cell, named "<lat>_<lon>" after its south-west corner.
Contents are int16 little-endian metres, row-major. Row count is always 3600
(one arcsecond of latitude); the column count is latitude-banded so that cells
stay roughly square, so we derive it from the file size rather than hardcoding
the bands.

Row and column order (north-first / west-first) is asserted against known
Swedish landmarks in verify.py rather than assumed.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

ROWS = 3600
NODATA = -32768


def tile_path(root: Path, lat: int, lon: int) -> Path:
    return Path(root) / f"{lat}_{lon}"


def load_tile(root: Path, lat: int, lon: int) -> np.ndarray | None:
    p = tile_path(root, lat, lon)
    if not p.exists():
        return None
    cols = p.stat().st_size // 2 // ROWS
    return np.fromfile(p, dtype="<i2").reshape(ROWS, cols)


class Mosaic:
    """A regular lat/lon grid stitched from whole tiles.

    Tiles are only stitchable when they share a column count, i.e. lie in one
    latitude band. That holds for the whole of south and west Sweden (55-59N),
    so we assert it rather than resampling across bands.
    """

    def __init__(self, z: np.ndarray, lat_top: float, lon_left: float,
                 dlat: float, dlon: float):
        self.z = z
        self.lat_top = lat_top
        self.lon_left = lon_left
        self.dlat = dlat  # negative: rows run north -> south
        self.dlon = dlon

    @classmethod
    def build(cls, root: Path, lat_lo: int, lat_hi: int, lon_lo: int, lon_hi: int) -> "Mosaic":
        lats = list(range(lat_hi, lat_lo - 1, -1))   # north -> south
        lons = list(range(lon_lo, lon_hi + 1))       # west  -> east

        cols = None
        rows_out = []
        for la in lats:
            row = []
            for lo in lons:
                t = load_tile(root, la, lo)
                if t is None:
                    if cols is None:
                        raise FileNotFoundError(
                            f"tile {la}_{lo} missing and no column count known yet")
                    t = np.full((ROWS, cols), NODATA, dtype="<i2")
                if cols is None:
                    cols = t.shape[1]
                elif t.shape[1] != cols:
                    raise ValueError(
                        f"tile {la}_{lo} has {t.shape[1]} columns, expected {cols}: "
                        "the requested box crosses a latitude band")
                row.append(t)
            rows_out.append(np.hstack(row))
        z = np.vstack(rows_out).astype(np.float32)
        z[z == NODATA] = np.nan
        return cls(z, lat_top=lat_hi + 1.0, lon_left=float(lon_lo),
                   dlat=-1.0 / ROWS, dlon=1.0 / cols)

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Bilinear sample at arrays of lat/lon. Out-of-range yields NaN."""
        fy = (lat - self.lat_top) / self.dlat - 0.5
        fx = (lon - self.lon_left) / self.dlon - 0.5
        h, w = self.z.shape

        y0 = np.floor(fy).astype(np.int64)
        x0 = np.floor(fx).astype(np.int64)
        ty = (fy - y0).astype(np.float32)
        tx = (fx - x0).astype(np.float32)

        ok = (y0 >= 0) & (y0 < h - 1) & (x0 >= 0) & (x0 < w - 1)
        y0c = np.clip(y0, 0, h - 2)
        x0c = np.clip(x0, 0, w - 2)

        z = self.z
        z00 = z[y0c, x0c]
        z01 = z[y0c, x0c + 1]
        z10 = z[y0c + 1, x0c]
        z11 = z[y0c + 1, x0c + 1]
        top = z00 + (z01 - z00) * tx
        bot = z10 + (z11 - z10) * tx
        out = top + (bot - top) * ty
        return np.where(ok, out, np.nan).astype(np.float32)
