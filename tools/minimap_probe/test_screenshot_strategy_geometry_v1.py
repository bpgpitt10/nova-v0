from __future__ import annotations

import unittest

import screenshot_strategy_geometry_v1 as sg


class ScreenshotStrategyGeometryTests(unittest.TestCase):
    def model(self):
        # Tee->pin points straight up the image. Golfer-right must therefore be
        # image-right (+x), not image-left.
        return {
            "minimap": {
                "ball_pixel": {"x": 50.0, "y": 100.0},
                "pin_pixel": {"x": 50.0, "y": 0.0},
                "yards_per_pixel": 1.0,
            }
        }

    def test_right_positive_maps_to_image_right(self):
        x, y = sg.local_to_pixel(self.model(), lateral_yds=10.0, forward_yds=20.0)
        self.assertAlmostEqual(x, 60.0)
        self.assertAlmostEqual(y, 80.0)

    def test_left_positive_inverse_roundtrip(self):
        model = self.model()
        x, y = sg.local_to_pixel(model, lateral_yds=-13.5, forward_yds=42.0)
        lateral, forward = sg.pixel_to_local(model, x, y)
        self.assertAlmostEqual(lateral, -13.5, places=6)
        self.assertAlmostEqual(forward, 42.0, places=6)

    def test_out_of_bounds_polygon_is_rejected_not_clamped(self):
        self.assertEqual(sg._valid_polygon([[1, 1], [-4, 5], [8, 8]], 20, 20), [])

    def test_strategy_authority_is_off(self):
        self.assertFalse(sg.STRATEGY_AUTHORITY)


if __name__ == "__main__":
    unittest.main()
