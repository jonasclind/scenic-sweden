"""Fetch Meta/WRI canopy height tiles covering the region.

Public S3, no credentials. CC BY 4.0: "Meta and World Resources Institute (WRI)
- 2024. High Resolution Canopy Height Maps (CHM). Source imagery for CHM (c)
2016 Maxar."

These are ~0.6 m on the ground at our latitude, which is far finer than we need;
what matters is that they are real per-pixel heights instead of one number for
every forest in the country.
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scenic import safe

BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float"
OUT = Path("/Volumes/T7/scenic/canopy")
LAT0, LAT1, LON0, LON1 = 55.30, 59.20, 11.10, 14.60
PAD = 0.55                       # the view halo reaches past the region


def main():
    safe.ensure_dir(OUT)
    idx = OUT / "tiles.geojson"
    if not idx.exists():
        print("fetching tile index...")
        urllib.request.urlretrieve(f"{BASE}/tiles.geojson", idx)

    feats = json.loads(idx.read_text())["features"]
    want = []
    for t in feats:
        c = t["geometry"]["coordinates"][0]
        xs = [p[0] for p in c]; ys = [p[1] for p in c]
        if (max(xs) > LON0 - PAD and min(xs) < LON1 + PAD
                and max(ys) > LAT0 - PAD and min(ys) < LAT1 + PAD):
            want.append(t["properties"]["tile"])
    print(f"{len(want)} tiles cover the region (+{PAD} deg halo)")

    total = 0
    for i, name in enumerate(sorted(want), 1):
        dst = safe.guard(OUT / f"{name}.tif")
        if dst.exists() and dst.stat().st_size > 0:
            total += dst.stat().st_size
            continue
        tmp = dst.with_suffix(".part")
        urllib.request.urlretrieve(f"{BASE}/chm/{name}.tif", tmp)
        tmp.rename(dst)
        total += dst.stat().st_size
        print(f"  [{i:2d}/{len(want)}] {name}  {dst.stat().st_size/1e6:5.1f} MB", flush=True)
    print(f"\n{len(want)} tiles, {total/1e9:.2f} GB in {OUT}")


if __name__ == "__main__":
    main()
