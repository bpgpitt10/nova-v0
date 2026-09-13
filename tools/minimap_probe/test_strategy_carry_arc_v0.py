#!/usr/bin/env python3
import math
import unittest

import numpy as np

import strategy_carry_arc_v0 as arc


class CarryArcV0Tests(unittest.TestCase):
    def setUp(self):
        self.transform = {
            "tee_pixel": {"x": 100.0, "y": 400.0},
            "pin_pixel": {"x": 100.0, "y": 100.0},
            "yards_per_pixel": 0.5,
        }

    def test_local_pixel_round_trip(self):
        for lateral, forward in [(-30.0, 200.0), (0.0, 230.0), (45.0, 180.0)]:
            px = arc.local_to_pixel(self.transform, lateral, forward)
            got = arc.pixel_to_local(self.transform, px)
            self.assertAlmostEqual(got[0], lateral, places=6)
            self.assertAlmostEqual(got[1], forward, places=6)

    def test_project_to_radius(self):
        point = arc._project_to_radius((30.0, 40.0), (0.0, 0.0), 100.0)
        self.assertAlmostEqual(math.hypot(*point), 100.0, places=6)

    def test_validate_good_span(self):
        carry = 200.0
        points_local = {
            "edge_a": (-25.0, math.sqrt(carry**2 - 25.0**2)),
            "center": (0.0, carry),
            "edge_b": (25.0, math.sqrt(carry**2 - 25.0**2)),
        }
        row = {"span_id": 1, "confidence": 0.9, "note": ""}
        for field, key in [("edge_a_xy_1000", "edge_a"), ("center_xy_1000", "center"), ("edge_b_xy_1000", "edge_b")]:
            px = arc.local_to_pixel(self.transform, *points_local[key])
            row[field] = arc.pixel_to_xy1000(px, 200, 500)
        result = arc.validate_span(row, carry_yds=carry, transform=self.transform, image_width=200, image_height=500)
        self.assertTrue(result["accepted"], result["rejection_reasons"])
        self.assertGreater(result["chord_width_yds"], 40.0)

    def test_validate_rejects_off_arc(self):
        carry = 200.0
        row = {
            "span_id": 1, "confidence": 0.9, "note": "",
            "edge_a_xy_1000": arc.pixel_to_xy1000(arc.local_to_pixel(self.transform, -20.0, 150.0), 200, 500),
            "center_xy_1000": arc.pixel_to_xy1000(arc.local_to_pixel(self.transform, 0.0, 150.0), 200, 500),
            "edge_b_xy_1000": arc.pixel_to_xy1000(arc.local_to_pixel(self.transform, 20.0, 150.0), 200, 500),
        }
        result = arc.validate_span(row, carry_yds=carry, transform=self.transform, image_width=200, image_height=500)
        self.assertFalse(result["accepted"])
        self.assertTrue(any("off-carry-arc" in x for x in result["rejection_reasons"]))

    def test_normalize_false_clears_spans(self):
        raw = {
            "present": False,
            "spans": [{
                "span_id": 1, "edge_a_xy_1000": [1,2], "center_xy_1000": [2,3],
                "edge_b_xy_1000": [3,4], "confidence": 0.5, "note": ""
            }],
            "note": "none",
        }
        normalized = arc.normalize_semantic(raw)
        self.assertFalse(normalized["present"])
        self.assertEqual(normalized["spans"], [])

    def test_dashed_arc_annotation_keeps_shape(self):
        image = np.zeros((500, 200, 3), dtype=np.uint8)
        out = arc.annotate_carry_arc(image, self.transform, 100.0)
        self.assertEqual(out.shape, image.shape)
        self.assertGreater(int(out.sum()), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
