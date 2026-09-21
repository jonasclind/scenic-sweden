"""Assemble a deployable copy of the site in dist/, with every payload gzipped.

Compression happens here rather than at the host. Static hosts negotiate
Content-Encoding for text types but not for application/octet-stream, which is
what a .bin is - so without this step a phone downloads 41 MB for the first
screen. The client inflates with DecompressionStream, which means the deploy
target needs no configuration beyond serving files as-is.

The measured ratios on this data: the distance arrays give back roughly half
to three quarters, and everything else - drop, canopy, valid, elev - 90-97%,
because those are smooth and heavily quantised.

Each build stamps a `build` id into meta.json, which the client appends to
every payload URL. That is what makes the year-long immutable caching in
_headers safe: a rebuild changes the query, so nothing serves stale data.
"""
import gzip
import json
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DIST = ROOT / "dist"
LEVEL = 6          # -9 buys ~1% here for three times the work

# Cloudflare Pages and friends: one year, immutable, safe because of the build
# query. meta.json and the app shell must revalidate or a deploy never lands.
# The payload rules name L0/L1 rather than /region/* so that nothing overlaps
# meta.json: the order in which a host resolves two matching rules is not
# something worth betting a stale deploy on.
HEADERS = """\
/region/L0/*
  Cache-Control: public, max-age=31536000, immutable

/region/L1/*
  Cache-Control: public, max-age=31536000, immutable

/layers/*
  Cache-Control: public, max-age=31536000, immutable

/region/meta.json
  Cache-Control: no-cache

/*.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/
  Cache-Control: no-cache
"""


def compress(job):
    src, dst = job
    dst.parent.mkdir(parents=True, exist_ok=True)
    raw = src.read_bytes()
    # mtime=0 so a rebuild of unchanged input produces identical bytes, which
    # keeps `wrangler deploy` from re-uploading the whole region every time.
    with gzip.GzipFile(filename=str(dst), mode="wb", compresslevel=LEVEL, mtime=0) as f:
        f.write(raw)
    return len(raw), dst.stat().st_size


def mb(n):
    return f"{n / 1e6:,.1f} MB"


def main():
    region = WEB / "region"
    if not (region / "meta.json").exists():
        sys.exit(f"no packed region at {region} - run scripts/sync_region.sh")

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    # The app shell. AppleDouble junk (._name) is an exFAT artefact of the T7
    # copy; uploading it would double the file count for nothing.
    for name in ("index.html", "app.js", "controls.js"):
        shutil.copy2(WEB / name, DIST / name)
    (DIST / "_headers").write_text(HEADERS)

    jobs = []
    for src in sorted(region.rglob("*.bin")):
        if src.name.startswith("._"):
            continue
        jobs.append((src, DIST / "region" / src.relative_to(region).with_suffix(".bin.gz")))
    for src in sorted((WEB / "layers").glob("*.geojson")):
        if src.name.startswith("._"):
            continue
        jobs.append((src, DIST / "layers" / (src.name + ".gz")))

    if not jobs:
        sys.exit("nothing to compress - is web/region populated?")

    build = str(int(time.time()))
    meta = json.loads((region / "meta.json").read_text())
    meta["build"] = build
    meta["bin_ext"] = ".bin.gz"
    meta["geojson_ext"] = ".geojson.gz"
    (DIST / "region").mkdir(parents=True, exist_ok=True)
    (DIST / "region" / "meta.json").write_text(json.dumps(meta, indent=2))

    print(f"compressing {len(jobs)} files -> {DIST}")
    raw = out = done = 0
    with ProcessPoolExecutor() as pool:
        for a, b in pool.map(compress, jobs, chunksize=8):
            raw += a
            out += b
            done += 1
            if done % 200 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}  {mb(raw)} -> {mb(out)}", flush=True)

    files = sum(1 for _ in DIST.rglob("*") if _.is_file())
    print(f"\n{mb(raw)} -> {mb(out)}  ({100 * (1 - out / raw):.0f}% saved)")
    print(f"{files} files, {sum(f.stat().st_size for f in DIST.rglob('*') if f.is_file()) / 1e9:.2f} GB on disk")
    print(f"build id {build}")


if __name__ == "__main__":
    main()
