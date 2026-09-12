from __future__ import annotations

import unittest

import numpy as np

import fairway_surface_shadow as fw


class FairwaySurfaceShadowTests(unittest.TestCase):
    def test_box_1000_converts_to_pixels(self):
        box = fw.box_px([100, 200, 900, 800], 500, 400, pad_fraction=0.0)
        self.assertEqual(box, (100, 40, 400, 360))

    def test_centerline_support_detects_route_overlap(self):
        mask = np.zeros((100, 100), dtype=bool)
        mask[20:81, 45:56] = True
        metrics = fw.topology_metrics(mask, (50, 90), (50, 10))
        self.assertGreater(metrics["tee_pin_centerline_fraction"], 0.70)

    def test_off_route_mask_has_low_centerline_support(self):
        mask = np.zeros((100, 100), dtype=bool)
        mask[20:81, 75:95] = True
        metrics = fw.topology_metrics(mask, (50, 90), (50, 10))
        self.assertLess(metrics["tee_pin_centerline_fraction"], 0.05)

    def test_quality_rejects_tiny_mask(self):
        mask = np.zeros((200, 100), dtype=bool)
        mask[90:94, 48:52] = True
        score, reasons, _ = fw.candidate_quality(mask, (30, 30, 70, 170), 0.9, (50, 190), (50, 10))
        self.assertIn("too-small-for-fairway", reasons)
        self.assertLess(score, 1.0)

    def test_quality_accepts_plausible_fairway(self):
        mask = np.zeros((200, 100), dtype=bool)
        mask[35:170, 38:63] = True
        score, reasons, metrics = fw.candidate_quality(mask, (30, 25, 70, 180), 0.9, (50, 190), (50, 10))
        self.assertEqual(reasons, [])
        self.assertGreater(score, 1.0)
        self.assertGreater(metrics["tee_pin_centerline_fraction"], 0.5)

    def test_polygon_extraction_returns_shape(self):
        mask = np.zeros((100, 100), dtype=bool)
        mask[20:80, 35:65] = True
        polygon = fw.mask_to_polygon(mask)
        self.assertGreaterEqual(len(polygon), 4)

    def test_par3_no_fairway_is_valid_product_state(self):
        # The extractor's contract deliberately supports present=false rather than
        # forcing a fairway shape onto a par 3.  Keep the schema flag explicit.
        self.assertFalse(fw.STRATEGY_AUTHORITY)
        self.assertIn("fairway-surface-shadow", fw.SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
