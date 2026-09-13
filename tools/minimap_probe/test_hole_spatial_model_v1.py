from __future__ import annotations

import unittest

import hole_spatial_model_v1 as spatial


class HoleSpatialModelV1Tests(unittest.TestCase):
    def setUp(self):
        # Canonical minimap: golfer is at the bottom and target is straight up.
        # GSPro world: target is straight +Z. In both spaces, golfer-right must be
        # positive: screen +X and world +X respectively.
        hole_model = {
            "minimap": {
                "ball_pixel": {"x": 50.0, "y": 90.0},
                "pin_pixel": {"x": 50.0, "y": 10.0},
            }
        }
        row = {
            "teePos": {"x": 0.0, "y": 0.0, "z": 0.0},
            "pinPos": {"x": 0.0, "y": 0.0, "z": 100.0},
        }
        self.t = spatial.anchor_transform(hole_model, row)

    def test_image_right_basis_is_screen_right_for_upward_hole(self):
        self.assertAlmostEqual(self.t["pixel_forward_unit"][0], 0.0, places=7)
        self.assertAlmostEqual(self.t["pixel_forward_unit"][1], -1.0, places=7)
        self.assertAlmostEqual(self.t["pixel_right_unit"][0], 1.0, places=7)
        self.assertAlmostEqual(self.t["pixel_right_unit"][1], 0.0, places=7)

    def test_pixel_to_local_is_right_positive(self):
        right_lat, right_fwd = spatial.pixel_to_local(self.t, 60.0, 90.0)
        left_lat, left_fwd = spatial.pixel_to_local(self.t, 40.0, 90.0)
        self.assertGreater(right_lat, 0.0)
        self.assertLess(left_lat, 0.0)
        self.assertAlmostEqual(right_fwd, 0.0, places=7)
        self.assertAlmostEqual(left_fwd, 0.0, places=7)

    def test_local_pixel_roundtrip_preserves_side(self):
        x, y = spatial.local_to_pixel(self.t, lateral=25.0, forward=40.0)
        lat, fwd = spatial.pixel_to_local(self.t, x, y)
        self.assertAlmostEqual(lat, 25.0, places=7)
        self.assertAlmostEqual(fwd, 40.0, places=7)
        self.assertGreater(x, self.t["tee_pixel"]["x"])

    def test_world_to_local_and_back_is_right_positive(self):
        # +X is golfer-right when the hole points +Z in Unity/GSPro world space.
        lat, fwd = spatial.world_to_local(self.t, 10.0, 25.0)
        self.assertGreater(lat, 0.0)
        self.assertGreater(fwd, 0.0)
        x, z = spatial.local_to_world(self.t, lat, fwd)
        self.assertAlmostEqual(x, 10.0, places=7)
        self.assertAlmostEqual(z, 25.0, places=7)

    def test_basis_revision_marks_corrected_models(self):
        self.assertEqual(self.t["basis_revision"], spatial.BASIS_REVISION)
        self.assertEqual(spatial.BASIS_REVISION, "image-y-down-right-positive-v2")


if __name__ == "__main__":
    unittest.main()
