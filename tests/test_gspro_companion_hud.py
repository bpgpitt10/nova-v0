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


    def test_real_gspro4_player_box(self):
        # GSPro 4.0 (Brian's Valhalla 4K, 8 Nov 2026): "368.2 yd  ▼ 10ft 11  Tee  [1] 2 3 4",
        # no "Shot N". Unread, Live Caddie fell back to an estimated pin: 365 yd
        # instead of 368 and "Aim by hand" on the tee.
        bundle = hud.wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        for width, height in ((3766, 2146), (1920, 1094)):
            band = cv2.imread(str(FIXTURES / "gspro4_player_box_368yd.png"))
            if width != 3766:
                scale = width / 3766
                band = cv2.resize(band, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            frame = np.full((height, width, 3), 120, np.uint8)
            frame[0:band.shape[0], 0:band.shape[1]] = band
            report = {"status": "captured", "quality": {"nonblank": True},
                      "windowWidth": width, "windowHeight": height,
                      "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}
            result = hud.read_hud_from_capture(report)
            self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"], result["hudLayout"]),
                             ("READY", 1, 368.2, "gspro-4"), (width, result.get("rawText")))
            self.assertAlmostEqual(result["elevationFt"], -(10 + 11 / 12), places=1)

    def test_older_player_box_is_not_read_as_gspro4(self):
        band = cv2.imread(str(FIXTURES / "gspro_hud_shot1_4926.png"))
        frame = np.full((1142, 2000, 3), 120, np.uint8)
        frame[0:band.shape[0], 0:band.shape[1]] = band
        self.assertIsNone(hud.find_v4_player_line(frame))

if __name__ == "__main__":
    unittest.main()
