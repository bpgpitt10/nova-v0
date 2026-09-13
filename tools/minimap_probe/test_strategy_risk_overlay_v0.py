#!/usr/bin/env python3
from __future__ import annotations

import unittest

import strategy_risk_overlay_v0 as overlay
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
            {
                "hazard_class": "out_of_bounds",
                "source": "test",
                "source_object_id": "o1",
                "polygon_pixel": [[75, 220], [75, 180]],
            },
        ],
    }


class StrategyRiskOverlayV0Tests(unittest.TestCase):
    def test_local_pixel_round_trip(self):
        transform = synthetic_geometry()["coordinate_transform"]
        for lateral, forward in [(-12.5, 40), (0, 100), (18, 155.5)]:
            x, y = overlay.local_to_pixel(transform, lateral, forward)
            got_lateral, got_forward = risk.pixel_to_local(transform, x, y)
            self.assertAlmostEqual(got_lateral, lateral, places=6)
            self.assertAlmostEqual(got_forward, forward, places=6)

    def test_candidate_labels_respect_golfer_right_positive(self):
        self.assertEqual(overlay.candidate_label(-10), "10 yd left")
        self.assertEqual(overlay.candidate_label(0), "center")
        self.assertEqual(overlay.candidate_label(10), "10 yd right")

    def test_ellipse_contour_has_expected_mahalanobis_radius(self):
        cov = risk.covariance_from_profile({
            "sigma_lateral_yds": 5,
            "sigma_forward_yds": 8,
            "correlation": 0,
        })
        points = overlay.ellipse_local_points((0, 100), cov, 0.80, count=72)
        inv = ((1 / 25, 0), (0, 1 / 64))
        expected = risk.contour_radius_sq(0.80)
        for lateral, forward in points[::8]:
            dlat = lateral
            dfwd = forward - 100
            d2 = dlat * dlat * inv[0][0] + dfwd * dfwd * inv[1][1]
            self.assertAlmostEqual(d2, expected, places=6)

    def test_comparison_reports_without_ranking_or_recommendation(self):
        rows = overlay.compare_landing_centers(
            synthetic_geometry(),
            base_lateral_yds=0,
            base_forward_yds=100,
            lateral_offsets_yds=[-10, 0, 10],
            shot_profile={"sigma_lateral_yds": 5, "sigma_forward_yds": 8},
            sample_count=512,
        )
        self.assertEqual([row["label"] for row in rows], ["10 yd left", "center", "10 yd right"])
        self.assertTrue(all(row["recommendation"] is None for row in rows))
        self.assertTrue(all(row["strategy_authority"] is False for row in rows))
        center = rows[1]
        self.assertGreater(center["estimated_any_bunker_probability"], 0.25)
        self.assertTrue(center["penalty_area"]["any_95pct_intersection"])
        self.assertFalse(center["boundary_probability_available"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
