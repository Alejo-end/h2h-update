"""Serves this folder on http://127.0.0.1:8765 and tells the browser never to keep
an old copy, so a new firmware or page version shows at the next reload."""
import http.server, functools, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *args):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
handler = functools.partial(NoCache, directory=os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
