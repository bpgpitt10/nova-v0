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
    def test_uses_prior_validated_split_crops_and_compass_parser(self):
        image = fake_native_frame()
        calls = []

        def stub(png, *, psm, whitelist):
            decoded = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            calls.append(("speed" if "0123456789" in whitelist else "direction", psm, decoded))
            return {"status": "ok", "rawText": "8 MPH" if "0123456789" in whitelist else "W"}

        with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=stub):
            result = wind.read_wind_from_capture(image)

        # Speed read at three heights (psm 7); direction until two reads agree (psm 8).
        self.assertEqual([(k, p) for k, p, _ in calls],
                         [("speed", 7)] * 3 + [("direction", 8)] * 2)
        for _, _, decoded in calls:
            self.assertTrue(set(np.unique(decoded).tolist()).issubset({0, 255}))
            pad = wind.OCR_PAD_PX
            self.assertTrue((decoded[:pad] == 255).all() and (decoded[:, :pad] == 255).all(),
                            "white margin around the text")
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["speedMph"], 8.0)
        self.assertEqual(result["directionDegrees"], 270)
        self.assertEqual(result["convention"], "from")
        self.assertEqual(result["ocrSource"], "gspro-native-tesseract")
        self.assertEqual(result["captureFreshness"], "single_capture_unverified")
        self.assertEqual(result["capture"]["method"], "PrintWindow")
        self.assertEqual(set(result["capture"]["crops"]), {"speed", "direction"})
        self.assertNotIn("_private_bgra", result)

    def test_4k_geometry_recovers_precise_browser_rois(self):
        # No wind box found (all black): browser production geometry
        # x .444/.532 and y .011 at 3840x2160, 8x, plus the white margin.
        frame = np.zeros((2160, 3840, 4), dtype=np.uint8)
        frame[:, :, 3] = 255
        report = {"status": "captured", "quality": {"nonblank": True},
                  "windowWidth": 3840, "windowHeight": 2160,
                  "_private_bgra": frame.tobytes()}
        regions = wind.extract_wind_hud_regions(report)
        self.assertEqual(regions["speed"][1], {
            "x": 1704, "y": 23, "width": 126, "height": 56})
        self.assertEqual(regions["direction"][1], {
            "x": 2042, "y": 23, "width": 76, "height": 56})
        pad = 2 * wind.OCR_PAD_PX
        self.assertEqual(regions["speed"][0].shape, (448 + pad, 1008 + pad))
        self.assertEqual(regions["direction"][0].shape, (448 + pad, 608 + pad))
        # Scaled to a target height for the voting reads.
        sized = wind.extract_wind_hud_regions(report, target_height=100)
        self.assertEqual(sized["speed"][0].shape[0], 100 + pad)

    def test_real_farmlinks_wind_box_8mph_se(self):
        # Brian's screenshot (3776x2138): the old 8x crops read "0 MP".
        bundle = wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        import subprocess
        langs = subprocess.run([str(bundle[0]), "--list-langs"], capture_output=True, text=True)
        if "eng" not in (langs.stdout + langs.stderr):
            self.skipTest("tesseract has no English data here")
        band = cv2.imread(str(Path(__file__).resolve().parent / "fixtures" / "gspro_wind_8mph_se_band.png"))
        frame = np.full((2138, 3776, 3), 150, np.uint8)
        frame[0:band.shape[0], 1510:1510 + band.shape[1]] = band
        bgra = cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA)
        report = {"status": "captured", "quality": {"nonblank": True}, "method": "PrintWindow",
                  "windowWidth": 3776, "windowHeight": 2138, "_private_bgra": bgra.tobytes()}
        crops = wind._measured_wind_crops(frame)
        self.assertIsNotNone(crops, "wind box edges found")
        result = wind.read_wind_from_capture(report)
        self.assertEqual((result["status"], result["speedMph"], result["directionDegrees"]),
                         ("READY", 8.0, 135), result.get("rawText"))

    def _real_band_report(self, name, x0, size):
        bundle = wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        import subprocess
        langs = subprocess.run([str(bundle[0]), "--list-langs"], capture_output=True, text=True)
        if "eng" not in (langs.stdout + langs.stderr):
            self.skipTest("tesseract has no English data here")
        band = cv2.imread(str(Path(__file__).resolve().parent / "fixtures" / name))
        width, height = size
        frame = np.full((height, width, 3), 150, np.uint8)
        frame[0:band.shape[0], x0:x0 + band.shape[1]] = band
        return {"status": "captured", "quality": {"nonblank": True}, "method": "PrintWindow",
                "windowWidth": width, "windowHeight": height,
                "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}

    def test_real_valhalla_wind_box_6mph_s(self):
        # Brian's Valhalla 4K window: the arrow disc's rim reached into the
        # speed crop of the narrow "6 MPH" box and the companion read "MPH".
        report = self._real_band_report("gspro_wind_6mph_s_band.png", 1560, (3840, 2160))
        regions = wind.extract_wind_hud_regions(report, target_height=80)
        speed = regions["speed"][0]
        self.assertTrue((speed[:, -4:] == 255).all(), "arrow disc rim cleared from the speed crop")
        result = wind.read_wind_from_capture(report)
        self.assertEqual((result["status"], result["speedMph"], result["directionDegrees"]),
                         ("READY", 6.0, 180), result.get("rawText"))
        # If the full crop still loses the digit, the number is read on its own.
        real = wind._ocr_png_with_tesseract

        def drops_digit(png, *, psm, whitelist):
            if whitelist == "0123456789.,MPH ":
                return {"status": "ok", "rawText": "MPH"}
            return real(png, psm=psm, whitelist=whitelist)

        with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=drops_digit):
            result = wind.read_wind_from_capture(report)
        self.assertEqual((result["speedMph"], result["speedOcrStrategy"]), (6.0, "number-only"), result.get("rawText"))

    def test_companion_capture_valhalla_6mph_se(self):
        # The wind box exactly as Brian's companion captured it (its own
        # diagnostic save): the edge walk stopped at the white "6", the crop
        # began inside the digit and every read was "MPH".
        report = self._real_band_report("gspro_wind_6mph_se_companion_capture.png", 1344, (3840, 2160))
        result = wind.read_wind_from_capture(report)
        self.assertEqual((result["status"], result["speedMph"], result["directionDegrees"]),
                         ("READY", 6.0, 135), result.get("rawText"))

    def test_observed_io_mph_and_missing_direction_fails_closed(self):
        # User's 2026-10-12 physical sim trace: OCR returned "IO MPH",
        # no direction. Correct speed alone must NEVER activate wind.
        result = wind._parse_split_wind("IO MPH", "")
        self.assertEqual(result["speedMph"], 10)
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertIsNone(result["directionDegrees"])
        # With an independently recognized cardinal, same evidence is ready.
        repaired = wind._parse_split_wind("IO MPH", "SW")
        self.assertEqual(repaired["speedMph"], 10)
        self.assertEqual(repaired["directionDegrees"], 225)
        self.assertEqual(repaired["status"], "READY")
        self.assertEqual(wind._parse_split_wind("BOGUS", "W")["status"], "UNKNOWN")

    def test_calm_wind_follows_existing_browser_contract(self):
        self.assertEqual(wind._parse_split_wind("0 MPH", "")["status"], "READY")
        self.assertEqual(wind._parse_split_wind("0 MPH", "")["directionDegrees"], 0)
        self.assertEqual(wind._parse_split_wind("12 MPH", "NN")["directionDegrees"], 0)
        self.assertEqual(wind._parse_split_wind("12 MPH", "NEE")["directionDegrees"], 45)
        # GSPro 16-point labels: these used to read UNKNOWN (WNW) or 22.5 deg off (NNE).
        self.assertEqual(wind._parse_split_wind("10 MPH", "WNW")["directionDegrees"], 292.5)
        self.assertEqual(wind._parse_split_wind("10 MPH", "NNE")["directionDegrees"], 22.5)
        self.assertEqual(wind._parse_split_wind("10 MPH", "E S E")["status"], "READY")

    def test_fail_closed_missing_black_or_malformed_native_pixels(self):
        for bad in [
            {"status": "unsupported", "quality": {"nonblank": False}},
            {**fake_native_frame(), "_private_bgra": b"short"},
            {**fake_native_frame(), "quality": {"nonblank": False}},
            {**fake_native_frame(), "windowWidth": 32},
        ]:
            with self.subTest(bad=bad.get("status")), mock.patch.object(wind, "_ocr_png_with_tesseract") as f:
                result = wind.read_wind_from_capture(bad)
                self.assertEqual(result["status"], "UNAVAILABLE")
                f.assert_not_called()

    def test_incomplete_or_failed_ocr_never_invents_wind(self):
        def blank_direction(png, *, psm, whitelist):
            return {"status": "ok", "rawText": "8 MPH" if "0123456789" in whitelist else ""}

        def failing_direction(png, *, psm, whitelist):
            if "0123456789" in whitelist:
                return {"status": "ok", "rawText": "8 MPH"}
            return {"status": "error", "note": "tesseract_timeout"}

        def disagreeing_speed(png, *, psm, whitelist):
            disagreeing_speed.n = getattr(disagreeing_speed, "n", 0) + 1
            if "0123456789" in whitelist:
                return {"status": "ok", "rawText": ["8 MPH", "3 MPH", "0 MPH", "MPH", "6 MPH"][disagreeing_speed.n - 1]}
            return {"status": "ok", "rawText": "SE"}

        for stub, status in ((blank_direction, "UNKNOWN"), (failing_direction, "UNAVAILABLE"),
                             (disagreeing_speed, "UNKNOWN")):
            with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=stub):
                result = wind.read_wind_from_capture(fake_native_frame())
            self.assertEqual(result["status"], status, stub.__name__)
            if stub is not disagreeing_speed:
                self.assertIsNone(result.get("directionDegrees"))
            else:
                self.assertIsNone(result.get("speedMph"), "reads that never agree give no speed")

    def test_tesseract_uses_proven_speed_line_and_compass_word_modes(self):
        calls = []
        def fake(png, *, psm, whitelist):
            calls.append((psm, whitelist))
            return {"status": "ok", "rawText": "9 MPH" if "0123456789" in whitelist else "NW"}
        with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=fake):
            result = wind.read_wind_from_capture(fake_native_frame())
        self.assertTrue(all(p == 7 and "0123456789" in w for p, w in calls[:3]))
        self.assertTrue(all(p == 8 and "NSEW" in w for p, w in calls[3:]))
        self.assertEqual(result["speedMph"], 9)
        self.assertEqual(result["directionDegrees"], 315)
        self.assertEqual(result["convention"], "from")
        self.assertEqual(result["ocrEngine"], "tesseract-cli")
        self.assertEqual(result["directionOcrStrategy"], "word-psm8")

    def test_compass_retry_uses_browser_page_segmentation_modes(self):
        calls = []
        def fake(png, *, psm, whitelist):
            if "0123456789" in whitelist:
                return {"status": "ok", "rawText": "9 MPH"}
            calls.append(psm)
            return {"status": "ok", "rawText": "" if psm == 8 else "NW"}
        with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=fake):
            result = wind.read_wind_from_capture(fake_native_frame())
        self.assertEqual(calls, [8, 8, 8, 7, 10])
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["directionDegrees"], 315)
        self.assertEqual(result["directionOcrStrategy"], "fallback-psm")

    def test_fallback_speed_region_only_if_reference_crop_misses_number(self):
        calls = []
        def fake(png, *, psm, whitelist):
            if "0123456789" not in whitelist:
                return {"status": "ok", "rawText": "NW"}
            decoded = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            calls.append(decoded.shape)
            return {"status": "ok", "rawText": "MPH" if len(calls) <= 3 else "9 MPH"}
        with mock.patch.object(wind, "_ocr_png_with_tesseract", side_effect=fake):
            result = wind.read_wind_from_capture(fake_native_frame())
        self.assertEqual(len(calls), 5)
        self.assertEqual(result["speedOcrStrategy"], "expanded-crop")
        self.assertEqual(result["speedMph"], 9)
        self.assertEqual(result["directionDegrees"], 315)

    def test_tesseract_executable_absent_fails_closed(self):
        with mock.patch.object(wind, "_tesseract_bundle", return_value=None):
            self.assertEqual(
                wind._ocr_png_with_tesseract(b"fixture", psm=8, whitelist="NSEW")["note"],
                "bundled_tesseract_unavailable",
            )
        with mock.patch.object(wind, "_ocr_png_with_tesseract", return_value={
            "status": "error", "note": "bundled_tesseract_unavailable"
        }):
            result = wind.read_wind_from_capture(fake_native_frame())
        self.assertEqual(result["status"], "UNAVAILABLE")

    def test_one_native_frame_shared_by_minimap_and_wind_without_exposure(self):
        report = fake_native_frame()
        with mock.patch.object(observations.native, "find_gspro_window", return_value={"status": "connected", "imagePath": None}), \
            mock.patch.object(observations.native, "discover_gspro_data_directory", return_value={"directory": None, "status": "not-found"}), \
            mock.patch.object(observations.native, "public_gspro_window_status", return_value={"status": "connected"}), \
            mock.patch.object(observations.native, "public_data_folder_status", return_value={"status": "not-found"}), \
            mock.patch.object(observations.capture, "probe_gspro_capture", return_value=report) as read_frame, \
            mock.patch.object(observations, "_image_observation", return_value={"status": "markers_unavailable"}) as map_image, \
            mock.patch.object(observations.wind_ocr, "read_wind_from_capture", return_value={"status": "READY", "speedMph": 8, "directionDegrees": 270, "capture": {"source": "hidden"}}) as wind_read, \
            mock.patch.object(observations.lie_ocr, "read_lie_from_capture", return_value={"status": "READY", "upDownDegrees": 0, "leftRightDegrees": 0}) as lie_read:
            result = observations.collect_observations()
        read_frame.assert_called_once()
        self.assertIs(map_image.call_args.kwargs["report"], report)
        wind_read.assert_called_once_with(report)
        lie_read.assert_called_once_with(report)
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
