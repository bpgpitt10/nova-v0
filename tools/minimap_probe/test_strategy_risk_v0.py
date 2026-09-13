#!/usr/bin/env python3
from __future__ import annotations

import unittest

import strategy_risk_v0 as risk


def synthetic_geometry():
    return {
        "coordinate_transform": {
            "tee_pixel": {"x": 100, "y": 300},
            "pin_pixel": {"x": 100, "y": 100},
            "yards_per_pixel": 1.0,
        },
        "precise_pixel_geometry": [
            {
                "hazard_class": "bunker",
                "source": "test",
                "source_object_id": "b1",
                "polygon_pixel": [[95, 205], [105, 205], [105, 195], [95, 195]],
            },
            {
                "hazard_class": "penalty_area",
                "source": "test",
                "source_object_id": "p1",
                "polygon_pixel": [[110, 220], [110, 180]],
            },
        ],
    }


class StrategyRiskV0Tests(unittest.TestCase):
    def test_pixel_transform_is_right_positive(self):
        transform = synthetic_geometry()["coordinate_transform"]
        lat, fwd = risk.pixel_to_local(transform, 110, 200)
        self.assertAlmostEqual(lat, 10.0)
        self.assertAlmostEqual(fwd, 100.0)

    def test_centered_bunker_has_material_probability(self):
        result = risk.evaluate_target(
            synthetic_geometry(),
            center_lateral_yds=0,
            center_forward_yds=100,
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=1024,
        )
        self.assertGreater(result["aggregate"]["estimated_any_bunker_probability"], 0.25)
        self.assertLess(result["aggregate"]["estimated_any_bunker_probability"], 0.40)

    def test_far_bunker_probability_drops_near_zero(self):
        result = risk.evaluate_target(
            synthetic_geometry(),
            center_lateral_yds=-35,
            center_forward_yds=100,
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=1024,
        )
        self.assertLess(result["aggregate"]["estimated_any_bunker_probability"], 0.01)

    def test_boundary_reports_clearance_not_fake_probability(self):
        result = risk.evaluate_target(
            synthetic_geometry(),
            center_lateral_yds=0,
            center_forward_yds=100,
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=512,
        )
        boundary = next(x for x in result["hazard_evidence"] if x["hazard_class"] == "penalty_area")
        self.assertAlmostEqual(boundary["center_clearance_yds"], 10.0)
        self.assertAlmostEqual(boundary["mahalanobis_clearance_sigma"], 2.0)
        self.assertFalse(boundary["ellipse_intersects_boundary"]["80pct"])
        self.assertTrue(boundary["ellipse_intersects_boundary"]["95pct"])
        self.assertIsNone(boundary["estimated_landing_probability"])
        self.assertFalse(result["aggregate"]["boundary_probability_available"])

    def test_candidate_evaluation_does_not_rank_or_recommend(self):
        rows = risk.evaluate_lateral_candidates(
            synthetic_geometry(),
            forward_yds=100,
            lateral_offsets_yds=[-10, 0, 10],
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=256,
        )
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["recommendation"] is None for row in rows))
        self.assertTrue(all(row["strategy_authority"] is False for row in rows))


if __name__ == "__main__":
    unittest.main(verbosity=2)
