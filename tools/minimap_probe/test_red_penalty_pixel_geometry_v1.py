from __future__ import annotations

import unittest

import cv2
import numpy as np

import red_penalty_pixel_geometry_v1 as red


class RedPenaltyPixelGeometryTests(unittest.TestCase):
    def test_extract_keeps_red_boundary_in_source_image_coordinates(self):
        image = np.zeros((120, 100, 3), dtype=np.uint8)
        cv2.line(image, (18, 15), (22, 105), (0, 0, 255), 4)
        mask, objects = red.extract(image, player_xy=None)
        self.assertGreater(int(mask.sum()), 0)
        self.assertEqual(len(objects), 1)
        pts = objects[0]["polygon_pixel"]
        self.assertTrue(all(0 <= p[0] < 100 and 0 <= p[1] < 120 for p in pts))
        self.assertEqual(objects[0]["coordinate_space"], "minimap_pixel")
        self.assertEqual(objects[0]["coordinate_authority"], "exact-saved-minimap-red-cv")

    def test_player_marker_is_removed_without_removing_real_boundary(self):
        image = np.zeros((140, 120, 3), dtype=np.uint8)
        # Real penalty boundary.
        cv2.line(image, (85, 10), (90, 125), (0, 0, 255), 4)
        # Team-color player marker near the tee.
        cv2.circle(image, (25, 115), 7, (0, 0, 255), -1)
        _mask, objects = red.extract(image, player_xy=(25, 115), player_mask_radius_px=13)
        self.assertEqual(len(objects), 1)
        xs = [p[0] for p in objects[0]["polygon_pixel"]]
        self.assertGreater(min(xs), 70)

    def test_small_red_noise_is_rejected(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        cv2.circle(image, (50, 50), 2, (0, 0, 255), -1)
        _mask, objects = red.extract(image, player_xy=None)
        self.assertEqual(objects, [])

    def test_strategy_authority_stays_off(self):
        self.assertFalse(red.STRATEGY_AUTHORITY)


if __name__ == "__main__":
    unittest.main()
