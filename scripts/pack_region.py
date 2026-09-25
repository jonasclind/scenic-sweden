"""Slice the region arrays into something a browser can fetch.

One set is 294 MB for the whole region - 36x the Alingsas box - so the page
cannot hold it. Two levels solve it: a downsampled overview that covers
everything at once, and native-resolution tiles fetched for whatever is on
screen. Output goes to the T7 rather than into the repo, and serve.py exposes it
under /region/.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic import safe

SRC = Path("/Volumes/T7/scenic/region")
DST = Path("/Volumes/T7/scenic/region_web")


def block_mean(a, f):
    """Mean over f x f blocks, trimming any partial edge block."""
    r, c = a.shape[0] // f * f, a.shape[1] // f * f
    a = a[:r, :c]
    tail = a.shape[2:]
    return a.reshape(r // f, f, c // f, f, *tail).mean(axis=(1, 3))


def block_land(a, valid, f):
    """Each f x f block reshaped, with a matching land mask.

    Everything that describes what a viewer would find has to be reduced over
    the land in a block and nothing else. Water is not a place with a bad view,
    it is not a place at all - and averaging it in gave every block touching a
    shore the reach of the open water beside it. A strip of coast that can only
    see inland was credited with fifteen kilometres of lake, which drew a
    bright rim round every lake at the overview and put ranked spots out on the
    water; zooming in made them vanish, because at native resolution those
    cells are water and scored nothing.
    """
    r, c = a.shape[0] // f * f, a.shape[1] // f * f
    tail = a.shape[2:]
    blocks = np.asarray(a[:r, :c]).reshape(r // f, f, c // f, f, *tail)
    land = (np.asarray(valid[:r, :c]) > 0).reshape(r // f, f, c // f, f)
    return blocks, land


def block_land_mean(a, valid, f):
    """Mean over the land cells of each block; zero where a block has none."""
    blocks, land = block_land(a, valid, f)
    weight = land[..., None] if a.ndim > 2 else land
    weight = weight.astype(np.float32)
    total = (blocks.astype(np.float32) * weight).sum(axis=(1, 3))
    count = weight.sum(axis=(1, 3))
    return np.divide(total, count, out=np.zeros_like(total), where=count > 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overview-factor", type=int, default=4, help="100 m -> 400 m")
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--overview-only", action="store_true",
                    help="skip the detail level, for testing the client early")
    args = ap.parse_args()

    meta = json.loads((SRC / "region.json").read_text())
    R, C, A = meta["rows"], meta["cols"], meta["azimuths"]
    combos = [(v, e["cm"]) for v in meta["veg"] for e in meta["eyes"]]
    safe.ensure_dir(DST)

    def open_src(name, shape, dtype):
        return np.memmap(SRC / name, dtype=dtype, mode="r", shape=shape)

    elev = open_src("elev.i16", (R, C), np.int16)
    valid = open_src("valid.u8", (R, C), np.uint8)
    site = open_src("canopy.u8", (R, C), np.uint8)
    drop = open_src("drop.u8", (R, C, A), np.uint8)

    levels = []

    # ---- level 0: the whole region, downsampled ----
    f = args.overview_factor
    r0, c0 = R // f, C // f
    d0 = DST / "L0" / "0_0"
    d0.mkdir(parents=True, exist_ok=True)
    print(f"L0 overview {r0} x {c0} at {meta['obs_m']*f:.0f} m")
    # A block counts as land if any of its cells is. Elevation, though, stays
    # an average over all of them: the sun sweep reads it as a surface, and a
    # lake is as much a surface as a field.
    _, land = block_land(elev, valid, f)
    v0 = land.any(axis=(1, 3)).astype(np.uint8)
    e0 = np.rint(block_mean(np.asarray(elev, np.float32), f)).astype(np.int16)
    (d0 / "valid.bin").write_bytes(v0.tobytes())
    (d0 / "elev.bin").write_bytes(e0.tobytes())
    # The site filter wants the quietest cover on the land in the block - a
    # clearing inside a 400 m cell is somewhere you can actually stand - but
    # open water is not a clearing, so it does not get to supply the minimum.
    cover, _ = block_land(site, valid, f)
    s0 = np.where(land, cover, 255).min(axis=(1, 3))
    s0 = np.where(land.any(axis=(1, 3)), s0, 0).astype(np.uint8)
    (d0 / "canopy.bin").write_bytes(s0.tobytes())
    dr0 = np.empty((r0, c0, A), np.uint8)
    for y in range(0, r0 * f, 256 * f):
        ye = min(y + 256 * f, r0 * f)
        dr0[y // f: ye // f] = np.rint(
            block_land_mean(drop[y:ye], valid[y:ye], f)).astype(np.uint8)
    (d0 / "drop.bin").write_bytes(dr0.tobytes())
    for v, cm in combos:
        dist = open_src(f"dist_{v}_{cm}.u8", (R, C, A), np.uint8)
        water = open_src(f"water_{v}_{cm}.u32", (R, C), np.uint32)
        out = np.empty((r0, c0, A), np.uint8)
        step = max(1, 256 // f * f)
        for y in range(0, r0 * f, step * f):
            ye = min(y + step * f, r0 * f)
            out[y // f: ye // f] = np.rint(
                block_land_mean(dist[y:ye], valid[y:ye], f)).astype(np.uint8)
        # A block sees water if any of its *land* sees water. Taking the max
        # over every cell let the lake itself answer the question, so the
        # filter passed anything that merely touched a shore.
        seen, _ = block_land(water, valid, f)
        w0 = np.where(land, seen, 0).max(axis=(1, 3)).astype(np.uint32)
        (d0 / f"dist_{v}_{cm}.bin").write_bytes(out.tobytes())
        (d0 / f"water_{v}_{cm}.bin").write_bytes(w0.tobytes())
        print(f"  {v}_{cm}: {out.nbytes/1e6:.1f} MB")
    # Each level carries its own georeferencing. A downsampled cell represents
    # the centre of the native block it averages, not its corner, and getting
    # that half-block offset wrong slides the overlay off the terrain.
    dlat = (meta["lat1"] - meta["lat0"]) / (R - 1)
    dlon = (meta["lon1"] - meta["lon0"]) / (C - 1)
    levels.append(dict(id=0, step_m=meta["obs_m"] * f, rows=r0, cols=c0,
                       tile_rows=r0, tile_cols=c0, tiles_y=1, tiles_x=1,
                       lat0=meta["lat0"] + (f - 1) / 2 * dlat, dlat=f * dlat,
                       lon0=meta["lon0"] + (f - 1) / 2 * dlon, dlon=f * dlon))

    if args.overview_only:
        (DST / "meta.json").write_text(json.dumps(dict(
            lat0=meta["lat0"], lat1=meta["lat1"], lon0=meta["lon0"], lon1=meta["lon1"],
            azimuths=A, max_dist_km=meta["max_dist_km"],
            eyes=meta["eyes"], veg=meta["veg"], levels=levels,
            detail_min_zoom=99), indent=2))
        print("\noverview only; detail level skipped")
        return

    # ---- level 1: native resolution, tiled ----
    T = args.tile
    ty, tx = -(-R // T), -(-C // T)
    print(f"\nL1 detail {R} x {C} at {meta['obs_m']:.0f} m -> {ty} x {tx} tiles of {T}")
    written = 0
    for v, cm in combos:
        dist = open_src(f"dist_{v}_{cm}.u8", (R, C, A), np.uint8)
        water = open_src(f"water_{v}_{cm}.u32", (R, C), np.uint32)
        for iy in range(ty):
            for ix in range(tx):
                y0, x0 = iy * T, ix * T
                y1, x1 = min(y0 + T, R), min(x0 + T, C)
                d = DST / "L1" / f"{iy}_{ix}"
                d.mkdir(parents=True, exist_ok=True)
                (d / f"dist_{v}_{cm}.bin").write_bytes(
                    np.ascontiguousarray(dist[y0:y1, x0:x1]).tobytes())
                (d / f"water_{v}_{cm}.bin").write_bytes(
                    np.ascontiguousarray(water[y0:y1, x0:x1]).tobytes())
                written += 2
                if (v, cm) == combos[0]:
                    (d / "valid.bin").write_bytes(
                        np.ascontiguousarray(valid[y0:y1, x0:x1]).tobytes())
                    (d / "elev.bin").write_bytes(
                        np.ascontiguousarray(elev[y0:y1, x0:x1]).tobytes())
                    (d / "canopy.bin").write_bytes(
                        np.ascontiguousarray(site[y0:y1, x0:x1]).tobytes())
                    (d / "drop.bin").write_bytes(
                        np.ascontiguousarray(drop[y0:y1, x0:x1]).tobytes())
                    written += 4
        print(f"  {v}_{cm} packed")
    levels.append(dict(id=1, step_m=meta["obs_m"], rows=R, cols=C,
                       tile_rows=T, tile_cols=T, tiles_y=ty, tiles_x=tx,
                       lat0=meta["lat0"], dlat=dlat,
                       lon0=meta["lon0"], dlon=dlon))

    (DST / "meta.json").write_text(json.dumps(dict(
        lat0=meta["lat0"], lat1=meta["lat1"], lon0=meta["lon0"], lon1=meta["lon1"],
        azimuths=A, max_dist_km=meta["max_dist_km"],
        eyes=meta["eyes"], veg=meta["veg"], levels=levels,
        drop_scale=4.0, detail_min_zoom=10.5), indent=2))
    size = sum(p.stat().st_size for p in DST.rglob("*.bin"))
    print(f"\n{written:,} files, {size/1e9:.2f} GB in {DST}")


if __name__ == "__main__":
    main()
