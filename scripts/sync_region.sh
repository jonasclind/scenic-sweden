#!/bin/sh
# Copy the packed region into web/ so the site is self-contained.
#
# The preview server runs sandboxed and cannot read external volumes, so
# serving the region straight off the T7 works from a hand-started server and
# 404s under the launcher. 2 GB on the internal disk buys a site that does not
# depend on which drive is plugged in.
set -e
SRC=/Volumes/T7/scenic/region_web
DST="$(cd "$(dirname "$0")/.." && pwd)/web/region"
[ -d "$SRC" ] || { echo "no packed region at $SRC - run pack_region.py"; exit 1; }
mkdir -p "$DST"
rsync -a --delete "$SRC/" "$DST/"
echo "synced $(du -sh "$DST" | cut -f1) to $DST"
