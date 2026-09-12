from __future__ import annotations

import unittest

import geometry_review_v1 as gr


class GeometryReviewV1Tests(unittest.TestCase):
    def setUp(self):
        # Tee at (100, 300), pin straight up the image at (100, 100). The synthetic
        # pixel_right_unit deliberately follows the stored spatial-model basis rather
        # than assuming that positive lateral must equal increasing screen X.
        self.transform = {
            "tee_pixel": {"x": 100.0, "y": 300.0},
            "pin_pixel": {"x": 100.0, "y": 100.0},
            "pixel_forward_unit": [0.0, -1.0],
            "pixel_right_unit": [-1.0, -0.0],
            "yards_per_pixel": 2.0,
        }

    def test_local_origin_returns_tee_pixel(self):
        self.assertEqual(gr.local_to_pixel(self.transform, 0.0, 0.0), (100.0, 300.0))

    def test_forward_distance_uses_stored_pixel_basis(self):
        x, y = gr.local_to_pixel(self.transform, 0.0, 200.0)
        self.assertAlmostEqual(x, 100.0)
        self.assertAlmostEqual(y, 200.0)

    def test_lateral_sign_comes_from_transform_not_screen_assumption(self):
        x, y = gr.local_to_pixel(self.transform, 20.0, 0.0)
        self.assertAlmostEqual(x, 90.0)
        self.assertAlmostEqual(y, 300.0)

    def test_roundtrip_metrics_are_zero_for_identical_vertices(self):
        points = [(10.0, 10.0), (20.0, 15.0), (17.0, 25.0)]
        result = gr.roundtrip_metrics(points, list(points))
        self.assertTrue(result["available"])
        self.assertAlmostEqual(result["rms_px"], 0.0)
        self.assertAlmostEqual(result["max_px"], 0.0)

    def test_roundtrip_metrics_report_known_offset(self):
        direct = [(0.0, 0.0), (10.0, 10.0)]
        moved = [(3.0, 4.0), (13.0, 14.0)]
        result = gr.roundtrip_metrics(direct, moved)
        self.assertAlmostEqual(result["rms_px"], 5.0)
        self.assertAlmostEqual(result["max_px"], 5.0)

    def test_mismatched_vertex_counts_are_not_scored(self):
        result = gr.roundtrip_metrics([(0.0, 0.0)], [(0.0, 0.0), (1.0, 1.0)])
        self.assertFalse(result["available"])


if __name__ == "__main__":
    unittest.main()
