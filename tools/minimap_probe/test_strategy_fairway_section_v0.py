#!/usr/bin/env python3
from __future__ import annotations

import unittest

import strategy_fairway_section_v0 as fairway


def geometry():
    return {
        "coordinate_transform": {
            "tee_pixel": {"x": 100, "y": 300},
            "pin_pixel": {"x": 100, "y": 100},
            "yards_per_pixel": 1.0,
        }
    }


def payload(points, confidence=0.8):
    return {
        "fairway_present": True,
        "fairway": {
            "polygon_minimap_pixel": points,
            "semantic_confidence": confidence,
            "segmentation_quality_score": 1.2,
            "topology": {"tee_pin_centerline_fraction": 0.7},
        },
    }


class StrategyFairwaySectionV0Tests(unittest.TestCase):
    def test_rectangle_produces_one_span(self):
        # x=90..130 maps to local lateral=-10..30 because tee->pin points up.
        fw = payload([[90,250],[130,250],[130,150],[90,150]])
        got = fairway.section(geometry(), fw, forward_yds=100)
        self.assertTrue(got["available"])
        self.assertEqual(len(got["spans"]), 1)
        span = got["primary_span"]
        self.assertAlmostEqual(span["left_lateral_yds"], -10.0)
        self.assertAlmostEqual(span["right_lateral_yds"], 30.0)
        self.assertAlmostEqual(span["center_lateral_yds"], 10.0)
        self.assertAlmostEqual(span["width_yds"], 40.0)

    def test_concave_polygon_can_return_two_spans_and_widest_is_primary(self):
        # Pure local coordinates: two horizontal spans at y=5 connected above.
        polygon = [[0,0],[10,0],[10,10],[7,10],[7,4],[3,4],[3,10],[0,10]]
        spans = fairway.lateral_spans_at_forward(polygon, 5)
        self.assertEqual(spans, [[0.0,3.0],[7.0,10.0]])

    def test_missing_polygon_is_unavailable(self):
        got = fairway.section(geometry(), {"fairway_present": False, "fairway": None}, forward_yds=100)
        self.assertFalse(got["available"])
        self.assertIsNone(got["primary_span"])

    def test_forward_outside_polygon_is_unavailable(self):
        fw = payload([[90,250],[130,250],[130,150],[90,150]])
        got = fairway.section(geometry(), fw, forward_yds=180)
        self.assertFalse(got["available"])
        self.assertIn("does not intersect", got["reason"])

    def test_confidence_is_clamped_not_trusted_above_one(self):
        fw = payload([[90,250],[130,250],[130,150],[90,150]], confidence=1.43)
        got = fairway.section(geometry(), fw, forward_yds=100)
        self.assertEqual(got["fairway_semantic_confidence"], 1.0)

    def test_comparison_centers_stay_inside_primary_span(self):
        section = {
            "available": True,
            "forward_yds": 230,
            "primary_span": {
                "left_lateral_yds": -4,
                "right_lateral_yds": 12,
                "center_lateral_yds": 4,
            },
        }
        rows = fairway.comparison_centers(section, step_yds=10)
        self.assertEqual([row["lateral_yds"] for row in rows], [-4.0,4.0,12.0])
        self.assertTrue(all(row["recommendation"] is None for row in rows))
        self.assertTrue(all(row["strategy_authority"] is False for row in rows))


if __name__ == "__main__":
    unittest.main(verbosity=2)
