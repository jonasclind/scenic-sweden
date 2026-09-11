"""Export score grids as Web Mercator overlays for a slippy map.

Two things matter here. The overlay must be reprojected: our grids are linear in
latitude, a web map is linear in Mercator y, and over 50 km at 58N the
difference is large enough to slide the heatmap off the terrain it describes -
which would defeat the whole point of putting it on a map to check it.

And the ramp is a single hue, light to dark, with alpha rising alongside. Low
scores fade to transparent so the basemap reads through; a multi-hue ramp over
satellite imagery competes with the ground it is meant to explain.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

# single-hue sequential, light -> dark, monotonic in lightness
RAMP = np.array([
    (0.996, 0.941, 0.851), (0.992, 0.851, 0.627), (0.976, 0.722, 0.361),
    (0.933, 0.565, 0.141), (0.812, 0.420, 0.043), (0.612, 0.290, 0.027),
])
RAMP_HEX = ["#FEF0D9", "#FDD9A0", "#F9B85C", "#EE9024", "#CF6B0B", "#9C4A07"]


def _merc_y(lat_deg):
    lat = np.radians(np.clip(lat_deg, -85.05, 85.05))
    return np.log(np.tan(np.pi / 4 + lat / 2))


def _inv_merc_y(y):
    return np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)


def to_mercator_png(score: np.ndarray, valid: np.ndarray, lat0: float, lon0: float,
                    half_m: float, m_lat: float, m_lon: float,
                    size: int = 1400, lo_hi=None):
    """Resample a centred metric grid onto a Mercator-linear image.

    Returns (PIL image RGBA, [west, south, east, north]).
    """
    n = score.shape[0]
    lat_s, lat_n = lat0 - half_m / m_lat, lat0 + half_m / m_lat
    lon_w, lon_e = lon0 - half_m / m_lon, lon0 + half_m / m_lon

    my = np.linspace(_merc_y(lat_n), _merc_y(lat_s), size)
    lat = _inv_merc_y(my)[:, None]
    lon = np.linspace(lon_w, lon_e, size)[None, :]

    # back into grid indices (row 0 of `score` is the south edge)
    fy = ((lat - lat0) * m_lat + half_m) / (2 * half_m) * (n - 1)
    fx = ((lon - lon0) * m_lon + half_m) / (2 * half_m) * (n - 1)
    iy = np.clip(np.rint(fy), 0, n - 1).astype(np.int32) * np.ones_like(fx, dtype=np.int32)
    ix = np.clip(np.rint(fx), 0, n - 1).astype(np.int32) * np.ones_like(fy, dtype=np.int32)

    s = score[iy, ix]
    v = valid[iy, ix]

    good = s[v & np.isfinite(s)]
    if lo_hi is None:
        lo, hi = (np.percentile(good, [5, 97]) if good.size else (0.0, 1.0))
    else:
        lo, hi = lo_hi
    t = np.clip((s - lo) / max(hi - lo, 1e-9), 0, 1)

    pos = t * (len(RAMP) - 1)
    i = np.clip(pos.astype(int), 0, len(RAMP) - 2)
    f = (pos - i)[..., None]
    rgb = RAMP[i] * (1 - f) + RAMP[i + 1] * f

    alpha = np.where(v & np.isfinite(s), 0.25 + 0.60 * t, 0.0)
    rgba = np.dstack([rgb, alpha])
    img = Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), mode="RGBA")
    return img, [float(lon_w), float(lat_s), float(lon_e), float(lat_n)], (float(lo), float(hi))
