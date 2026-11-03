"""Auto Aim step 2: one minimap click per Arm. Synthetic frames, fake clicker."""
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
import json
import sys
import threading
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_aim_click as aim_click  # noqa: E402
import gspro_native_aim as aim  # noqa: E402

W, H = 1920, 1080
X0, Y0 = int(W * aim.RIGHT_MINIMAP_ROI[0]), int(H * aim.RIGHT_MINIMAP_ROI[1])
WINDOW = {
    "status": "connected", "hwnd": 77, "pid": 9001, "minimized": False,
    "dpiAwareness": "per-monitor",
    "bounds": {"left": 100, "top": 50, "width": W, "height": H},
}
BALL, PIN, TARGET = (100.0, 50.0), (100.0, 250.0), (110.0, 200.0)


def frame_with(ball_px=(140, 400), pin_px=(140, 60), marker=None):
    frame = np.full((H, W, 3), (40, 110, 50), np.uint8)
    cv2.circle(frame, (X0 + ball_px[0], Y0 + ball_px[1]), 5, (0, 0, 235), -1)
    cv2.circle(frame, (X0 + pin_px[0], Y0 + pin_px[1]), 5, (255, 255, 255), -1)
    if marker is not None:
        x, y = int(round(X0 + marker[0])), int(round(Y0 + marker[1]))
        cv2.circle(frame, (x, y), 9, (230, 40, 230), 2)  # magenta reticle
        cv2.line(frame, (x - 12, y), (x + 12, y), (230, 40, 230), 2)
        cv2.line(frame, (x, y - 12), (x, y + 12), (230, 40, 230), 2)
    return frame


def run(frames, *, window=WINDOW, clicker=None, target=TARGET):
    frames = list(frames)
    clicks = []

    def capture(_window):
        return frames.pop(0) if len(frames) > 1 else frames[0]

    def click(plan, *, latest_window, allow_native_input):
        assert allow_native_input is True
        clicks.append(plan)

    result = aim_click.aim_click(
        ball_world=BALL, pin_world=PIN, target_world=target, shot_key="farmlinks:1:1",
        find_window=lambda: window, capture=capture, click=clicker or click,
        sleep=lambda _s: None,
    )
    return result, clicks


class AimClickTests(unittest.TestCase):
    def test_clicks_inside_minimap_and_verifies_marker(self):
        preview = aim.aim_preview(frame_with(), ball_world=BALL, pin_world=PIN, target_world=TARGET)
        target = preview["minimap"]["target"]
        result, clicks = run([frame_with(), frame_with(marker=target)])
        self.assertEqual(result["status"], "clicked", result)
        self.assertEqual(len(clicks), 1)
        # Desktop point = window origin + minimap origin + target within the minimap.
        self.assertEqual(clicks[0].desktop_x, round(100 + X0 + target[0]))
        self.assertEqual(clicks[0].desktop_y, round(50 + Y0 + target[1]))
        self.assertEqual(result["verified"], "match")

    def test_marker_somewhere_else_is_a_mismatch(self):
        preview = aim.aim_preview(frame_with(), ball_world=BALL, pin_world=PIN, target_world=TARGET)
        tx, ty = preview["minimap"]["target"]
        result, _ = run([frame_with(), frame_with(marker=(tx + 40, ty))])
        self.assertEqual(result["verified"], "mismatch")
        result, _ = run([frame_with(), frame_with()])
        self.assertEqual(result["verified"], "marker-not-seen")

    def test_never_clicks_when_a_check_fails(self):
        cases = [
            ({"window": {**WINDOW, "status": "waiting"}}, "gspro-not-connected"),
            ({"window": {**WINDOW, "minimized": True}}, "gspro-minimized"),
            ({"window": {**WINDOW, "dpiAwareness": "unverified"}}, "preflight-failed"),
            ({"target": (900.0, 200.0)}, "target-off-map"),
        ]
        for kwargs, reason in cases:
            result, clicks = run([frame_with()], **kwargs)
            self.assertEqual((result["status"], result["reason"]), ("blocked", reason), kwargs)
            self.assertEqual(clicks, [])
        # Ball and pin dots not lined up the way GSPro draws them.
        result, clicks = run([frame_with(ball_px=(40, 400), pin_px=(240, 60))])
        self.assertEqual(result["reason"], "minimap-not-aligned")
        self.assertEqual(clicks, [])
        # No dots at all (minimap hidden): nothing to anchor on.
        blank = np.full((H, W, 3), (40, 110, 50), np.uint8)
        result, clicks = run([blank])
        self.assertEqual(result["reason"], "minimap-not-read")
        self.assertEqual(clicks, [])

    def test_click_failure_is_reported(self):
        def failing(plan, *, latest_window, allow_native_input):
            raise RuntimeError("Could not focus GSPro; no input sent")
        result, _ = run([frame_with()], clicker=failing)
        self.assertEqual((result["status"], result["reason"]), ("blocked", "click-failed"))


@contextmanager
def running_service():
    import looper_companion as companion
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def request(port, method, headers, body=None):
    client = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        client.request(method, "/companion/v1/aim-click", body=body,
                       headers={**headers, "Host": f"127.0.0.1:{port}"})
        response = client.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw else {}, response
    finally:
        client.close()


BODY = json.dumps({"ballX": BALL[0], "ballZ": BALL[1], "pinX": PIN[0], "pinZ": PIN[1],
                   "targetX": TARGET[0], "targetZ": TARGET[1], "shotKey": "farmlinks:1:1"}).encode()
GOOD = {"Origin": "https://thelooper.golf", "Content-Type": "application/json", "X-Looper-Intent": "aim-click"}


class AimClickEndpointTests(unittest.TestCase):
    def test_strict_authorization(self):
        import looper_companion as companion
        companion.LAST_AIM_CLICK_AT = float("-inf")
        with mock.patch.object(companion.native, "find_gspro_window", return_value={"status": "waiting"}), \
                running_service() as port:
            status, body, _ = request(port, "POST", GOOD, BODY)
            self.assertEqual(status, 200)
            self.assertEqual((body["status"], body["reason"]), ("blocked", "gspro-not-connected"))
            for drop in ("Origin", "X-Looper-Intent", "Content-Type"):
                headers = {k: v for k, v in GOOD.items() if k != drop}
                status, _, _ = request(port, "POST", headers, BODY)
                self.assertEqual(status, 403, drop)
            status, _, _ = request(port, "POST", {**GOOD, "Origin": "https://evil.example"}, BODY)
            self.assertEqual(status, 403)
            status, _, response = request(port, "OPTIONS", {"Origin": "https://thelooper.golf",
                                                           "Access-Control-Request-Method": "POST"})
            self.assertEqual(status, 204)
            self.assertIn("X-Looper-Intent", response.getheader("Access-Control-Allow-Headers"))
            self.assertIn("POST", response.getheader("Access-Control-Allow-Methods"))
            status, body, _ = request(port, "POST", GOOD, b"{}")
            self.assertEqual(body["reason"], "invalid-request")

    def test_one_click_per_moment(self):
        import looper_companion as companion
        companion.LAST_AIM_CLICK_AT = float("-inf")
        clicks = []
        with mock.patch.object(companion.native, "find_gspro_window", return_value=WINDOW), \
                mock.patch.object(companion.minimap_pipeline, "capture_native_bgr", return_value=frame_with()), \
                mock.patch.object(companion.native_click, "execute_prepared_click",
                                  side_effect=lambda plan, **kw: clicks.append(plan)), \
                mock.patch.object(companion.aim_click, "VERIFY_DELAY_S", 0), \
                running_service() as port:
            _, first, _ = request(port, "POST", GOOD, BODY)
            _, second, _ = request(port, "POST", GOOD, BODY)
        self.assertEqual(first["status"], "clicked", first)
        self.assertEqual((second["status"], second["reason"]), ("blocked", "too-soon"))
        self.assertEqual(len(clicks), 1)


if __name__ == "__main__":
    unittest.main()
