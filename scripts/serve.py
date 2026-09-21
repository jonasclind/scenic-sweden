"""Static server for web/ that refuses to let the browser cache anything.

python -m http.server sends no cache headers at all, so browsers fall back to
heuristic freshness and quietly serve a stale app.js after you have edited it -
which looks exactly like a bug in the code you just changed.
"""
import functools
import http.server
import os
import socketserver
import sys
from pathlib import Path

# PORT from the environment first, so a launcher can assign one; then an
# explicit argument; then a default for running it by hand.
argv = sys.argv[1:]
# --root serves a built copy instead of the working tree, which is the only way
# to try a deploy - gzipped payloads and all - before uploading it.
root = "web"
if "--root" in argv:
    i = argv.index("--root")
    root = argv[i + 1]
    del argv[i:i + 2]
PORT = int(os.environ.get("PORT") or (argv[0] if argv else 8731))
ROOT = Path(__file__).resolve().parents[1] / root


# The preview launcher runs sandboxed and cannot read external volumes, so a
# region served straight off the T7 works by hand and 404s under the launcher.
# Prefer a local copy (scripts/sync_region.sh) and fall back to the drive.
LOCAL_REGION = ROOT / "region"
REGION = LOCAL_REGION if LOCAL_REGION.is_dir() else Path("/Volumes/T7/scenic/region_web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # The packed region is gigabytes and lives on the T7, not in the repo.
        if path.startswith("/region/"):
            rel = path[len("/region/"):].split("?", 1)[0].lstrip("/")
            target = (REGION / rel).resolve()
            if REGION.resolve() in target.parents or target == REGION.resolve():
                return str(target)
            return str(REGION)          # refuse to escape the region directory
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), functools.partial(Handler, directory=str(ROOT))) as httpd:
    print(f"serving {ROOT} on http://localhost:{PORT} (no-store)")
    print(f"  region from {REGION}"
          f"{'' if REGION is LOCAL_REGION else '  [external drive - invisible to the sandboxed launcher]'}")
    httpd.serve_forever()
