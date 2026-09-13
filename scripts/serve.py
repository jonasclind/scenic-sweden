"""Static server for web/ that refuses to let the browser cache anything.

python -m http.server sends no cache headers at all, so browsers fall back to
heuristic freshness and quietly serve a stale app.js after you have edited it -
which looks exactly like a bug in the code you just changed.
"""
import functools
import http.server
import socketserver
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
ROOT = Path(__file__).resolve().parents[1] / "web"


REGION = Path("/Volumes/T7/scenic/region_web")


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
    httpd.serve_forever()
