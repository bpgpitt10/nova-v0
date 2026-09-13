#!/usr/bin/env python3
import math
import unittest

import strategy_carry_arc_v1 as arc


class StrategyCarryArcV1Tests(unittest.TestCase):
    def test_profile_prompt_is_weak_surface_prior(self):
        profile = {
            "course_style_summary": "Muted mountain-course rendering",
            "surfaces": {
                "fairway": {"observable": True, "appearance": "lighter green", "distinguishing_cues": ["smooth turf"]},
                "rough": {"observable": True, "appearance": "darker green", "distinguishing_cues": []},
                "deep_rough": {"observable": False, "appearance": "", "distinguishing_cues": []},
                "bunker": {"observable": True, "appearance": "tan", "distinguishing_cues": ["sand texture"]},
                "green": {"observable": True, "appearance": "smooth bright green", "distinguishing_cues": []},
                "water": {"observable": True, "appearance": "blue", "distinguishing_cues": []},
            },
            "current_hole_disambiguation_cues": ["follow maintained route"],
        }
        text = arc.profile_prompt_text(profile)
        self.assertIn("WEAK COURSE VISUAL PRIOR", text)
        self.assertIn("FAIRWAY", text)
        self.assertNotIn("DEEP_ROUGH:", text)
        self.assertIn("screenshot evidence overrides", text)

    def test_span_fraction_stays_on_carry_radius(self):
        carry = 230.0
        a = (-40.0, math.sqrt(carry * carry - 40.0 * 40.0))
        b = (50.0, math.sqrt(carry * carry - 50.0 * 50.0))
        for fraction in (0.2, 0.5, 0.8):
            point = arc.point_on_span(a, b, carry, fraction)
            self.assertAlmostEqual(math.hypot(*point), carry, places=6)
            self.assertGreater(point[1], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
