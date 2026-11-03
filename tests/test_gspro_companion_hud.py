"""GSPro player box OCR ('Shot 1  492.6 YDS'): shot number + distance to pin."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_native_hud_ocr as hud  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def report_from_band(name: str, width: int, height: int) -> dict:
    band = cv2.imread(str(FIXTURES / name))
    frame = np.full((height, width, 3), 120, np.uint8)
    frame[0:band.shape[0], 0:band.shape[1]] = band
    return {"status": "captured", "quality": {"nonblank": True},
            "windowWidth": width, "windowHeight": height,
            "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}


class HudTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(hud.parse_hud_line("Shot 1 492.6 YDS Y4FT11"), (1, 492.6))
        self.assertEqual(hud.parse_hud_line("Shot3 283.0 YDS.  2FT9"), (3, 283.0))
        self.assertIsNone(hud.parse_hud_line("Shot YDS"))
        self.assertIsNone(hud.parse_hud_line("Shot 1 9999 YDS"))

    def test_two_reads_must_agree(self):
        reads = iter(["Shot 1 492.6 YDS", "Shot 1 432.6 YDS", "Shot 1 492.6 YDS"])
        with mock.patch.object(hud.wind, "_ocr_png_with_tesseract",
                               side_effect=lambda png, **kw: {"status": "ok", "rawText": next(reads)}):
            result = hud.read_hud_from_capture(report_from_band("gspro_hud_shot1_4926.png", 2000, 1132))
        self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"]), ("READY", 1, 492.6))
        reads2 = iter(["Shot 1 492.6 YDS", "Shot 1 432.6 YDS", "YDS"])
        with mock.patch.object(hud.wind, "_ocr_png_with_tesseract",
                               side_effect=lambda png, **kw: {"status": "ok", "rawText": next(reads2)}):
            result = hud.read_hud_from_capture(report_from_band("gspro_hud_shot1_4926.png", 2000, 1132))
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertIsNone(result["distanceToPinYds"])

    def test_real_farmlinks_player_boxes(self):
        bundle = hud.wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        langs = subprocess.run([str(bundle[0]), "--list-langs"], capture_output=True, text=True)
        if "eng" not in (langs.stdout + langs.stderr):
            self.skipTest("tesseract has no English data here")
        for name, size, expected in (("gspro_hud_shot1_4926.png", (2000, 1142), (1, 492.6)),
                                     ("gspro_hud_shot3_2830.png", (3776, 2138), (3, 283.0))):
            band = cv2.imread(str(FIXTURES / name))
            # Same window size the band came from (fixture is the top-left 20% x 10%).
            width = round(band.shape[1] / 0.20)
            height = round(band.shape[0] / 0.10)
            result = hud.read_hud_from_capture(report_from_band(name, width, height))
            self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"]),
                             ("READY", *expected), (name, result.get("rawText")))


if __name__ == "__main__":
    unittest.main()
