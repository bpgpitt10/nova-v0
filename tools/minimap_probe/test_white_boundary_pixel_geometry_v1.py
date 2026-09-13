#!/usr/bin/env python3
from __future__ import annotations

import unittest
import cv2
import numpy as np

import white_boundary_pixel_geometry_v1 as w


class WhiteBoundaryPixelGeometryTests(unittest.TestCase):
    def test_long_white_boundary_is_kept(self):
        img = np.zeros((300, 200, 3), dtype=np.uint8)
        cv2.line(img, (20, 80), (30, 280), (245, 245, 245), 8)
        mask, rows = w.extract_components(img)
        self.assertEqual(len(rows), 1)
        self.assertGreater(int(mask.sum()), 0)
        self.assertEqual(rows[0]["hazard_class"], "out_of_bounds")

    def test_compact_white_marker_is_rejected(self):
        img = np.zeros((300, 200, 3), dtype=np.uint8)
        cv2.circle(img, (100, 180), 14, (250, 250, 250), -1)
        _, rows = w.extract_components(img)
        self.assertEqual(rows, [])

    def test_hud_white_is_masked(self):
        img = np.zeros((300, 200, 3), dtype=np.uint8)
        cv2.rectangle(img, (5, 5), (190, 28), (250, 250, 250), -1)
        _, rows = w.extract_components(img)
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
