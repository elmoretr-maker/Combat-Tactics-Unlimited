#!/usr/bin/env python3
"""
Serve the project root over HTTP so the game loads (ES modules + fetch() fail on file://).

Usage (from repo root):
  python tools/serve_dev.py
  python tools/serve_dev.py 9000

Then open: http://localhost:8080/
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 8080


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(directory), **kwargs)

    def do_GET(self):
        # Chrome DevTools probes this path; no file exists — avoid 404 log spam.
        path = urlparse(self.path).path
        if path.startswith("/.well-known/"):
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        line = format % args if args else format
        if ".well-known" in line:
            return
        try:
            sys.stderr.write("%s - %s\n" % (self.address_string(), line))
        except UnicodeEncodeError:
            sys.stderr.write(
                ("%s - %s\n" % (self.address_string(), line)).encode("ascii", "replace").decode("ascii")
            )


def main() -> int:
    # Avoid UnicodeEncodeError on Windows cp1252 when printing URLs, etc.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

    p = argparse.ArgumentParser(description="CTU static dev server")
    p.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT, help="port (default 8080)")
    args = p.parse_args()
    port = args.port
    handler = functools.partial(DevHandler, directory=ROOT)
    try:
        with socketserver.ThreadingTCPServer(("", port), handler) as httpd:
            print(f"CTU dev server: http://localhost:{port}/")
            print("Ctrl+C to stop.")
            httpd.serve_forever()
    except OSError as e:
        print(f"Could not bind port {port}: {e}", file=sys.stderr)
        print("Try another port: python tools/serve_dev.py 5500", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
