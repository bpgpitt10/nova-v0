import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.shot_mode import ShotModeInputs, infer_shot_mode, polygon_from_canonical_hole


class ShotModeTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()
        self.green = (
            (100.0, -10.0),
            (120.0, -10.0),
            (120.0, 10.0),
            (100.0, 10.0),
        )

    def test_green_surface_yields_out_of_full_shot_caddie(self):
        decision = infer_shot_mode(
            ShotModeInputs(
                surface_label="Green",
                pin_distance_yds=18.0,
                aim_distance_yds=18.0,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.mode, "no-full-shot")
        self.assertFalse(decision.full_shot_allowed)
        self.assertGreaterEqual(decision.confidence, 0.95)

    def test_canonical_aim_inside_green_is_approach(self):
        decision = infer_shot_mode(
            ShotModeInputs(
                surface_label="Fairway",
                pin_distance_yds=112.0,
                aim_distance_yds=111.0,
                aim_forward_tee_yds=110.0,
                aim_right_tee_yds=0.0,
                canonical_green_polygon=self.green,
                green_context_available=True,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.mode, "approach")
        self.assertTrue(decision.aim_inside_green)

    def test_canonical_aim_outside_green_is_strategic_even_if_distance_is_close(self):
        decision = infer_shot_mode(
            ShotModeInputs(
                surface_label="Fairway",
                pin_distance_yds=112.0,
                aim_distance_yds=115.0,
                aim_forward_tee_yds=150.0,
                aim_right_tee_yds=0.0,
                canonical_green_polygon=self.green,
                green_context_available=True,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.mode, "strategic")
        self.assertFalse(decision.aim_inside_green)

    def test_distance_match_fallback_is_approach(self):
        decision = infer_shot_mode(
            ShotModeInputs(
                surface_label="Rough",
                pin_distance_yds=160.0,
                aim_distance_yds=166.0,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.mode, "approach")
        self.assertIsNone(decision.aim_inside_green)

    def test_large_aim_pin_distance_divergence_is_strategic(self):
        decision = infer_shot_mode(
            ShotModeInputs(
                surface_label="Fairway",
                pin_distance_yds=390.0,
                aim_distance_yds=235.0,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.mode, "strategic")

    def test_missing_aim_can_fallback_to_approach_only_inside_configured_range(self):
        near = infer_shot_mode(
            ShotModeInputs(
                surface_label="Sand",
                pin_distance_yds=145.0,
                aim_distance_yds=None,
                green_context_available=True,
            ),
            assumptions=self.assumptions,
        )
        far = infer_shot_mode(
            ShotModeInputs(
                surface_label="Fairway",
                pin_distance_yds=330.0,
                aim_distance_yds=None,
                green_context_available=True,
            ),
            assumptions=self.assumptions,
        )
        self.assertEqual(near.mode, "approach")
        self.assertEqual(far.mode, "unknown")

    def test_polygon_adapter_preserves_forward_right_geometry(self):
        canonical = {
            "green_surface": {
                "polygon": [
                    {"forward": 100, "right": -8},
                    {"forward": 120, "right": -8},
                    {"forward": 120, "right": 8},
                ]
            }
        }
        self.assertEqual(
            polygon_from_canonical_hole(canonical),
            ((100.0, -8.0), (120.0, -8.0), (120.0, 8.0)),
        )


if __name__ == "__main__":
    unittest.main()
