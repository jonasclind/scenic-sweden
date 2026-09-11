"""Place the fine-grained spots on the wide map, so they can be located.

A 5 km crop has nothing recognisable in it. The same points drawn over the
50 km map sit next to Mjorn, Anten and the Vanern approaches, which is what
makes them identifiable.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from scenic import score as sc
from scenic.grid import metres_per_degree
from scenic.render import compose, downsample, draw_box, mark_spots
from scenic.viewshed import Signatures

DATA = Path("/Volumes/T7/scenic/pilot")
OUT = Path(__file__).resolve().parents[1] / "out"
ALINGSAS = (57.930, 12.533)
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def load(name: str) -> Signatures:
    d = np.load(DATA / name)
    return Signatures(x=d["x"], y=d["y"], ground=d["ground"], horizon=d["horizon"],
                      max_dist=d["max_dist"], water_near=d["water_near"],
                      water_far=d["water_far"], on_water=d["on_water"],
                      n_azimuth=int(d["n_azimuth"]))


def ranked(sig: Signatures, count: int, sep_m: float):
    n = int(round(np.sqrt(sig.x.size)))
    step = (sig.x.max() - sig.x.min()) / (n - 1)
    r = sc.apply(sig, sc.Filters())
    v = np.where(r["keep"], r["openness"], 0.0)
    rb = sc.robust(v, (n, n), step)
    return n, step, rb, sc.top_spots(rb, (n, n), sig, n=count,
                                     separation_cells=max(3, int(sep_m / step)))


def main():
    fine = load("alingsas_picnic_25m.npz")
    wide = load("alingsas_picnic_100m.npz")
    _, _, _, spots = ranked(fine, 12, 500.0)

    nw, stepw, rbw, _ = ranked(wide, 0, 1500.0)
    span = stepw * (nw - 1)
    up = max(2, int(round(1100 / nw)))
    terrain = downsample(wide.ground.reshape(nw, nw), nw, nw)
    img = compose(rbw.reshape(nw, nw), terrain, stepw,
                  water=wide.on_water.reshape(nw, nw), upscale=up)
    img = draw_box(img, 2500.0, span, "5 km box")
    img = mark_spots(img, spots, -span / 2, -span / 2, span, up)
    p = OUT / "alingsas_context_50km.png"
    img.save(p)
    print(f"wrote {p.name}  ({img.width}x{img.height}, 50 km across)")

    m_lat, m_lon = metres_per_degree(ALINGSAS[0])
    print("\nopen these to see what is actually there:\n")
    for k, s in enumerate(spots, 1):
        la = ALINGSAS[0] + s["y"] / m_lat
        lo = ALINGSAS[1] + s["x"] / m_lon
        d = np.hypot(s["x"], s["y"]) / 1000
        b = COMPASS[int(round(np.degrees(np.arctan2(s["x"], s["y"])) % 360 / 22.5)) % 16]
        print(f"{k:2d}. {d:4.1f} km {b:>3s}  {s['ground']:3.0f} m  "
              f"view {s['score']/1000:4.1f} km  "
              f"https://www.google.com/maps/search/?api=1&query={la:.5f},{lo:.5f}")


if __name__ == "__main__":
    main()
