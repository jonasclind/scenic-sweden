"""Turning view signatures into scores.

Both modes read the same signature; only the weights differ. Keeping this
separate from the kernel is the point - the scoring is the part most likely to
need tuning against taste, and it must never require recomputing signatures.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .viewshed import Signatures

MODES = {
    # eye height is applied at signature time, not here
    "plot":   dict(eye_height=5.0),
    "picnic": dict(eye_height=1.7),
}


@dataclass
class Filters:
    """UI state. All of this is arithmetic over 32 numbers per location."""
    min_distance: float = 0.0          # metres a view must reach to count
    directions: tuple | None = None    # (from_deg, to_deg) clockwise wedge, None = all
    require_water: bool = False
    min_water_distance: float = 0.0    # ignore the pond in the next field


def direction_mask(n_azimuth: int, directions) -> np.ndarray:
    if directions is None:
        return np.ones(n_azimuth, bool)
    a0, a1 = (d % 360.0 for d in directions)
    az = np.arange(n_azimuth) * (360.0 / n_azimuth)
    return (az >= a0) & (az <= a1) if a0 <= a1 else (az >= a0) | (az <= a1)


def apply(sig: Signatures, f: Filters) -> dict:
    """Return per-observer metrics under the given filters."""
    sel = direction_mask(sig.n_azimuth, f.directions)
    dist = sig.max_dist[:, sel]

    reach = np.where(dist >= f.min_distance, dist, 0.0)
    openness = reach.mean(axis=1)
    best_idx = np.argmax(reach, axis=1)
    best_dist = reach[np.arange(reach.shape[0]), best_idx]
    best_dir = np.flatnonzero(sel)[best_idx] * (360.0 / sig.n_azimuth)

    wfar = sig.water_far[:, sel]
    water_ok = (wfar >= max(f.min_water_distance, 1.0)).any(axis=1)
    water_best = wfar.max(axis=1)

    # You cannot stand in a lake. Observers on water see everything in every
    # direction, so without this they dominate every ranking.
    keep = (best_dist >= f.min_distance) & ~sig.on_water & np.isfinite(sig.ground)
    if f.require_water:
        keep &= water_ok

    return dict(openness=openness, best_dist=best_dist, best_dir=best_dir,
                water_visible=water_ok, water_dist=water_best, keep=keep)


def sunset_azimuth(lat_deg: float, day_of_year: int) -> float:
    """Compass bearing of the sun at sunset, degrees clockwise from north.

    Standard solar declination approximation; good to well under a degree,
    which is far finer than our 11.25 degree azimuth bins.
    """
    decl = np.radians(-23.44) * np.cos(2 * np.pi * (day_of_year + 10) / 365.25)
    lat = np.radians(lat_deg)
    cos_az = np.sin(decl) / np.cos(lat)          # at h = 0
    sunrise = np.degrees(np.arccos(np.clip(cos_az, -1.0, 1.0)))
    return float(360.0 - sunrise)                # sunset mirrors sunrise about north
