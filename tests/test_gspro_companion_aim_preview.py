"""Auto Aim step 1: aim preview from the minimap's ball and pin dots. No input.

Synthetic frames only. The same code was checked offline on five real FarmLinks
frames (bunker centroids land on sand; the mirrored solution lands on grass).
"""
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
import json
import math
import sys
import threading
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_native_aim as aim  # noqa: E402

W, H = 1920, 1080
ORIGIN = {"Origin": "https://thelooper.golf"}


def synthetic_frame(ball_px, pin_px, *, red_line=True):
    """A GSPro-like window: grass, a red OB line, red ball dot, white pin dot."""
    frame = np.full((H, W, 3), (40, 110, 50), np.uint8)
    x0, y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
    if red_line:
        cv2.line(frame, (x0 + 5, y0 + 300), (x0 + 270, y0 + 260), (0, 0, 230), 3)
    cv2.circle(frame, (x0 + ball_px[0], y0 + ball_px[1]), 5, (0, 0, 235), -1)
    cv2.circle(frame, (x0 + pin_px[0], y0 + pin_px[1]), 5, (255, 255, 255), -1)
    return frame


class AimMathTests(unittest.TestCase):
    def test_frame_maps_ball_and_pin_and_inverts(self):
        frame = aim.solve_minimap_frame((100.0, 50.0), (100.0, 250.0), aim.Pixel(140, 400), aim.Pixel(140, 60))
        b = frame.to_pixel(100.0, 50.0)
        p = frame.to_pixel(100.0, 250.0)
        self.assertAlmostEqual(b.x, 140); self.assertAlmostEqual(b.y, 400)
        self.assertAlmostEqual(p.x, 140); self.assertAlmostEqual(p.y, 60)
        # North is up here; a point 10 m east of the line lands right of it.
        east = frame.to_pixel(110.0, 150.0)
        self.assertGreater(east.x, 140)
        x, z = frame.to_world(east)
        self.assertAlmostEqual(x, 110.0); self.assertAlmostEqual(z, 150.0)
        self.assertAlmostEqual(frame.yards_per_pixel, 200 * aim.METERS_TO_YARDS / 340)

    def test_rotated_hole(self):
        # Ball->pin heading east in the world; GSPro still draws it straight up.
        frame = aim.solve_minimap_frame((0.0, 0.0), (200.0, 0.0), aim.Pixel(140, 400), aim.Pixel(140, 60))
        north = frame.to_pixel(100.0, 20.0)   # 20 m north of the line = left when facing east
        self.assertLess(north.x, 140)

    def test_preview_on_synthetic_frame(self):
        img = synthetic_frame((140, 400), (140, 60))
        ball_w, pin_w = (100.0, 50.0), (100.0, 250.0)
        result = aim.aim_preview(img, ball_world=ball_w, pin_world=pin_w, target_world=(110.0, 200.0))
        self.assertEqual(result["status"], "ready")
        self.assertAlmostEqual(result["minimap"]["ball"][0], 140, delta=1)
        self.assertAlmostEqual(result["minimap"]["pin"][1], 60, delta=1)
        tx, ty = result["minimap"]["target"]
        self.assertGreater(tx, 140, "east of the line is right")
        self.assertAlmostEqual(ty, 400 - 150 * 340 / 200, delta=1.5)
        self.assertTrue(result["checks"]["alignedLikeGspro"])
        self.assertIsNotNone(result["click"])
        self.assertTrue(result["previewPng"])

    def test_off_map_and_failures(self):
        img = synthetic_frame((140, 400), (140, 60))
        far = aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(900.0, 200.0))
        self.assertEqual(far["status"], "target-off-map")
        self.assertIsNone(far["click"])
        with self.assertRaises(RuntimeError):
            aim.aim_preview(np.full((H, W, 3), (40, 110, 50), np.uint8),
                            ball_world=(0, 0), pin_world=(0, 100), target_world=(0, 50))
        with self.assertRaises(ValueError):
            aim.aim_preview(img, ball_world=(math.nan, 0), pin_world=(0, 100), target_world=(0, 50))


@contextmanager
def running_service():
    import looper_companion as companion
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def get(port, path, headers):
    client = HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        client.request("GET", path, headers={**headers, "Host": f"127.0.0.1:{port}"})
        response = client.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw else {}
    finally:
        client.close()


QUERY = "/companion/v1/aim-preview?ballX=100&ballZ=50&pinX=100&pinZ=250&targetX=110&targetZ=200"


class AimPreviewEndpointTests(unittest.TestCase):
    def test_endpoint(self):
        import looper_companion as companion
        frame = synthetic_frame((140, 400), (140, 60))
        with mock.patch.object(companion.native, "find_gspro_window", return_value={"status": "connected"}), \
                mock.patch.object(companion.minimap_pipeline, "capture_native_bgr", return_value=frame), \
                running_service() as port:
            status, body = get(port, QUERY, ORIGIN)
            self.assertEqual(status, 200)
            self.assertEqual(body["status"], "ready")
            self.assertEqual(body["input"], "none")
            self.assertIn("windowX", body["click"])
            status, body = get(port, QUERY, {"Origin": "https://evil.example"})
            self.assertEqual(status, 403)
            self.assertNotIn("previewPng", body)
            _, body = get(port, "/companion/v1/aim-preview?ballX=1", ORIGIN)
            self.assertEqual(body["status"], "invalid-request")
        with mock.patch.object(companion.native, "find_gspro_window", return_value={"status": "waiting"}), \
                running_service() as port:
            _, body = get(port, QUERY, ORIGIN)
            self.assertEqual(body["status"], "gspro-not-connected")

    def test_no_input_endpoint(self):
        with running_service() as port:
            client = HTTPConnection("127.0.0.1", port, timeout=5)
            client.request("POST", "/companion/v1/aim-preview", body=b"{}",
                           headers={**ORIGIN, "Host": f"127.0.0.1:{port}", "Content-Type": "application/json"})
            self.assertEqual(client.getresponse().status, 405)
            client.close()


if __name__ == "__main__":
    unittest.main()
