"""Reduce the Meta canopy tiles to one region raster the build can sample.

The source tiles are 65536 square at ~0.6 m, deflate-compressed with one row per
block and no overviews, so even a decimated read has to decompress the whole
4.3 GB. Doing that inside the 45-tile region build - where each tile would touch
several canopy tiles - is out of the question, so it happens once here.

Two statistics come out of it, because the canopy answers two different
questions:

  max   the upper envelope, which is what stops a view. A ray grazing a forest
        is blocked by the tallest trees in its path, not the average ones.
  mean  typical cover at a spot, which is what decides whether you could stand
        there in the open.

The output grid is Web Mercator aligned to the source tile grid, so every tile
maps onto an exact 2048 x 2048 block with no resampling seam.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import rasterio

from scenic import safe

# Web Mercator needs two different constants and they are easy to confuse:
# HALF is half the world width (pi * earth radius) and scales longitude, while
# the y formula scales by the earth radius itself. Using HALF for both puts
# every row out by a factor of pi.
HALF = 20037508.342789244
R_EARTH = 6378137.0
TILES_ACROSS = 512                      # the source tiles are a z9 grid
SUB = 2048                              # target cells per tile edge
CELL = 2 * HALF / (TILES_ACROSS * SUB)  # ~38.2 Mercator m, ~21 m on the ground here
STRIPE = 512                            # source rows per read

SRC = Path("/Volumes/T7/scenic/canopy")
OUT = Path("/Volumes/T7/scenic/canopy_region")
LAT0, LAT1, LON0, LON1 = 55.30, 59.20, 11.10, 14.60
PAD = 0.55


def merc(lon, lat):
    x = lon / 180.0 * HALF
    y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R_EARTH
    return x, y


def main():
    safe.ensure_dir(OUT)
    x0, y0 = merc(LON0 - PAD, LAT0 - PAD)
    x1, y1 = merc(LON1 + PAD, LAT1 + PAD)
    c0 = int(np.floor((x0 + HALF) / CELL)); c1 = int(np.ceil((x1 + HALF) / CELL))
    r0 = int(np.floor((HALF - y1) / CELL)); r1 = int(np.ceil((HALF - y0) / CELL))
    W, H = c1 - c0, r1 - r0
    print(f"canopy raster {H} x {W} cells at {CELL:.2f} Mercator m "
          f"(~{CELL*np.cos(np.radians(57.2)):.1f} m on the ground)")
    print(f"  {H*W/1e6:.0f}M cells, {H*W*2/1e9:.2f} GB for both statistics")

    def mm(name):
        p = safe.guard(OUT / name)
        return np.memmap(p, dtype=np.uint8, mode="r+" if p.exists() else "w+", shape=(H, W))

    cmax, cmean = mm("canopy_max.u8"), mm("canopy_mean.u8")
    state = OUT / "progress.json"
    done = set(json.loads(state.read_text())["done"]) if state.exists() else set()

    tifs = sorted(SRC.glob("[0-9]*.tif"))
    print(f"{len(tifs)} source tiles, {len(done)} already reduced\n")
    t_start, n_here, n_written = time.time(), 0, 0

    for p in tifs:
        if p.name in done:
            continue
        t0 = time.time()
        with rasterio.open(p) as src:
            tw = 2 * HALF / TILES_ACROSS
            tc = int(round((src.bounds.left + HALF) / tw))
            tr = int(round((HALF - src.bounds.top) / tw))
            gc, gr = tc * SUB, tr * SUB                    # this tile's global cell origin
            # intersection with the region window
            ic0, ic1 = max(gc, c0), min(gc + SUB, c1)
            ir0, ir1 = max(gr, r0), min(gr + SUB, r1)
            if ic0 >= ic1 or ir0 >= ir1:
                done.add(p.name); state.write_text(json.dumps({"done": sorted(done)}))
                continue
            n_written += 1

            f = src.height // SUB                          # source px per target cell
            for tr_lo in range(ir0, ir1, STRIPE // f):
                tr_hi = min(tr_lo + STRIPE // f, ir1)
                srow = (tr_lo - gr) * f
                block = src.read(1, window=((srow, srow + (tr_hi - tr_lo) * f), (0, src.width)))
                b = block.reshape(tr_hi - tr_lo, f, SUB, f)
                mx = b.max(axis=(1, 3))
                mn = b.mean(axis=(1, 3))
                sl_c = slice(ic0 - gc, ic1 - gc)
                cmax[tr_lo - r0:tr_hi - r0, ic0 - c0:ic1 - c0] = mx[:, sl_c]
                cmean[tr_lo - r0:tr_hi - r0, ic0 - c0:ic1 - c0] = np.rint(mn[:, sl_c])

        done.add(p.name)
        state.write_text(json.dumps({"done": sorted(done)}))
        n_here += 1
        el = time.time() - t_start
        left = (len(tifs) - len(done)) * el / n_here
        print(f"[{len(done):2d}/{len(tifs)}] {p.stem}  {time.time()-t0:5.1f}s  "
              f"eta {left/60:5.1f} min", flush=True)

    # A window that intersects nothing means the projection is wrong, not that
    # the work is done. Failing loudly here is the difference between a bad
    # build and a silent one: the first version of this scaled y by the wrong
    # radius, matched no tile at all, and reported success in 0.0 minutes.
    if n_written == 0 and len(done) < len(tifs):
        raise SystemExit("no source tile intersected the region window - "
                         "check the projection constants")
    for m in (cmax, cmean):
        m.flush()
    (OUT / "canopy.json").write_text(json.dumps(dict(
        cell=CELL, col0=c0, row0=r0, cols=W, rows=H,
        half=HALF, r_earth=R_EARTH,
        note="Web Mercator, aligned to the Meta z9 tile grid"), indent=2))
    print(f"\ndone in {(time.time()-t_start)/60:.1f} min")


if __name__ == "__main__":
    main()
