import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

PROBE_DIR = Path(__file__).resolve().parents[2] / "minimap_probe"
if str(PROBE_DIR) not in sys.path:
    sys.path.insert(0, str(PROBE_DIR))

import upper_left_state


class UpperLeftStateTests(unittest.TestCase):
    def test_numeric_parsers_keep_decimal_distance(self):
        self.assertEqual(upper_left_state._first_int("Shot 12"), 12)
        self.assertAlmostEqual(upper_left_state._first_distance("391.5 YDS"), 391.5)

    def test_player_name_parser(self):
        self.assertEqual(upper_left_state._player_name("Brian\n"), "Brian")

    def _triangle_crop(self, direction: str):
        image = np.zeros((50, 80, 3), dtype=np.uint8)
        if direction == "down":
            pts = np.array([[20, 12], [42, 12], [31, 34]], dtype=np.int32)
        else:
            pts = np.array([[31, 12], [20, 34], [42, 34]], dtype=np.int32)
        cv2.fillConvexPoly(image, pts, (60, 220, 70))
        return image

    def test_triangle_direction_down(self):
        cfg = upper_left_state._config()
        self.assertEqual(upper_left_state._green_triangle_direction(self._triangle_crop("down"), cfg), "down")

    def test_triangle_direction_up(self):
        cfg = upper_left_state._config()
        self.assertEqual(upper_left_state._green_triangle_direction(self._triangle_crop("up"), cfg), "up")

    def test_normalized_rois_fit_realistic_2048_screen(self):
        cfg = upper_left_state._config()
        screen = np.zeros((1152, 2048, 3), dtype=np.uint8)
        for bounds in cfg["roi_normalized"].values():
            crop, bbox = upper_left_state._crop_normalized(screen, bounds)
            self.assertGreater(crop.size, 0)
            self.assertGreater(bbox[2], 20)
            self.assertGreater(bbox[3], 20)


if __name__ == "__main__":
    unittest.main()
