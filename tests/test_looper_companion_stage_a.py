"""Stage A contract tests for the optional Windows Looper Companion.

Requires the existing opengolfcoach dependency (installed by companion CI).
These tests never inject desktop input or open GSPro.
"""

from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
import json
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import looper_companion as companion  # noqa: E402


@contextmanager
def running_service():
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def request(port, path, method="GET", headers=None, body=None):
    client = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        client.request(method, path, body=body, headers=headers or {})
        response = client.getresponse()
        raw = response.read()
        return response.status, dict(response.getheaders()), json.loads(raw) if raw else {}
    finally:
        client.close()


class LooperCompanionStageATests(unittest.TestCase):
    def test_origin_allowlist_is_exact(self):
        self.assertTrue(companion.is_allowed_origin("https://thelooper.golf"))
        self.assertTrue(companion.is_allowed_origin("https://www.thelooper.golf"))
        self.assertTrue(companion.is_allowed_origin("http://localhost:5173"))
        self.assertTrue(companion.is_allowed_origin(
            "https://looper-a123-wqk25hkxcg-3591.vercel.app"
        ))
        for invalid in (
            "https://thelooper.golf.attacker.invalid",
            "https://evil.example",
            "https://looper-a123-wqk25hkxcg-3591.vercel.app.attacker.invalid",
            "null",
            "https://looper-a123-other-team.vercel.app",
        ):
            self.assertFalse(companion.is_allowed_origin(invalid))

    def test_status_is_read_only_and_restricts_origins(self):
        with running_service() as port, mock.patch.object(
            companion, "discover_gspro_window",
            return_value={"status": "waiting", "reason": "test"},
        ):
            allowed = {"Origin": "https://thelooper.golf"}
            status, headers, payload = request(port, "/companion/v1/status", headers=allowed)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), allowed["Origin"])
            self.assertEqual(payload["service"], "looper-companion")
            self.assertEqual(payload["gspro"]["status"], "waiting")
            self.assertFalse(payload["capabilities"]["autoAim"])
            self.assertFalse(payload["capabilities"]["nativeCapture"])

            status, headers, payload = request(
                port, "/companion/v1/status",
                method="OPTIONS",
                headers={**allowed, "Access-Control-Request-Method": "GET"},
            )
            self.assertEqual(status, 204)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), allowed["Origin"])

            status, headers, payload = request(
                port, "/companion/v1/status",
                headers={"Origin": "https://attacker.example"},
            )
            self.assertEqual(status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)

            status, headers, payload = request(
                port, "/companion/v1/status",
                headers={"Origin": "https://thelooper.golf", "Host": "attacker.invalid"},
            )
            self.assertEqual(status, 403)

            status, headers, payload = request(
                port, "/companion/v1/aim",
                method="POST",
                headers={"Origin": "https://thelooper.golf", "Content-Type": "application/json"},
                body=b'{"click":true}',
            )
            self.assertEqual(status, 405)
            self.assertEqual(payload["error"], "actuation_not_implemented")

    def test_existing_health_endpoint_is_preserved(self):
        with running_service() as port:
            status, _headers, payload = request(port, "/health")
            self.assertEqual(status, 200)
            self.assertEqual(payload["service"], "open-golf-coach-helper")
            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["version"], "6-looper-companion")


if __name__ == "__main__":
    unittest.main()
