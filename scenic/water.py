"""Water mask.

Global DEMs flatten water bodies, so lakes show up as exactly level patches.
That is a good enough proxy for the pilot; phase 2 swaps in Lantmateriet
Topografi 50 polygons, which also give us names and real shorelines.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage


def detect_water(z: np.ndarray, step_m: float, flat_tol: float = 0.01,
                 min_area_ha: float = 10.0, sea_level: float = 0.5) -> np.ndarray:
    """Boolean mask of sea plus lakes of at least `min_area_ha` hectares.

    `flat_tol` is deliberately tiny. DEM water surfaces are essentially exactly
    level, whereas flat farmland is not: at 0.30 m the Alingsas valley fields
    were being called lakes, which silently excluded those cells as viewpoints.
    """
    zf = np.where(np.isfinite(z), z, np.inf).astype(np.float32)

    hi = ndimage.maximum_filter(zf, size=3, mode="nearest")
    lo = ndimage.minimum_filter(np.where(np.isfinite(z), z, -np.inf).astype(np.float32),
                                size=3, mode="nearest")
    flat = np.isfinite(z) & ((hi - lo) <= flat_tol)
    sea = np.isfinite(z) & (z <= sea_level)

    cand = flat | sea
    lab, n = ndimage.label(cand)
    if n == 0:
        return np.zeros_like(cand)

    cell_area = step_m * step_m
    min_cells = max(1, int(round(min_area_ha * 10_000.0 / cell_area)))
    counts = np.bincount(lab.ravel())
    keep = counts >= min_cells
    keep[0] = False
    return keep[lab]
