#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import hazard_field_shadow as field
import hazard_geometry_contract as hg


class HazardFieldShadowTests(unittest.TestCase):
    def identity(self):
        return {
            "course_name": "DPC Pebble",
            "round_id": 212,
            "hole_display": 2,
            "hole_raw_zero_based": 1,
            "capture_id": "tee_capture_test",
        }

    def test_legacy_bunker_maps_pixel_and_yard_polygons(self):
        row = {
            "object_id": 7,
            "confidence": 0.81,
            "area_px": 44,
            "polygon_pixel": [[10, 20], [20, 20], [18, 30]],
            "polygon_yards": [
                {"forward_yds": 101, "lateral_yds": -4},
                {"forward_yds": 105, "lateral_yds": 1},
                {"forward_yds": 109, "lateral_yds": -2},
            ],
        }
        item = field._legacy_geometry(
            row, hazard_class="bunker", artifact="hazard_shadow_v0.json", identity=self.identity()
        )
        self.assertEqual(item["hazard_class"], "bunker")
        self.assertEqual(item["source"]["kind"], "legacy_bunker_cv")
        self.assertFalse(item["strategy_authority"])
        spaces = {rep["coordinate_space"] for rep in item["representations"]}
        self.assertEqual(spaces, {"minimap_pixel", "hole_local_yards"})
        yard = next(rep for rep in item["representations"] if rep["coordinate_space"] == "hole_local_yards")
        self.assertEqual(yard["points"][0], [-4.0, 101.0])

    def test_legacy_water_keeps_semantic_and_geometry_confidence_separate(self):
        row = {
            "object_id": 1,
            "confidence": 0.72,
            "polygon_pixel": [[1, 1], [6, 1], [3, 7]],
            "polygon_yards": [],
        }
        item = field._legacy_geometry(
            row, hazard_class="water", artifact="hazard_shadow_v0.json", identity=self.identity()
        )
        self.assertEqual(item["source"]["kind"], "legacy_water_cv")
        self.assertEqual(item["confidence"]["semantic"], 0.72)
        self.assertIsNone(item["confidence"]["geometry"])

    def test_red_penalty_never_becomes_water(self):
        row = {
            "object_id": 3,
            "forward_min_yds": 220,
            "forward_max_yds": 250,
            "lateral_min_yds": -18,
            "lateral_max_yds": 16,
            "centerline_crossings_yds": [231.5, 244.0],
        }
        item = field._red_geometry(row, artifact="hole_model.json", identity=self.identity())
        self.assertEqual(item["hazard_class"], "penalty_area")
        self.assertEqual(item["source"]["kind"], "red_penalty_cv")
        self.assertFalse(item["strategy_authority"])
        types = {rep["geometry_type"] for rep in item["representations"]}
        self.assertEqual(types, {"bbox", "point_set"})

    def test_red_bbox_is_declared_extent_not_exact_polygon(self):
        row = {
            "object_id": 1,
            "forward_min_yds": 50,
            "forward_max_yds": 80,
            "lateral_min_yds": -5,
            "lateral_max_yds": 12,
            "centerline_crossings_yds": [],
        }
        item = field._red_geometry(row, artifact="hole_model.json", identity=self.identity())
        rep = item["representations"][0]
        self.assertEqual(rep["bbox"], [-5.0, 50.0, 12.0, 80.0])
        self.assertIn("not an exact penalty polygon", rep["metadata"]["important"])

    def test_semantic_image_requires_positive_normal_frame_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "tee_hazard_safe_minimap.png").write_bytes(b"not-decoded-in-this-test")
            model = {
                "hazards": {"normal_frame_selection": {"trusted_for_red_penalty": True, "mode": "lower-heatmap-score"}},
                "green_surface": {"available": False},
                "capture": {"heatmap_pair_available": True},
                "minimap": {"canonical_mode": "fallback-lower-heatmap-score"},
            }
            path, policy = field._semantic_image(root, model)
            self.assertEqual(path.name, "tee_hazard_safe_minimap.png")
            self.assertTrue(policy["confirmed_heatmap_off"])
            self.assertEqual(policy["status"], "confirmed-heatmap-off")

    def test_semantic_image_does_not_trust_filename_alone(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "tee_hazard_safe_minimap.png").write_bytes(b"x")
            model = {"hazards": {"normal_frame_selection": {"trusted_for_red_penalty": False}}}
            _path, policy = field._semantic_image(root, model)
            self.assertFalse(policy["confirmed_heatmap_off"])
            self.assertEqual(policy["status"], "unconfirmed-as-presented")

    def test_bundle_preserves_cross_source_objects_but_never_authority(self):
        bunker = field._legacy_geometry(
            {
                "object_id": 1,
                "confidence": 0.8,
                "polygon_pixel": [[1, 1], [8, 1], [4, 8]],
                "polygon_yards": [],
            },
            hazard_class="bunker",
            artifact="hazard_shadow_v0.json",
            identity=self.identity(),
        )
        red = field._red_geometry(
            {
                "object_id": 1,
                "forward_min_yds": 100,
                "forward_max_yds": 130,
                "lateral_min_yds": -20,
                "lateral_max_yds": -5,
                "centerline_crossings_yds": [],
            },
            artifact="hole_model.json",
            identity=self.identity(),
        )
        bundle = hg.bundle([bunker, red])
        self.assertEqual(bundle["object_count"], 2)
        self.assertFalse(bundle["strategy_authority"])
        self.assertEqual(bundle["class_counts"]["bunker"], 1)
        self.assertEqual(bundle["class_counts"]["penalty_area"], 1)

    def test_collect_legacy_records_zero_results_as_a_real_run(self):
        payload = {
            "bunker": {"status": "full", "candidate_count": 17, "accepted_count": 0, "objects": []},
            "water": {"status": "full", "candidate_count": 8, "accepted_count": 0, "objects": []},
        }
        objects, errors = [], []
        status = field._collect_legacy(payload, self.identity(), objects, errors)
        self.assertEqual(status["bunker"]["accepted_count"], 0)
        self.assertEqual(status["water"]["accepted_count"], 0)
        self.assertTrue(status["bunker"]["zero_results_are_retained"])
        self.assertEqual(objects, [])
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
