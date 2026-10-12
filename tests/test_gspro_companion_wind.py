"""Pure tests for native GSPro wind OCR; no GSPro process or mouse needed."""
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_native_wind_ocr as wind
import gspro_window_capture as capture
import gspro_live_observations as observations
import looper_companion as companion


def fake_native_frame():
    w, h = 800, 500
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[:, :, :3] = (32, 43, 62)
    img[:, :, 3] = 255
    return {
        "status": "captured", "windowWidth": w, "windowHeight": h,
        "quality": {"nonblank": True}, "method": "PrintWindow",
        "_private_bgra": img.tobytes(),
    }


class NativeWindTests(unittest.TestCase):
    def test_uses_native_hud_crop_and_existing_compass_parser(self):
        image = fake_native_frame()
        calls = []
        def stub(png):
            decoded = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
            calls.append(decoded.shape)
            return {"status": "ok", "rawText": "8 MPH W"}
        with mock.patch.object(wind, "_ocr_png_with_windows", side_effect=stub):
            result = wind.read_wind_from_capture(image)
        self.assertEqual(calls, [(160, 576, 3)])
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["speedMph"], 8.0)
        self.assertEqual(result["directionDegrees"], 270)
        self.assertEqual(result["convention"], "toward")
        self.assertEqual(result["ocrSource"], "gspro-native-window")
        self.assertEqual(result["captureFreshness"], "single_capture_unverified")
        self.assertEqual(result["capture"]["method"], "PrintWindow")
        self.assertNotIn("_private_bgra", result)

    def test_fail_closed_missing_black_or_malformed_native_pixels(self):
        for bad in [
            {"status": "unsupported", "quality": {"nonblank": False}},
            {**fake_native_frame(), "_private_bgra": b"short"},
            {**fake_native_frame(), "quality": {"nonblank": False}},
            {**fake_native_frame(), "windowWidth": 32},
        ]:
            with self.subTest(bad=bad.get("status")), mock.patch.object(wind, "_ocr_png_with_windows") as f:
                result = wind.read_wind_from_capture(bad)
                self.assertEqual(result["status"], "UNAVAILABLE")
                f.assert_not_called()

    def test_incomplete_or_failed_ocr_never_invents_wind(self):
        for payload, status in [
            ({"status": "ok", "rawText": "8 MPH"}, "UNKNOWN"),
            ({"status": "error", "note": "WinRT_AsTask_IAsyncOperation_unavailable"}, "UNAVAILABLE"),
        ]:
            with mock.patch.object(wind, "_ocr_png_with_windows", return_value=payload):
                result = wind.read_wind_from_capture(fake_native_frame())
            self.assertEqual(result["status"], status)
            self.assertIsNone(result.get("directionDegrees"))

    def test_one_native_frame_shared_by_minimap_and_wind_without_exposure(self):
        report = fake_native_frame()
        with mock.patch.object(observations.native, "find_gspro_window", return_value={"status": "connected", "imagePath": None}), \
            mock.patch.object(observations.native, "discover_gspro_data_directory", return_value={"directory": None, "status": "not-found"}), \
            mock.patch.object(observations.native, "public_gspro_window_status", return_value={"status": "connected"}), \
            mock.patch.object(observations.native, "public_data_folder_status", return_value={"status": "not-found"}), \
            mock.patch.object(observations.capture, "probe_gspro_capture", return_value=report) as read_frame, \
            mock.patch.object(observations, "_image_observation", return_value={"status": "markers_unavailable"}) as map_image, \
            mock.patch.object(observations.wind_ocr, "read_wind_from_capture", return_value={"status": "READY", "speedMph": 8, "directionDegrees": 270, "capture": {"source": "hidden"}}) as wind_read, \
            mock.patch("open_golf_coach_helper_lie_footer.read_gspro_lie_hud", return_value={"status": "UNKNOWN"}):
            result = observations.collect_observations()
        read_frame.assert_called_once()
        self.assertIs(map_image.call_args.kwargs["report"], report)
        wind_read.assert_called_once_with(report)
        self.assertEqual(result["ocr"]["wind"]["speedMph"], 8)
        self.assertNotIn("_private_bgra", str(result))
        self.assertNotIn('"source": "hidden"', str(result))

    def test_companion_legacy_wind_route_uses_new_native_reader(self):
        from contextlib import contextmanager
        from http.server import ThreadingHTTPServer
        from http.client import HTTPConnection
        from threading import Thread
        server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(companion.native, "find_gspro_window", return_value={"status": "connected"}) as found, \
                mock.patch.object(companion.native_wind, "read_gspro_native_wind", return_value={"status": "READY", "speedMph": 8, "directionDegrees": 270}):
                client = HTTPConnection("127.0.0.1", server.server_port, timeout=4)
                try:
                    client.request("GET", "/wind")
                    reply = client.getresponse()
                    import json
                    data = json.loads(reply.read())
                finally:
                    client.close()
            self.assertEqual(reply.status, 200)
            self.assertEqual(data["speedMph"], 8)
            found.assert_called_once()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=4)


if __name__ == "__main__":
    unittest.main()
