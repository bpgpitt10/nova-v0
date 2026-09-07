from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import green_visibility
import hole_model_cache
import round_identity


class RoundIdentityCacheTests(unittest.TestCase):
    def _capture(self, root: Path, name: str, identity: dict | None) -> Path:
        capture = root / name
        capture.mkdir(parents=True)
        cv2.imwrite(str(capture / "tee_heatmap_minimap.png"), np.zeros((80, 80, 3), dtype=np.uint8))
        model = {
            "schema_version": "tee-hole-model-v0",
            "canonical_minimap": "tee_heatmap_minimap.png",
            "round_identity": identity,
        }
        (capture / "hole_model.json").write_text(json.dumps(model), encoding="utf-8")
        return capture

    def test_normalize_course_name_is_stable(self):
        self.assertEqual(round_identity.normalize_course_name(" The Old Game "), "the old game")
        self.assertEqual(round_identity.normalize_course_name("Old & New"), "old and new")

    def test_exact_course_hole_beats_newer_wrong_hole(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            correct = self._capture(root, "tee_capture_20260906_100000", {
                "course_name": "The Old Game", "hole_number": 2, "par": 5, "hole_yards": 501,
            })
            wrong = self._capture(root, "tee_capture_20260906_110000", {
                "course_name": "The Old Game", "hole_number": 3, "par": 4, "hole_yards": 410,
            })
            # Make the wrong hole newer to prove latest-capture ordering no longer wins.
            wrong.touch()
            selection = hole_model_cache.find_hole_model(root, identity={
                "course_name": "The Old Game", "hole_number": 2, "par": 5, "hole_yards": 501,
            })
            self.assertEqual(selection.model_path.parent, correct)
            self.assertEqual(selection.method, "course-hole-exact")

    def test_legacy_models_allow_explicit_latest_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            latest = self._capture(root, "tee_capture_20260906_120000", None)
            selection = hole_model_cache.find_hole_model(root, identity={
                "course_name": "The Old Game", "hole_number": 2, "par": 5, "hole_yards": 501,
            })
            self.assertEqual(selection.model_path.parent, latest)
            self.assertEqual(selection.method, "legacy-latest-no-tagged-models")
            self.assertIsNotNone(selection.warning)

    def test_mismatched_tagged_hole_refuses_silent_wrong_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._capture(root, "tee_capture_20260906_120000", {
                "course_name": "The Old Game", "hole_number": 3, "par": 4, "hole_yards": 410,
            })
            with self.assertRaises(RuntimeError):
                hole_model_cache.find_hole_model(root, identity={
                    "course_name": "The Old Game", "hole_number": 2, "par": 5, "hole_yards": 501,
                })

    def test_green_visibility_can_use_registration_scale_without_visible_pin(self):
        hole_model = {
            "minimap": {
                "pin_pixel": {"x": 100.0, "y": 100.0},
                "yards_per_pixel": 0.5,
            },
            "green_surface": {
                "target_green_bbox": [80, 80, 40, 40],
            },
        }
        result = green_visibility.evaluate_visibility(
            hole_model=hole_model,
            minimap_width=300,
            minimap_height=300,
            ball_x=150,
            ball_y=250,
            pin_x=150,
            pin_y=120,
            pin_distance_yds=999,  # intentionally irrelevant when registration scale is supplied
            current_yards_per_pixel=0.5,
        )
        self.assertTrue(result.visible)
        self.assertAlmostEqual(result.current_yards_per_pixel, 0.5)


if __name__ == "__main__":
    unittest.main()
