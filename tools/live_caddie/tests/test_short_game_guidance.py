from __future__ import annotations

import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.candidates import generate_candidates
from tools.live_caddie.engine import recommend
from tools.live_caddie.models import ClubProfile, GreenSurface, HazardBoundary, LiveShotState, PointYards
from tools.live_caddie.short_game import build_short_game_guidance


class ShortGameGuidanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assumptions = Assumptions.load()
        self.green = GreenSurface(
            polygon=[
                PointYards(30.0, -12.0),
                PointYards(50.0, -12.0),
                PointYards(50.0, 8.0),
                PointYards(30.0, 8.0),
            ],
            pin=PointYards(40.0, 0.0),
            confidence=1.0,
        )
        self.right_hazard = HazardBoundary(
            hazard_id="right-water",
            points=[PointYards(25.0, 10.0), PointYards(55.0, 10.0)],
        )

    def state(self, distance: float) -> LiveShotState:
        return LiveShotState(
            mode="approach",
            pin_distance_yds=distance,
            pin_forward_yds=distance,
            pin_right_yds=0.0,
            registration_confidence=1.0,
            pin_crosscheck_error_yds=0.0,
        )

    def test_40_yard_shot_does_not_scale_88_yard_wedge_pattern(self) -> None:
        profile = ClubProfile(
            club="LW",
            stock_carry_yds=88.0,
            carry_sigma_yds=5.0,
            lateral_sigma_yds=6.0,
        )
        result = recommend(
            profiles=[profile],
            state=self.state(40.0),
            hazards=[self.right_hazard],
            green=self.green,
            assumptions=self.assumptions,
        )
        payload = result.to_dict()
        self.assertEqual(payload["recommendation_kind"], "geometry-only")
        self.assertIsNone(payload["recommended"])
        self.assertEqual(payload["guidance"]["preferred_side"], "left")
        self.assertLess(payload["guidance"]["suggested_safe_offset_yds"], 0.0)
        self.assertIn("do not extrapolate", payload["coverage"]["reason"])

    def test_real_explicit_variant_restores_modeled_coverage(self) -> None:
        profile = ClubProfile(
            club="LW",
            stock_carry_yds=88.0,
            carry_sigma_yds=5.0,
            lateral_bias_yds=2.0,
            lateral_sigma_yds=6.0,
            explicit_variants=[{
                "name": "40y Pitch",
                "carry_yds": 42.0,
                "carry_sigma_yds": 2.5,
                "lateral_bias_yds": -1.0,
                "lateral_sigma_yds": 3.0,
                "playable": True,
            }],
        )
        candidates = generate_candidates([profile], self.state(40.0), self.assumptions)
        pitch = next(candidate for candidate in candidates if candidate.variant == "40y Pitch" and candidate.aim_offset_yds == 0)
        self.assertEqual(pitch.planned_carry_yds, 42.0)
        self.assertEqual(pitch.pattern_bias_yds, -1.0)
        self.assertEqual(pitch.carry_sigma_yds, 2.5)
        self.assertEqual(pitch.lateral_sigma_yds, 3.0)

        result = recommend(
            profiles=[profile],
            state=self.state(40.0),
            hazards=[],
            green=self.green,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.recommendation_kind, "modeled-shot")
        self.assertIsNotNone(result.recommended)
        self.assertEqual(result.recommended.candidate.variant, "40y Pitch")

    def test_true_greenside_cutoff_returns_no_guidance_without_variant(self) -> None:
        profile = ClubProfile(club="LW", stock_carry_yds=88.0)
        result = recommend(
            profiles=[profile],
            state=self.state(12.0),
            hazards=[self.right_hazard],
            green=self.green,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.recommendation_kind, "none")
        self.assertIsNone(result.recommended)
        self.assertIsNone(result.guidance)
        self.assertEqual(result.coverage["scope"], "none")

    def test_explicit_greenside_variant_can_override_generic_cutoff(self) -> None:
        profile = ClubProfile(
            club="LW",
            stock_carry_yds=88.0,
            explicit_variants=[{
                "name": "15y Chip",
                "carry_yds": 15.0,
                "carry_sigma_yds": 1.5,
                "lateral_bias_yds": 0.0,
                "lateral_sigma_yds": 2.0,
                "playable": True,
            }],
        )
        result = recommend(
            profiles=[profile],
            state=self.state(15.0),
            hazards=[],
            green=self.green,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.recommendation_kind, "modeled-shot")
        self.assertIsNotNone(result.recommended)
        self.assertEqual(result.recommended.candidate.variant, "15y Chip")

    def test_bare_unknown_side_penalty_boundary_cannot_claim_safe_direction(self) -> None:
        guidance = build_short_game_guidance(
            self.state(40.0),
            [self.right_hazard],
            None,
            self.assumptions,
            target_distance_yds=40.0,
        )
        self.assertEqual(guidance.preferred_side, "unknown")
        self.assertIsNone(guidance.suggested_safe_offset_yds)
        self.assertFalse(guidance.hazard_context_available)
        self.assertTrue(any("Ignored 1 penalty" in note for note in guidance.notes))

    def test_known_side_penalty_boundary_can_support_hazard_only_guidance(self) -> None:
        known = HazardBoundary(
            hazard_id="known-right-water",
            points=[PointYards(25.0, 10.0), PointYards(55.0, 10.0)],
            side_semantics_known=True,
        )
        guidance = build_short_game_guidance(
            self.state(40.0),
            [known],
            None,
            self.assumptions,
            target_distance_yds=40.0,
        )
        self.assertTrue(guidance.hazard_context_available)
        self.assertIn(guidance.preferred_side, ("left", "center"))


if __name__ == "__main__":
    unittest.main()
