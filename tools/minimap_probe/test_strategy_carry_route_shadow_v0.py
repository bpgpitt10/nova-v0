#!/usr/bin/env python3
import unittest

import strategy_carry_route_shadow_v0 as route


class CarryRouteShadowV0Tests(unittest.TestCase):
    def test_best_route_prefers_smooth_current_hole_chain(self):
        stations = [
            {"carry_yds": 180.0, "candidates": [
                {"carry_yds": 180.0, "span_id": 1, "semantic_confidence": 0.88, "bearing_deg": 0.0, "center_local_yards": {"lateral": 0, "forward": 180}},
            ]},
            {"carry_yds": 200.0, "candidates": [
                {"carry_yds": 200.0, "span_id": 1, "semantic_confidence": 0.82, "bearing_deg": 4.0, "center_local_yards": {"lateral": 14, "forward": 199}},
                {"carry_yds": 200.0, "span_id": 2, "semantic_confidence": 0.96, "bearing_deg": 70.0, "center_local_yards": {"lateral": 188, "forward": 68}},
            ]},
            {"carry_yds": 220.0, "candidates": [
                {"carry_yds": 220.0, "span_id": 1, "semantic_confidence": 0.85, "bearing_deg": 9.0, "center_local_yards": {"lateral": 34, "forward": 217}},
                {"carry_yds": 220.0, "span_id": 2, "semantic_confidence": 0.95, "bearing_deg": 75.0, "center_local_yards": {"lateral": 212, "forward": 57}},
            ]},
        ]
        result = route.best_route(stations)
        self.assertTrue(result["available"])
        self.assertEqual([row["span_id"] for row in result["route"]], [1, 1, 1])

    def test_empty_route_is_unavailable(self):
        result = route.best_route([])
        self.assertFalse(result["available"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
