"""Native lie OCR contract and crop tests: no physical GSPro required."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_native_lie_ocr as lie


class NativeLieTests(unittest.TestCase):
    def setUp(self):
        self.width, self.height = 1280, 720
        self.report = {
            "status": "captured", "quality": {"nonblank": True},
            "windowWidth": self.width, "windowHeight": self.height,
            "_private_bgra": np.full((self.height, self.width, 4), 255, dtype=np.uint8).tobytes(),
        }

    def test_footer_relative_to_window_not_desktop(self):
        crops = lie.extract_footer_crops(self.report)
        self.assertEqual([x[0] for x in crops], ["right", "left"])
        self.assertTrue(all(len(images) == 2 for _, _, images in crops))
        self.assertTrue(all(images[0].shape[0] > 0 and images[1].shape[1] > 0
                            for _, _, images in crops))

    def test_flat_tee_and_down_right(self):
        for a, b, expected in [
            ("0.0 UP", "0.0 RIGHT", (0.0, 0.0)),
            ("2.9 DOWN", "0.9 RIGHT", (-2.9, 0.9)),
        ]:
            with self.subTest(long=a, lat=b):
                with patch.object(lie, "_read_region", side_effect=[
                    {"status": "ok", "rawText": a}, {"status": "ok", "rawText": b},
                    {"status": "error", "note": "unreadable"}, {"status": "error", "note": "unreadable"},
                ]):
                    result = lie.read_lie_from_capture(self.report)
                self.assertEqual(result["status"], "READY")
                self.assertEqual((result["upDownDegrees"], result["leftRightDegrees"]), expected)
                self.assertEqual(result["ocrSource"], "gspro-native-window")

    def test_partial_lie_not_ready(self):
        with patch.object(lie, "_read_region", side_effect=[
            {"status": "ok", "rawText": "2.9 DOWN"}, {"status": "ok", "rawText": "unreadable"},
            {"status": "error"}, {"status": "error"},
        ]):
            result = lie.read_lie_from_capture(self.report)
        self.assertEqual(result["status"], "UNKNOWN")

    def test_fail_closed_on_bad_capture_and_ocr(self):
        invalid = {**self.report, "quality": {"nonblank": False}}
        self.assertEqual(lie.read_lie_from_capture(invalid)["status"], "UNAVAILABLE")
        with patch.object(lie, "_read_region", return_value={"status": "error", "note": "WinRT_OCR_failure"}):
            result = lie.read_lie_from_capture(self.report)
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertIn("WinRT_OCR_failure", result["note"])

    def test_fast_tesseract_reads_skip_windows_ocr_when_two_agree(self):
        reads = {"UP": ["2.0 DOWN", "2.09 DOWN", "2.0 DON"], "RIGHT": ["0.9 RIGHT", "N 0.99 RIGHT"]}
        def fake(png, *, psm, whitelist):
            fake.n = getattr(fake, "n", 0) + 1
            return {"status": "ok", "rawText": (reads["UP"] + reads["RIGHT"])[fake.n - 1]}
        with patch.object(lie.wind, "_tesseract_bundle", return_value=("tesseract", None)), \
                patch.object(lie.wind, "_ocr_png_with_tesseract", side_effect=fake), \
                patch.object(lie, "_read_region") as windows_ocr:
            result = lie.read_lie_from_capture(self.report)
        windows_ocr.assert_not_called()
        self.assertEqual((result["status"], result["upDownDegrees"], result["leftRightDegrees"]),
                         ("READY", -2.0, 0.9))
        self.assertEqual(result["ocrEngine"], "tesseract-cli")

    def test_tesseract_disagreement_falls_back_to_windows_ocr(self):
        texts = iter(["2.0 DOWN", "3.0 DOWN", "", "0.9 RIGHT", "0.9 RIGHT"] + [""] * 20)
        with patch.object(lie.wind, "_tesseract_bundle", return_value=("tesseract", None)), \
                patch.object(lie.wind, "_ocr_png_with_tesseract",
                             side_effect=lambda png, **kw: {"status": "ok", "rawText": next(texts)}), \
                patch.object(lie, "_read_region", side_effect=[
                    {"status": "ok", "rawText": "2.9 DOWN"}, {"status": "ok", "rawText": "0.9 RIGHT"}]):
            result = lie.read_lie_from_capture(self.report)
        self.assertEqual((result["upDownDegrees"], result["leftRightDegrees"]), (-2.9, 0.9))

    def test_real_farmlinks_footer_2_down_09_right(self):
        bundle = lie.wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        import subprocess
        import cv2
        langs = subprocess.run([str(bundle[0]), "--list-langs"], capture_output=True, text=True)
        if "eng" not in (langs.stdout + langs.stderr):
            self.skipTest("tesseract has no English data here")
        band = cv2.imread(str(Path(__file__).resolve().parent / "fixtures" / "gspro_lie_2down_09right_footer.png"))
        frame = np.full((2138, 3776, 3), 60, np.uint8)
        frame[2009:2009 + band.shape[0], 3171:3171 + band.shape[1]] = band
        report = {"status": "captured", "quality": {"nonblank": True},
                  "windowWidth": 3776, "windowHeight": 2138,
                  "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}
        with patch.object(lie, "_read_region", return_value={"status": "error", "note": "no WinRT here"}):
            result = lie.read_lie_from_capture(report)
        self.assertEqual((result["status"], result["upDownDegrees"], result["leftRightDegrees"]),
                         ("READY", -2.0, 0.9), result)


if __name__ == "__main__":
    unittest.main()
