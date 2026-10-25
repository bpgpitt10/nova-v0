"""Synthetic and real-caption regression for read-only first-tee HUD parsing."""
import unittest
from unittest import mock

import numpy as np
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))

import gspro_native_tee_hud_ocr as hud


class TeeHudTests(unittest.TestCase):
    # OCR text measured from 2026-10-25 real FarmLinks 3840x2160 screenshot.
    def real_caption(self):
        return hud.parse_tee_hud(
            "Shot 1 492.6 YDS VW4FT11",
            "Farmlinks Golf Club",
            "1 |",
            ">AR 5 493 YDS",
        )

    def test_real_farmlinks_caption_no_current_round_dependency(self):
        reading = self.real_caption()
        self.assertEqual(reading["status"], "READY")
        self.assertEqual(reading["straightDistanceYds"], 492.6)
        self.assertEqual(reading["holeNumber"], 1)
        self.assertEqual(reading["scorecardYards"], 493)
        self.assertFalse(reading["authorizesNativeAim"])

    def test_reject_bad_shot_hole_course_and_distance(self):
        s = ("Shot 1 492.6 YDS", "Farmlinks Golf Club", "1", "PAR 5 493 YDS")
        cases = [
            (("Shot 2 492.6 YDS", *s[1:]), "shot_one_not_verified"),
            (("Shot 1 4 FT 11", *s[1:]), "shot_distance_not_read"),
            ((s[0], "???", *s[2:]), "course_name_not_read"),
            ((s[0], s[1], "??", s[3]), "hole_number_not_read"),
            ((s[0], s[1], "19", s[3]), "hole_number_not_read"),
            ((s[0], s[1], s[2], "PAR 5"), "scorecard_yardage_not_read"),
            (("Shot 1 475.0 YDS", *s[1:]), "shot_scorecard_distance_disagree"),
        ]
        for captions, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(hud.parse_tee_hud(*captions)["reason"], reason)

    def test_one_native_frame_is_reused_no_extra_screen_capture(self):
        image = np.zeros((1080, 1920, 4), dtype=np.uint8).tobytes()
        report = {"status": "captured", "windowWidth": 1920, "windowHeight": 1080, "_private_bgra": image}
        ocr = iter(["Shot 1 492.6 YDS", "Farmlinks Golf Club", "1", "PAR 5 493 YDS"])
        with mock.patch.object(hud, "_ocr_crop", side_effect=lambda *_args, **_kw: next(ocr)) as read:
            result = hud.read_tee_hud_from_capture(report)
        self.assertEqual(read.call_count, 4)
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["holeNumber"], 1)

    def test_missing_or_corrupt_capture_fails_closed(self):
        self.assertEqual(hud.read_tee_hud_from_capture({"status": "unsupported"})["status"], "UNAVAILABLE")
        self.assertEqual(
            hud.read_tee_hud_from_capture({"status": "captured", "windowWidth": 1920,
                                           "windowHeight": 1080, "_private_bgra": b"x"})["reason"],
            "capture_geometry_unverified",
        )


if __name__ == "__main__":
    unittest.main()
