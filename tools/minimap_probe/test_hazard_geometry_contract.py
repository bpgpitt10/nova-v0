import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import hazard_geometry_contract as h


class HazardGeometryContractTests(unittest.TestCase):
    def test_strategy_authority_cannot_be_enabled(self):
        rep = h.representation(
            geometry_type="bbox", coordinate_space="minimap_normalized",
            bbox=[0.1, 0.2, 0.3, 0.4], transform_status="image-space-only",
        )
        with self.assertRaises(ValueError):
            h.make_geometry(
                hazard_class="bunker", source_kind="vlm", source_name="test",
                source_object_id="b1", representations=[rep], strategy_authority=True,
            )

    def test_geometry_id_is_deterministic(self):
        rep = h.representation(
            geometry_type="bbox", coordinate_space="minimap_normalized",
            bbox=[0.1, 0.2, 0.3, 0.4], transform_status="image-space-only",
        )
        kwargs = dict(hazard_class="bunker", source_kind="gemini_vlm", source_name="Gemini", source_object_id="b1", representations=[rep])
        self.assertEqual(h.make_geometry(**kwargs)["geometry_id"], h.make_geometry(**kwargs)["geometry_id"])

    def test_gkd_generic_hazard_never_becomes_bunker(self):
        row = {
            "feature_id": "g1", "source": "test.gkd",
            "semantic_candidates": ["hazard_unspecified"],
            "points_xyz": [{"x": 0, "z": 0}, {"x": 5, "z": 0}, {"x": 5, "z": 5}],
            "polygon_candidate": True,
        }
        obj = h.from_gkd_feature(row)
        self.assertEqual(obj["hazard_class"], "generic_hazard")
        self.assertTrue(obj["representations"][0]["comparable_to_gspro_world"])

    def test_gkd_penalty_world_polygon(self):
        row = {
            "feature_id": "g2", "source": "test.gkd",
            "semantic_candidates": ["penalty_area"],
            "points_xyz": [{"x": 1, "y": 2, "z": 3}, {"x": 4, "y": 2, "z": 3}, {"x": 4, "y": 2, "z": 8}],
            "polygon_candidate": True,
        }
        obj = h.from_gkd_feature(row)
        self.assertEqual(obj["hazard_class"], "penalty_area")
        rep = obj["representations"][0]
        self.assertEqual(rep["coordinate_space"], "gspro_world_xz")
        self.assertEqual(rep["points"][0], [1.0, 3.0])

    def test_unity_geometry_is_not_world_comparable(self):
        row = {
            "asset_file": "course.gspcrse", "path_id": 99,
            "seed_semantic_hits": {"bunker": ["sand"]},
            "points": [[0, 0], [5, 0], [5, 5]], "polygon_candidate": True,
        }
        obj = h.from_unity_geometry(row)
        rep = obj["representations"][0]
        self.assertEqual(obj["hazard_class"], "bunker")
        self.assertEqual(rep["coordinate_space"], "unknown_asset_or_serialized_space")
        self.assertFalse(rep["comparable_to_gspro_world"])
        self.assertIn("awaiting-field", rep["transform_status"])

    def test_gemini_bbox_is_semantics_only(self):
        obj = h.from_vlm_hazard({
            "hazard_id": "b1", "hazard_class": "bunker", "confidence": 0.96,
            "bbox_norm": [0.2, 0.3, 0.4, 0.5],
        })
        self.assertEqual(obj["confidence"]["semantic"], 0.96)
        self.assertIsNone(obj["confidence"]["geometry"])
        self.assertEqual(obj["representations"][0]["geometry_type"], "bbox")
        self.assertFalse(obj["representations"][0]["comparable_to_gspro_world"])

    def test_sam_preserves_pixel_and_normalized_polygons(self):
        row = {
            "hazard_id": "b1", "hazard_class": "bunker", "semantic_confidence": 0.94,
            "semantic_bbox_norm": [0.2, 0.3, 0.4, 0.5],
            "segmentation_status": "accepted", "segmentation_quality_score": 0.82,
            "model_mask_score": 0.91,
            "polygon_px": [[10, 20], [30, 20], [30, 40], [10, 40]],
            "polygon_norm": [[0.1, 0.2], [0.3, 0.2], [0.3, 0.4], [0.1, 0.4]],
            "metrics": {"mask_area_px": 300},
        }
        obj = h.from_sam_object(row, mask_artifact="masks/b1.png")
        spaces = {(r["geometry_type"], r["coordinate_space"]) for r in obj["representations"]}
        self.assertIn(("polygon", "minimap_pixel"), spaces)
        self.assertIn(("polygon", "minimap_normalized"), spaces)
        self.assertIn(("mask_ref", "minimap_pixel"), spaces)
        self.assertEqual(obj["confidence"]["semantic"], 0.94)
        self.assertEqual(obj["confidence"]["geometry"], 0.82)

    def test_semantic_and_geometry_confidence_remain_distinct(self):
        row = {
            "hazard_id": "w1", "hazard_class": "water", "semantic_confidence": 0.97,
            "semantic_bbox_norm": [0.1, 0.1, 0.3, 0.3],
            "segmentation_status": "accepted", "segmentation_quality_score": 0.61,
            "polygon_norm": [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]],
        }
        obj = h.from_sam_object(row)
        self.assertEqual(obj["confidence"], {"semantic": 0.97, "geometry": 0.61})

    def test_invalid_normalized_coordinates_rejected(self):
        with self.assertRaises(ValueError):
            h.representation(
                geometry_type="polygon", coordinate_space="minimap_normalized",
                points=[[0, 0], [1.1, 0], [0.5, 0.5]],
            )
        with self.assertRaises(ValueError):
            h.representation(
                geometry_type="bbox", coordinate_space="minimap_normalized",
                bbox=[0.4, 0.4, 0.2, 0.8],
            )

    def test_red_penalty_adapter_does_not_create_water(self):
        obj = h.from_red_penalty_object({
            "id": "r1", "confidence": 0.92,
            "polyline_px": [[5, 5], [10, 10], [15, 9]],
        })
        self.assertEqual(obj["hazard_class"], "penalty_area")
        self.assertEqual(obj["source"]["kind"], "red_penalty_cv")

    def test_vlm_payload_adapter(self):
        payload = {
            "schema_version": "looper-hazard-vlm-v0",
            "bunkers": [{"id": "b1", "confidence": 0.95, "bbox_norm": [0.1, 0.2, 0.3, 0.4]}],
            "water": [], "uncertain": [],
        }
        rows, errors = h.normalize_payload(payload, artifact="hazard_vlm_response.json")
        self.assertEqual(errors, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["hazard_class"], "bunker")

    def test_gkd_unity_and_sam_can_coexist_in_bundle(self):
        gkd = h.from_gkd_feature({
            "feature_id": "g1", "source": "course.gkd", "semantic_candidates": ["penalty_area"],
            "points_xyz": [{"x": 0, "z": 0}, {"x": 10, "z": 0}, {"x": 10, "z": 10}], "polygon_candidate": True,
        })
        unity = h.from_unity_geometry({
            "asset_file": "course.gspcrse", "path_id": 8,
            "seed_semantic_hits": {"bunker": ["sand"]}, "points": [[1, 1], [2, 1], [2, 2]], "polygon_candidate": True,
        })
        sam = h.from_sam_object({
            "hazard_id": "b1", "hazard_class": "bunker", "semantic_confidence": 0.9,
            "semantic_bbox_norm": [0.1, 0.1, 0.2, 0.2], "segmentation_status": "accepted",
            "segmentation_quality_score": 0.7,
            "polygon_norm": [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]],
        })
        out = h.bundle([gkd, unity, sam])
        self.assertEqual(out["object_count"], 3)
        self.assertEqual(out["source_counts"]["gkd"], 1)
        self.assertEqual(out["source_counts"]["unity_asset"], 1)
        self.assertEqual(out["source_counts"]["sam2"], 1)
        self.assertFalse(out["strategy_authority"])

    def test_tampered_strategy_authority_rejected(self):
        obj = h.from_vlm_hazard({
            "hazard_id": "b1", "hazard_class": "bunker", "confidence": 0.9,
            "bbox_norm": [0.1, 0.1, 0.2, 0.2],
        })
        obj["strategy_authority"] = True
        with self.assertRaises(ValueError):
            h.validate_geometry(obj)


if __name__ == "__main__":
    unittest.main()
