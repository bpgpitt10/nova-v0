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

    def test_real_gspro4_player_box_with_trees_below(self):
        # Valhalla 2 (8 Nov): dark trees under and left of the box made the line
        # look taller and start at the window edge; "0ft 6" lost its 0 to the triangle.
        bundle = hud.wind._tesseract_bundle()
        if bundle is None:
            self.skipTest("tesseract not installed")
        band = cv2.imread(str(FIXTURES / "gspro4_player_box_466yd_trees.png"))
        frame = np.full((2150, 3820, 3), 120, np.uint8)
        frame[0:band.shape[0], 0:band.shape[1]] = band
        report = {"status": "captured", "quality": {"nonblank": True},
                  "windowWidth": 3820, "windowHeight": 2150,
                  "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}
        result = hud.read_hud_from_capture(report)
        self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"]),
                         ("READY", 1, 465.9), result.get("rawText"))
        self.assertAlmostEqual(result["elevationFt"], -0.5, places=1)

    def _framed(self, name, size, offset):
        band = cv2.imread(str(FIXTURES / name))
        width, height = size
        frame = np.zeros((height, width, 3), np.uint8)
        oy, ox = offset
        frame[oy:oy + band.shape[0], ox:ox + band.shape[1]] = band
        return {"status": "captured", "quality": {"nonblank": True},
                "windowWidth": width, "windowHeight": height,
                "_private_bgra": cv2.cvtColor(frame, cv2.COLOR_BGR2BGRA).tobytes()}

    def test_gspro4_box_anywhere_near_the_corner_in_a_4k_window(self):
        # Companion 1.0.4 on Brian's 3840x2160 window (8 Nov) still read UNKNOWN:
        # the line's own text rows cut its measured height. It is now the name band's.
        if hud.wind._tesseract_bundle() is None:
            self.skipTest("tesseract not installed")
        for name, expected in (("gspro4_player_box_368yd.png", 368.2), ("gspro4_player_box_466yd_trees.png", 465.9)):
            for offset in ((0, 0), (7, 37), (14, 74)):
                result = hud.read_hud_from_capture(self._framed(name, (3840, 2160), offset))
                self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"]),
                                 ("READY", 1, expected), (name, offset, result.get("rawText")))

    def test_fixed_crop_fallback_reads_a_gspro4_box(self):
        if hud.wind._tesseract_bundle() is None:
            self.skipTest("tesseract not installed")
        with mock.patch.object(hud, "read_v4_hud", return_value=None):
            result = hud.read_hud_from_capture(self._framed("gspro4_player_box_368yd.png", (3840, 2160), (7, 37)))
        self.assertEqual((result["status"], result["shotNumber"], result["distanceToPinYds"], result["hudReader"]),
                         ("READY", 1, 368.2, "fixed-line"), result.get("rawText"))

    def test_older_player_box_is_not_read_as_gspro4(self):
        band = cv2.imread(str(FIXTURES / "gspro_hud_shot1_4926.png"))
        frame = np.full((1142, 2000, 3), 120, np.uint8)
        frame[0:band.shape[0], 0:band.shape[1]] = band
        self.assertIsNone(hud.find_v4_player_line(frame))

if __name__ == "__main__":
    unittest.main()
