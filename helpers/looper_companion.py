#!/usr/bin/env python3
"""Looper Windows companion for the hosted web app.

Runs the existing OpenGolfCoach/GSPro localhost bridge as a background process,
with the proven minimap-footer lie reader installed and headers that allow the
HTTPS Looper web app to reach loopback safely.
"""

import json

import open_golf_coach_helper_lie_footer as lie_footer

base = lie_footer.base


class LooperCompanionHandler(base.OpenGolfCoachHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome's private/local-network access checks can preflight HTTPS ->
        # loopback requests. Explicitly opt in so the hosted Looper UI can use
        # the companion after the user grants local-network access.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status_code != 204:
            self.wfile.write(body)


base.HELPER_HEALTH_VERSION = "6-looper-companion"


if __name__ == "__main__":
    server = base.ThreadingHTTPServer((base.HOST, base.PORT), LooperCompanionHandler)
    server.serve_forever()
