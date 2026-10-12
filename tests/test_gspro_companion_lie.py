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


if __name__ == "__main__":
    unittest.main()
