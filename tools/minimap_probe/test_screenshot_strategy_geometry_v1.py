from __future__ import annotations

import json
from pathlib import Path
import tempfile
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

    def test_canonical_pixel_polygon_passes_precision_gate(self):
        with tempfile.TemporaryDirectory() as td:
            capture = Path(td)
            payload = {
                "hazards": [{
                    "hazard_class": "bunker",
                    "primary": {
                        "source": {"kind": "legacy_cv", "object_id": "b1"},
                        "confidence": {"semantic": 0.98, "geometry": 0.91},
                        "representation": {
                            "geometry_type": "polygon",
                            "coordinate_space": "minimap_pixel",
                            "points": [[10, 10], [20, 10], [20, 20], [10, 20]],
                        },
                    },
                }]
            }
            (capture / "hazard_map_shadow_v0.json").write_text(json.dumps(payload), encoding="utf-8")
            precise, rejected = sg._canonical_precise_layers(capture, 100, 100)
            self.assertEqual(len(precise), 1)
            self.assertEqual(rejected, [])

    def test_zero_quality_rectangle_stays_evidence_only(self):
        with tempfile.TemporaryDirectory() as td:
            capture = Path(td)
            payload = {
                "hazards": [{
                    "hazard_class": "bunker",
                    "primary": {
                        "source": {"kind": "legacy_cv", "object_id": "bad"},
                        "confidence": {"semantic": 0.99, "geometry": 0.0},
                        "representation": {
                            "geometry_type": "polygon",
                            "coordinate_space": "minimap_pixel",
                            "points": [[10, 10], [30, 10], [30, 30], [10, 30]],
                        },
                    },
                }]
            }
            (capture / "hazard_map_shadow_v0.json").write_text(json.dumps(payload), encoding="utf-8")
            precise, rejected = sg._canonical_precise_layers(capture, 100, 100)
            self.assertEqual(precise, [])
            self.assertEqual(len(rejected), 1)
            self.assertIn("confidence", rejected[0]["reason"])

    def test_semantic_bbox_never_becomes_precise_geometry(self):
        with tempfile.TemporaryDirectory() as td:
            capture = Path(td)
            payload = {
                "hazards": [{
                    "hazard_class": "water",
                    "primary": {
                        "source": {"kind": "vlm", "object_id": "w1"},
                        "confidence": {"semantic": 0.99, "geometry": None},
                        "representation": {
                            "geometry_type": "bbox",
                            "coordinate_space": "minimap_normalized",
                            "bbox": [0.1, 0.1, 0.5, 0.5],
                        },
                    },
                }]
            }
            (capture / "hazard_map_shadow_v0.json").write_text(json.dumps(payload), encoding="utf-8")
            precise, rejected = sg._canonical_precise_layers(capture, 100, 100)
            self.assertEqual(precise, [])
            self.assertEqual(len(rejected), 1)
            evidence = sg._semantic_evidence(capture)
            self.assertEqual(len(evidence), 1)
            self.assertEqual(evidence[0]["role"], "semantic-localization-only-not-collision-geometry")

    def test_strategy_authority_is_off(self):
        self.assertFalse(sg.STRATEGY_AUTHORITY)


if __name__ == "__main__":
    unittest.main()
