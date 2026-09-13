#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import screenshot_strategy_geometry_v2 as s


class ScreenshotStrategyGeometryV2Tests(unittest.TestCase):
    def test_clamp01(self):
        self.assertEqual(s.clamp01(1.7), 1.0)
        self.assertEqual(s.clamp01(-0.2), 0.0)
        self.assertEqual(s.clamp01(0.62), 0.62)
        self.assertIsNone(s.clamp01(None))

    def test_recall_bunkers_uses_accepted_only_and_clamps(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "bunker_recall_v1.json").write_text(json.dumps({
                "accepted_bunkers": [
                    {
                        "source": "recall_sam2",
                        "source_object_id": "b1",
                        "semantic_confidence": 0.97,
                        "geometry_confidence": 1.43,
                        "polygon_pixel": [[10,10],[20,10],[20,20],[10,20]],
                    }
                ]
            }), encoding="utf-8")
            accepted, rejected = s.recall_bunkers(root, 100, 100)
            self.assertEqual(len(accepted), 1)
            self.assertEqual(rejected, [])
            self.assertEqual(accepted[0]["hazard_class"], "bunker")
            self.assertEqual(accepted[0]["geometry_confidence"], 1.0)
            self.assertEqual(accepted[0]["coordinate_space"], "minimap_pixel")

    def test_recall_bunkers_rejects_out_of_bounds_polygon(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "bunker_recall_v1.json").write_text(json.dumps({
                "accepted_bunkers": [
                    {
                        "source": "legacy_cv",
                        "source_object_id": "bad",
                        "polygon_pixel": [[10,10],[120,10],[20,20]],
                    }
                ]
            }), encoding="utf-8")
            accepted, rejected = s.recall_bunkers(root, 100, 100)
            self.assertEqual(accepted, [])
            self.assertEqual(len(rejected), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
