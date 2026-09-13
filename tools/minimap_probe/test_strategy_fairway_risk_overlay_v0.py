#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

import strategy_fairway_risk_overlay_v0 as overlay


class StrategyFairwayRiskOverlayV0Tests(unittest.TestCase):
    def test_build_requires_fairway_artifact(self):
        geometry = {
            "identity": {"hole_display": 1},
            "visual_truth": {"source_image": "gspro_actual.png"},
            "coordinate_transform": {
                "tee_pixel": {"x": 50, "y": 90},
                "pin_pixel": {"x": 50, "y": 10},
                "yards_per_pixel": 2.0,
            },
            "precise_pixel_geometry": [],
        }
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cv2.imwrite(str(root / "gspro_actual.png"), np.zeros((100,100,3), dtype=np.uint8))
            with patch.object(overlay.overlay_v0, "_load_geometry", return_value=geometry):
                with self.assertRaisesRegex(RuntimeError, "fairway_surface"):
                    overlay.build(
                        root,
                        forward_yds=80,
                        shot_profile={"sigma_lateral_yds":5,"sigma_forward_yds":8},
                    )

    def test_build_emits_unranked_candidates_inside_fairway(self):
        geometry = {
            "identity": {"hole_display": 1},
            "visual_truth": {"source_image": "gspro_actual.png"},
            "coordinate_transform": {
                "tee_pixel": {"x": 50, "y": 90},
                "pin_pixel": {"x": 50, "y": 10},
                "yards_per_pixel": 2.0,
            },
            "precise_pixel_geometry": [],
        }
        fairway = {
            "fairway_present": True,
            "fairway": {
                "polygon_minimap_pixel": [[35,80],[65,80],[65,30],[35,30]],
                "semantic_confidence": 0.8,
            },
        }
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cv2.imwrite(str(root / "gspro_actual.png"), np.zeros((100,100,3), dtype=np.uint8))
            (root / "fairway_surface_shadow_v0.json").write_text(json.dumps(fairway), encoding="utf-8")
            with patch.object(overlay.overlay_v0, "_load_geometry", return_value=geometry):
                got = overlay.build(
                    root,
                    forward_yds=80,
                    shot_profile={"sigma_lateral_yds":5,"sigma_forward_yds":8},
                    sample_count=128,
                )
            self.assertTrue(got["fairway_section"]["available"])
            self.assertGreaterEqual(len(got["candidates"]), 1)
            self.assertTrue(all(row["recommendation"] is None for row in got["candidates"]))
            self.assertFalse(got["strategy_authority"])
            self.assertTrue((root / "strategy_fairway_risk_overlay_v0.png").is_file())
            self.assertTrue((root / "strategy_fairway_risk_overlay_v0.json").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
