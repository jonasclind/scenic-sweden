"""Local metric grid.

Over a 100 km box at 58N a local equirectangular projection about the box
centre is accurate to well under 0.5%, which is far below the noise floor of a
30 m DEM. Phase 2 moves to SWEREF 99 TM; keeping the projection behind this
class is what makes that a one-file change.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .tessadem import Mosaic


def metres_per_degree(lat_deg: float) -> tuple[float, float]:
    """(north, east) metres per degree at a latitude, WGS84."""
    p = np.radians(lat_deg)
    m_lat = 111132.92 - 559.82 * np.cos(2 * p) + 1.175 * np.cos(4 * p)
    m_lon = 111412.84 * np.cos(p) - 93.5 * np.cos(3 * p)
    return float(m_lat), float(m_lon)


@dataclass
class LocalGrid:
    """Elevation on a regular metric grid. x runs east, y runs north."""
    z: np.ndarray          # (ny, nx) metres, row 0 is the SOUTH edge
    x0: float              # metres east of origin at column 0
    y0: float              # metres north of origin at row 0
    step: float            # metres
    lat0: float            # projection origin
    lon0: float

    @property
    def shape(self):
        return self.z.shape

    def xy_to_lonlat(self, x, y):
        m_lat, m_lon = metres_per_degree(self.lat0)
        return self.lon0 + np.asarray(x) / m_lon, self.lat0 + np.asarray(y) / m_lat

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Bilinear sample in metres. Outside the grid yields NaN."""
        fx = (x - self.x0) / self.step
        fy = (y - self.y0) / self.step
        ny, nx = self.z.shape

        ix = np.floor(fx).astype(np.int64)
        iy = np.floor(fy).astype(np.int64)
        tx = (fx - ix).astype(np.float32)
        ty = (fy - iy).astype(np.float32)

        ok = (ix >= 0) & (ix < nx - 1) & (iy >= 0) & (iy < ny - 1)
        ixc = np.clip(ix, 0, nx - 2)
        iyc = np.clip(iy, 0, ny - 2)

        z = self.z
        z00 = z[iyc, ixc]
        z01 = z[iyc, ixc + 1]
        z10 = z[iyc + 1, ixc]
        z11 = z[iyc + 1, ixc + 1]
        bot = z00 + (z01 - z00) * tx
        top = z10 + (z11 - z10) * tx
        out = bot + (top - bot) * ty
        return np.where(ok, out, np.nan).astype(np.float32)

    def sample_nearest_bool(self, mask: np.ndarray, x, y) -> np.ndarray:
        fx = np.rint((x - self.x0) / self.step).astype(np.int64)
        fy = np.rint((y - self.y0) / self.step).astype(np.int64)
        ny, nx = mask.shape
        ok = (fx >= 0) & (fx < nx) & (fy >= 0) & (fy < ny)
        return np.where(ok, mask[np.clip(fy, 0, ny - 1), np.clip(fx, 0, nx - 1)], False)


def build_local_grid(mosaic: Mosaic, lat0: float, lon0: float,
                     half_km: float, step_m: float) -> LocalGrid:
    """Resample a lat/lon mosaic onto a metric grid centred on (lat0, lon0)."""
    m_lat, m_lon = metres_per_degree(lat0)
    half = half_km * 1000.0
    n = int(round(2 * half / step_m)) + 1
    ax = (np.arange(n, dtype=np.float64) - (n - 1) / 2) * step_m
    ay = ax.copy()
    X, Y = np.meshgrid(ax, ay)          # row 0 = south
    lon = lon0 + X / m_lon
    lat = lat0 + Y / m_lat
    z = mosaic.sample(lat, lon)
    return LocalGrid(z=z, x0=float(ax[0]), y0=float(ay[0]), step=float(step_m),
                     lat0=lat0, lon0=lon0)
