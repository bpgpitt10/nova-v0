#!/usr/bin/env python3
import unittest

import course_visual_profile_v0 as profile


class CourseVisualProfileV0Tests(unittest.TestCase):
    def test_normalize_keeps_only_fixed_gspro_surface_taxonomy(self):
        surfaces = {}
        for name in ("fairway", "rough", "deep_rough", "bunker", "green", "water"):
            surfaces[name] = {
                "observable": name != "deep_rough",
                "confidence": 0.8,
                "appearance": f"{name} look",
                "distinguishing_cues": ["cue"],
                "common_confusions": [],
            }
        raw = {
            "course_style_summary": "test",
            "overall_confidence": 0.9,
            "surfaces": surfaces,
            "current_hole_disambiguation_cues": ["follow maintained route"],
            "rendering_warnings": [],
        }
        got = profile.normalize_profile(raw)
        self.assertEqual(set(got["surfaces"]), {"fairway", "rough", "deep_rough", "bunker", "green", "water"})
        self.assertFalse(got["surfaces"]["deep_rough"]["observable"])

    def test_slug_is_stable(self):
        self.assertEqual(profile._slug("GreyWolf Golf Course"), "greywolf-golf-course")


if __name__ == "__main__":
    unittest.main(verbosity=2)
