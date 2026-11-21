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

    def test_any_ball_colour_is_found_under_the_pin(self):
                # GSPro's eight ball colours, as its colour picker shows them (BGR).
        colours = {"red": (38, 50, 209), "green": (61, 164, 22), "blue": (242, 127, 0), "yellow": (50, 193, 242),
                   "pink": (194, 64, 227), "teal": (179, 162, 22), "purple": (163, 46, 140), "orange": (13, 125, 193)}
        for name, bgr in colours.items():
            img = synthetic_frame((140, 400), (140, 60))
            x0, y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
            cv2.circle(img, (x0 + 140, y0 + 400), 5, bgr, -1)
            result = aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(110.0, 200.0))
            self.assertEqual(result["status"], "ready", name)
            self.assertAlmostEqual(result["minimap"]["ball"][0], 140, delta=1.5, msg=name)
            self.assertAlmostEqual(result["minimap"]["ball"][1], 400, delta=1.5, msg=name)
            self.assertEqual(result["minimap"]["side"], "right")

    def test_the_player_banner_says_which_colour_to_look_for(self):
        green, red = (61, 164, 22), (38, 50, 209)
        img = synthetic_frame((140, 400), (140, 60), red_line=False)
        x0, y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
        cv2.circle(img, (x0 + 140, y0 + 400), 5, green, -1)             # the ball is green
        cv2.circle(img, (x0 + 150, y0 + 430), 5, red, -1)               # a round red thing right beside it
        cv2.rectangle(img, (4, 22), (int(W * 0.2), 58), green, -1)      # the player's banner, in the ball's colour
        cv2.putText(img, "Brian", (12, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        self.assertAlmostEqual(aim.read_player_colour(img), 68, delta=4)
        result = aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(110.0, 200.0))
        self.assertAlmostEqual(result["minimap"]["ball"][0], 140, delta=1.5)
        self.assertAlmostEqual(result["minimap"]["ball"][1], 400, delta=1.5)
        # No banner to read (plain grass there): every ball colour is tried, as before.
        self.assertIsNone(aim.read_player_colour(synthetic_frame((140, 400), (140, 60))))
        cv2.rectangle(img, (4, 22), (int(W * 0.2), 58), red, -1)        # a red banner: the red dot is the ball
        self.assertIn(aim.read_player_colour(img), (0, 1, 2, 3, 4, 178, 179))

    def test_a_coloured_dot_away_from_the_pin_line_is_not_the_ball(self):
        img = synthetic_frame((140, 400), (140, 60))
        x0, y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
        cv2.circle(img, (x0 + 40, y0 + 380), 5, (0, 0, 235), -1)      # a round red thing off to the side
        cv2.circle(img, (x0 + 150, y0 + 150), 5, (0, 0, 235), -1)     # and one high up near the pin
        result = aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(110.0, 200.0))
        self.assertAlmostEqual(result["minimap"]["ball"][0], 140, delta=1.5)
        self.assertAlmostEqual(result["minimap"]["ball"][1], 400, delta=1.5)

    def test_minimap_on_the_left(self):
        right = synthetic_frame((140, 400), (140, 60), red_line=False)
        img = np.full_like(right, (40, 110, 50))
        rx0, ry0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
        lx0, ly0 = int(W * aim.LEFT_MINIMAP_ROI[0]), int(H * aim.LEFT_MINIMAP_ROI[1])
        img[ly0:ly0 + 470, lx0:lx0 + 280] = right[ry0:ry0 + 470, rx0:rx0 + 280]
        cv2.putText(img, "173.0", (rx0 + 60, ry0 + 90), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)  # data tiles, no map
        result = aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(110.0, 200.0))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["minimap"]["side"], "left")
        self.assertEqual(tuple(result["minimap"]["roi"]), aim.LEFT_MINIMAP_ROI)
        self.assertLess(result["click"]["windowX"], W * 0.16)
        self.assertAlmostEqual(result["minimap"]["ball"][0], 140, delta=1.5)

    def test_the_pin_is_found_at_any_screen_size(self):
        # Drawn as on a 4K screen (dots about 18 px across), then shown smaller.
        big = np.full((2160, 3840, 3), (40, 110, 50), np.uint8)
        x0, y0 = int(3840 * aim.RIGHT_MINIMAP_ROI[0]), int(2160 * aim.RIGHT_MINIMAP_ROI[1])
        cv2.circle(big, (x0 + 290, y0 + 860), 9, (0, 0, 235), -1, cv2.LINE_AA)
        cv2.circle(big, (x0 + 290, y0 + 175), 9, (255, 255, 255), -1, cv2.LINE_AA)
        for width, height in ((3840, 2160), (2560, 1440), (1920, 1080), (1600, 900)):
            frame = cv2.resize(big, (width, height), interpolation=cv2.INTER_AREA)
            crop, _origin, ball, pin, side, _roi = aim.locate_minimap(frame)
            scale = 3840 / width
            self.assertEqual(side, "right")
            self.assertAlmostEqual(pin.x * scale, 290, delta=4, msg=f"{width}x{height}")
            self.assertAlmostEqual(pin.y * scale, 175, delta=4, msg=f"{width}x{height}")
            self.assertAlmostEqual(ball.y * scale, 860, delta=4, msg=f"{width}x{height}")

    def test_a_ball_with_a_shine_in_its_middle_is_still_the_ball(self):
        # Payne's Valley, 19 Nov: the orange dot has a small light spot right at its centre.
        frame = np.full((2160, 3840, 3), (40, 110, 50), np.uint8)
        x0, y0 = int(3840 * aim.LEFT_MINIMAP_ROI[0]), int(2160 * aim.LEFT_MINIMAP_ROI[1])
        cv2.circle(frame, (x0 + 245, y0 + 860), 9, (20, 140, 250), -1, cv2.LINE_AA)   # orange
        cv2.rectangle(frame, (x0 + 244, y0 + 859), (x0 + 246, y0 + 860), (230, 240, 250), -1)
        cv2.circle(frame, (x0 + 242, y0 + 185), 9, (255, 255, 255), -1, cv2.LINE_AA)
        _crop, _origin, ball, _pin, side, _roi = aim.locate_minimap(frame)
        self.assertEqual(side, "left")
        self.assertAlmostEqual(ball.x, 245, delta=2)
        self.assertAlmostEqual(ball.y, 860, delta=2)

    def test_a_lit_purple_ball_and_a_white_bunker_beside_the_pin(self):
        # Payne's Valley, 19 Nov: the purple dot is dark on top, pink below, with a shine;
        # a white bunker sits beside the green, off the ball's line.
        frame = np.full((2160, 3840, 3), (40, 110, 50), np.uint8)
        x0, y0 = int(3840 * aim.RIGHT_MINIMAP_ROI[0]), int(2160 * aim.RIGHT_MINIMAP_ROI[1])
        bx, by = x0 + 288, y0 + 843
        cv2.circle(frame, (bx, by), 9, (200, 60, 210), -1, cv2.LINE_AA)             # pink
        cv2.ellipse(frame, (bx, by), (9, 9), 0, 180, 360, (75, 20, 70), -1)          # dark top half
        cv2.circle(frame, (bx, by + 2), 3, (240, 220, 245), -1)                      # shine
        cv2.circle(frame, (x0 + 200, y0 + 200), 9, (255, 255, 255), -1, cv2.LINE_AA)  # bunker
        cv2.circle(frame, (x0 + 286, y0 + 168), 9, (255, 255, 255), -1, cv2.LINE_AA)  # pin
        cv2.rectangle(frame, (40, 40), (int(3840 * 0.2), 125), (176, 39, 156), -1)   # purple banner
        cv2.putText(frame, "Brian", (12, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        self.assertAlmostEqual(aim.read_player_colour(frame), 146, delta=4)
        _crop, _origin, ball, pin, side, _roi = aim.locate_minimap(frame)
        self.assertEqual(side, "right")
        self.assertAlmostEqual(ball.x, 288, delta=3)
        self.assertAlmostEqual(pin.x, 286, delta=3)
        self.assertAlmostEqual(pin.y, 168, delta=3)

    def test_no_minimap_says_so_and_shows_what_it_saw(self):
        img = np.full((H, W, 3), (30, 40, 30), np.uint8)
        x0, y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
        cv2.circle(img, (x0 + 140, y0 + 60), 5, (255, 255, 255), -1)    # something white, nothing under it
        with self.assertRaises(aim.AimReadError) as caught:
            aim.aim_preview(img, ball_world=(100.0, 50.0), pin_world=(100.0, 250.0), target_world=(110.0, 200.0))
        self.assertIn("bottom right or bottom left", str(caught.exception))
        self.assertTrue(caught.exception.seen and len(caught.exception.seen) > 200)

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
