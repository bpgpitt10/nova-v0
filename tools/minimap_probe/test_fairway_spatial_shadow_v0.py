from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import fairway_spatial_shadow_v0 as fs


class FairwaySpatialShadowTests(unittest.TestCase):
    def test_projects_polygon_with_existing_transform(self):
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp)
            (capture / "fairway_surface_shadow_v0.json").write_text(json.dumps({
                "fairway_present": True,
                "identity": {"hole_display": 4},
                "fairway": {
                    "polygon_minimap_pixel": [[100, 300], [80, 200], [100, 100], [120, 200]],
                    "semantic_confidence": 0.95,
                    "segmentation_quality_score": 1.2,
                    "topology": {"tee_pin_centerline_fraction": 0.8},
                },
            }), encoding="utf-8")
            (capture / "hole_spatial_model_v1.json").write_text(json.dumps({
                "identity": {"hole_display": 4},
                "transform": {
                    "tee_pixel": {"x": 100.0, "y": 300.0},
                    "pin_pixel": {"x": 100.0, "y": 100.0},
                    "pixel_forward_unit": [0.0, -1.0],
                    "pixel_right_unit": [-1.0, -0.0],
                    "tee_world_xz": [10.0, 20.0],
                    "world_forward_unit_xz": [1.0, 0.0],
                    "world_right_unit_xz": [0.0, 1.0],
                    "yards_per_pixel": 1.0,
                },
            }), encoding="utf-8")
            payload = fs.project(capture)
            self.assertTrue(payload["fairway_present"])
            points = payload["fairway"]["hole_local_yards"]
            self.assertAlmostEqual(points[0]["lateral_yds"], 0.0)
            self.assertAlmostEqual(points[0]["forward_yds"], 0.0)
            self.assertAlmostEqual(points[2]["forward_yds"], 200.0)
            self.assertFalse(payload["strategy_authority"])

    def test_no_fairway_remains_valid_shadow_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp)
            (capture / "fairway_surface_shadow_v0.json").write_text(json.dumps({
                "fairway_present": False,
                "fairway": None,
            }), encoding="utf-8")
            (capture / "hole_spatial_model_v1.json").write_text(json.dumps({"transform": {}}), encoding="utf-8")
            payload = fs.project(capture)
            self.assertFalse(payload["fairway_present"])
            self.assertIsNone(payload["fairway"])


if __name__ == "__main__":
    unittest.main()
