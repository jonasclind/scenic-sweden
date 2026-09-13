"""View signature computation.

For each observer and each azimuth bin we record how far and how openly the
view reaches. The primitive is the running maximum elevation angle: a point is
visible only if its angle from the eye exceeds every angle seen closer in.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .grid import LocalGrid

R_EARTH = 6371008.8
K_REFRACTION = 0.13          # standard atmosphere
R_EFF = R_EARTH / (1 - K_REFRACTION)


def radial_steps(max_dist: float = 20000.0, near_step: float = 25.0,
                 growth: float = 0.025, max_step: float = 100.0) -> np.ndarray:
    """Distances to sample along a ray.

    Steps grow with distance so a ray costs ~250 samples instead of ~800. The
    growth rate bounds how much angular extent we can step over: an occluder
    narrower than `growth` of its own distance can be missed. Phase 2 replaces
    this with a max-pooled pyramid, which cannot miss an occluder.
    """
    ds = []
    d = 0.0
    while d < max_dist:
        d += float(np.clip(d * growth, near_step, max_step))
        ds.append(min(d, max_dist))
    return np.asarray(ds, dtype=np.float64)


@dataclass
class Signatures:
    """Per-observer, per-azimuth view metrics. Azimuth 0 = north, clockwise."""
    x: np.ndarray              # (n,) observer easting
    y: np.ndarray              # (n,) observer northing
    ground: np.ndarray         # (n,) ground elevation
    horizon: np.ndarray        # (n, a) horizon elevation angle, radians
    max_dist: np.ndarray       # (n, a) farthest visible distance, metres
    water_near: np.ndarray     # (n, a) nearest visible water, inf if none
    water_far: np.ndarray      # (n, a) farthest visible water, 0 if none
    on_water: np.ndarray       # (n,) observer is itself standing in water
    n_azimuth: int

    def azimuth_deg(self) -> np.ndarray:
        return np.arange(self.n_azimuth) * (360.0 / self.n_azimuth)


def compute(grid: LocalGrid, ox: np.ndarray, oy: np.ndarray,
            eye_height: float = 1.7, n_azimuth: int = 32,
            water_mask: np.ndarray | None = None,
            max_dist: float = 20000.0, chunk: int = 32768,
            surface: LocalGrid | None = None,
            progress=None) -> Signatures:
    """View signatures for every observer.

    `grid` is what observers stand on; `surface` is what blocks them. Pass a
    surface to model vegetation and buildings: you stand on the ground, under
    the trees, and it is the canopy that takes your view away. With no surface
    the two are the same and every result is a clear-felled view.
    """
    blocking = surface if surface is not None else grid
    ox = np.asarray(ox, dtype=np.float64).ravel()
    oy = np.asarray(oy, dtype=np.float64).ravel()
    n = ox.size

    ds = radial_steps(max_dist=max_dist)
    drops = (ds ** 2) / (2 * R_EFF)          # curvature + refraction

    ground = np.empty(n, np.float32)
    on_water = np.zeros(n, bool)
    horizon = np.empty((n, n_azimuth), np.float32)
    max_d = np.empty((n, n_azimuth), np.float32)
    w_near = np.empty((n, n_azimuth), np.float32)
    w_far = np.empty((n, n_azimuth), np.float32)

    thetas = 2 * np.pi * np.arange(n_azimuth) / n_azimuth
    total = int(np.ceil(n / chunk)) * n_azimuth
    done = 0

    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        cx, cy = ox[s:e], oy[s:e]
        g = grid.sample(cx, cy)
        ground[s:e] = g
        if water_mask is not None:
            on_water[s:e] = grid.sample_nearest_bool(water_mask, cx, cy)
        z0 = g.astype(np.float64) + eye_height

        for a, th in enumerate(thetas):
            dx, dy = np.sin(th), np.cos(th)
            run = np.full(e - s, -np.inf)
            md = np.zeros(e - s)
            wn = np.full(e - s, np.inf)
            wf = np.zeros(e - s)

            for d, drop in zip(ds, drops):
                sx = cx + dx * d
                sy = cy + dy * d
                h = blocking.sample(sx, sy)
                ang = (h - drop - z0) / d
                vis = ang > run                      # NaN compares False
                if vis.any():
                    md = np.where(vis, d, md)
                    if water_mask is not None:
                        w = vis & grid.sample_nearest_bool(water_mask, sx, sy)
                        wn = np.where(w & np.isinf(wn), d, wn)
                        wf = np.where(w, d, wf)
                    run = np.where(vis, ang, run)

            horizon[s:e, a] = run
            max_d[s:e, a] = md
            w_near[s:e, a] = wn
            w_far[s:e, a] = wf
            done += 1
            if progress and done % 32 == 0:
                progress(done, total)

    return Signatures(x=ox, y=oy, ground=ground, horizon=horizon,
                      max_dist=max_d, water_near=w_near, water_far=w_far,
                      on_water=on_water, n_azimuth=n_azimuth)


def compute_multi(grid: LocalGrid, ox: np.ndarray, oy: np.ndarray,
                  eye_heights, n_azimuth: int = 32,
                  water_mask: np.ndarray | None = None,
                  max_dist: float = 20000.0, chunk: int = 32768,
                  surface: LocalGrid | None = None,
                  progress=None):
    """Signatures for several eye heights in one pass over the terrain.

    Sampling the surface along a ray is most of the cost - the arithmetic that
    follows is a handful of vector ops on the same array. Computing each eye
    height separately repeats that gather for identical points, so this shares
    it: three heights cost far less than three runs.
    """
    ox = np.asarray(ox, dtype=np.float64).ravel()
    oy = np.asarray(oy, dtype=np.float64).ravel()
    eyes = [float(e) for e in eye_heights]
    n, E = ox.size, len(eyes)
    blocking = surface if surface is not None else grid

    ds = radial_steps(max_dist=max_dist)
    drops = (ds ** 2) / (2 * R_EFF)

    ground = np.empty(n, np.float32)
    on_water = np.zeros(n, bool)
    horizon = [np.empty((n, n_azimuth), np.float32) for _ in eyes]
    max_d = [np.empty((n, n_azimuth), np.float32) for _ in eyes]
    w_near = [np.empty((n, n_azimuth), np.float32) for _ in eyes]
    w_far = [np.empty((n, n_azimuth), np.float32) for _ in eyes]

    thetas = 2 * np.pi * np.arange(n_azimuth) / n_azimuth
    total = int(np.ceil(n / chunk)) * n_azimuth
    done = 0

    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        cx, cy = ox[s:e], oy[s:e]
        g = grid.sample(cx, cy)
        ground[s:e] = g
        if water_mask is not None:
            on_water[s:e] = grid.sample_nearest_bool(water_mask, cx, cy)
        z0s = [g.astype(np.float64) + h for h in eyes]

        for a, th in enumerate(thetas):
            dx, dy = np.sin(th), np.cos(th)
            runs = [np.full(e - s, -np.inf) for _ in eyes]
            mds = [np.zeros(e - s) for _ in eyes]
            wns = [np.full(e - s, np.inf) for _ in eyes]
            wfs = [np.zeros(e - s) for _ in eyes]

            for d, drop in zip(ds, drops):
                sx = cx + dx * d
                sy = cy + dy * d
                h = blocking.sample(sx, sy)          # the shared gather
                hd = h - drop

                viss, any_vis = [], None
                for i in range(E):
                    ang = (hd - z0s[i]) / d
                    v = ang > runs[i]                # NaN compares False
                    viss.append((ang, v))
                    any_vis = v if any_vis is None else (any_vis | v)

                if not any_vis.any():
                    continue
                wh = (grid.sample_nearest_bool(water_mask, sx, sy)
                      if water_mask is not None else None)
                for i, (ang, v) in enumerate(viss):
                    mds[i] = np.where(v, d, mds[i])
                    if wh is not None:
                        w = v & wh
                        wns[i] = np.where(w & np.isinf(wns[i]), d, wns[i])
                        wfs[i] = np.where(w, d, wfs[i])
                    runs[i] = np.where(v, ang, runs[i])

            for i in range(E):
                horizon[i][s:e, a] = runs[i]
                max_d[i][s:e, a] = mds[i]
                w_near[i][s:e, a] = wns[i]
                w_far[i][s:e, a] = wfs[i]
            done += 1
            if progress and done % 32 == 0:
                progress(done, total)

    return [Signatures(x=ox, y=oy, ground=ground, horizon=horizon[i],
                       max_dist=max_d[i], water_near=w_near[i], water_far=w_far[i],
                       on_water=on_water, n_azimuth=n_azimuth) for i in range(E)]
