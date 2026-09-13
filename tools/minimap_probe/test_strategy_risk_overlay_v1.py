#!/usr/bin/env python3
from __future__ import annotations

import math
import unittest

import strategy_risk_overlay_v1 as overlay


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


class StrategyRiskOverlayV1Tests(unittest.TestCase):
    def test_straight_ahead_covariance_matches_shot_axes(self):
        cov = overlay.oriented_covariance(
            {"sigma_lateral_yds": 5, "sigma_forward_yds": 10, "correlation": 0},
            landing_lateral_yds=0,
            landing_forward_yds=100,
        )
        self.assertAlmostEqual(cov[0][0], 25.0, places=6)
        self.assertAlmostEqual(cov[0][1], 0.0, places=6)
        self.assertAlmostEqual(cov[1][1], 100.0, places=6)

    def test_45_degree_heading_rotates_long_axis(self):
        cov = overlay.oriented_covariance(
            {"sigma_lateral_yds": 5, "sigma_forward_yds": 10, "correlation": 0},
            landing_lateral_yds=100,
            landing_forward_yds=100,
        )
        self.assertAlmostEqual(cov[0][0], 62.5, places=6)
        self.assertAlmostEqual(cov[1][1], 62.5, places=6)
        self.assertAlmostEqual(cov[0][1], 37.5, places=6)
        self.assertAlmostEqual(cov[1][0], 37.5, places=6)

    def test_explicit_heading_overrides_landing_center_inference(self):
        profile = {
            "sigma_lateral_yds": 5,
            "sigma_forward_yds": 10,
            "shot_heading_local_yards": {"lateral": 0, "forward": 1},
        }
        cov = overlay.oriented_covariance(
            profile,
            landing_lateral_yds=50,
            landing_forward_yds=100,
        )
        self.assertAlmostEqual(cov[0][0], 25.0, places=6)
        self.assertAlmostEqual(cov[0][1], 0.0, places=6)
        self.assertAlmostEqual(cov[1][1], 100.0, places=6)
        meta = overlay.heading_basis_metadata(
            profile,
            landing_lateral_yds=50,
            landing_forward_yds=100,
        )
        self.assertEqual(meta["source"], "explicit-shot-heading")

    def test_correlation_survives_rotation(self):
        rho = 0.4
        cov = overlay.oriented_covariance(
            {"sigma_lateral_yds": 5, "sigma_forward_yds": 10, "correlation": rho},
            landing_lateral_yds=0,
            landing_forward_yds=100,
        )
        self.assertAlmostEqual(cov[0][1], rho * 5 * 10, places=6)

    def test_comparison_remains_non_authoritative(self):
        rows = overlay.compare_landing_centers(
            synthetic_geometry(),
            base_lateral_yds=0,
            base_forward_yds=100,
            lateral_offsets_yds=[-10, 0, 10],
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=256,
        )
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["recommendation"] is None for row in rows))
        self.assertTrue(all(row["strategy_authority"] is False for row in rows))
        self.assertEqual(rows[1]["dispersion_basis"]["source"], "tee-to-landing-center-shadow-approximation")
        left_heading = rows[0]["dispersion_basis"]["unit_local"]
        right_heading = rows[2]["dispersion_basis"]["unit_local"]
        self.assertLess(left_heading["lateral"], 0)
        self.assertGreater(right_heading["lateral"], 0)
        self.assertTrue(math.isclose(left_heading["forward"], right_heading["forward"], rel_tol=1e-9))


if __name__ == "__main__":
    unittest.main(verbosity=2)
