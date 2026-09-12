from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import minimap_aim


class PassiveAimTests(unittest.TestCase):
    def _image(self, marker_xy=(250, 450), marker_hsv=(0, 6, 205)):
        image = np.full((950, 564, 3), (52, 112, 54), dtype=np.uint8)
        if marker_xy is not None:
            hsv_pixel = np.uint8([[list(marker_hsv)]])
            bgr = tuple(int(x) for x in cv2.cvtColor(hsv_pixel, cv2.COLOR_HSV2BGR)[0, 0])
            cv2.circle(image, marker_xy, 8, bgr, -1, cv2.LINE_AA)
        return image

    def test_gray_marker_candidate_is_detected(self):
        rows = minimap_aim._gray_marker_candidates(self._image())
        self.assertEqual(len(rows), 1)
        self.assertGreater(rows[0].detector_score, 0.80)
        self.assertAlmostEqual(rows[0].x, 250, delta=1.0)
        self.assertAlmostEqual(rows[0].y, 450, delta=1.0)

    def test_saturated_sand_like_circle_is_rejected(self):
        rows = minimap_aim._gray_marker_candidates(self._image(marker_hsv=(25, 80, 220)))
        self.assertEqual(rows, [])

    def test_passive_distance_uses_ball_pin_scale(self):
        image = self._image(marker_xy=(280, 500))
        ball = SimpleNamespace(x=280.0, y=850.0)
        pin = SimpleNamespace(x=280.0, y=180.0)
        with patch.object(minimap_aim.v2, "detect_ball_marker", return_value=ball), patch.object(
            minimap_aim.v2, "detect_pin_marker", return_value=pin
        ):
            state, meta = minimap_aim.read_passive_aim(image, pin_distance_yds=230.0)
        self.assertIsNotNone(state)
        expected = 350.0 * (230.0 / 670.0)
        self.assertAlmostEqual(state.distance_yds, expected, delta=1.0)
        self.assertEqual(meta["status"], "passive-minimap-marker")
        self.assertFalse(meta["attempted_actuation"])

    def test_marker_occluded_at_pin_returns_unavailable(self):
        image = self._image(marker_xy=(280, 180))
        ball = SimpleNamespace(x=280.0, y=850.0)
        pin = SimpleNamespace(x=280.0, y=180.0)
        with patch.object(minimap_aim.v2, "detect_ball_marker", return_value=ball), patch.object(
            minimap_aim.v2, "detect_pin_marker", return_value=pin
        ):
            state, meta = minimap_aim.read_passive_aim(image, pin_distance_yds=230.0)
        self.assertIsNone(state)
        self.assertEqual(meta["status"], "not-visible")
        self.assertFalse(meta["attempted_actuation"])


if __name__ == "__main__":
    unittest.main()
