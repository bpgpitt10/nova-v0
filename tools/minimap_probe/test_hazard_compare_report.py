import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import hazard_compare_report as compare
import hazard_geometry_contract as hg


def geom(hazard_class, source_kind, reps, *, identity=None):
    return hg.make_geometry(
        hazard_class=hazard_class,
        source_kind=source_kind,
        source_name=source_kind,
        source_object_id=f"{source_kind}-{hazard_class}",
        representations=reps,
        identity=identity or {"course_key": "Pebble_gsp", "hole_display": 2, "capture_id": "cap-1"},
    )


class HazardCompareReportTests(unittest.TestCase):
    def test_pairwise_matches_shared_normalized_geometry(self):
        a = geom(
            "bunker", "gemini_vlm",
            [hg.representation(
                geometry_type="bbox",
                coordinate_space="minimap_normalized",
                bbox=[0.10, 0.10, 0.30, 0.30],
                coordinate_authority="test",
            )],
        )
        b = geom(
            "bunker", "sam2",
            [hg.representation(
                geometry_type="polygon",
                coordinate_space="minimap_normalized",
                points=[[0.12, 0.12], [0.29, 0.12], [0.29, 0.29], [0.12, 0.29]],
                coordinate_authority="test",
            )],
        )
        row = compare.pairwise_comparisons([a, b], 0.10)[0]
        self.assertEqual(row["spatial_status"], "comparable")
        self.assertEqual(row["shared_coordinate_space"], "minimap_normalized")
        self.assertEqual(row["spatial_match_count"], 1)
        self.assertEqual(row["semantic_agreement_on_matches"], 1.0)

    def test_pairwise_surfaces_semantic_mismatch(self):
        rep_a = hg.representation(
            geometry_type="bbox", coordinate_space="minimap_normalized",
            bbox=[0.1, 0.1, 0.3, 0.3], coordinate_authority="test",
        )
        rep_b = hg.representation(
            geometry_type="bbox", coordinate_space="minimap_normalized",
            bbox=[0.11, 0.11, 0.31, 0.31], coordinate_authority="test",
        )
        a = geom("bunker", "gemini_vlm", [rep_a])
        b = geom("water", "legacy_water_cv", [rep_b])
        row = compare.pairwise_comparisons([a, b], 0.10)[0]
        self.assertEqual(row["spatial_match_count"], 1)
        self.assertEqual(row["semantic_agreement_on_matches"], 0.0)
        self.assertEqual(len(row["semantic_mismatches"]), 1)

    def test_unproven_unity_space_is_not_compared_to_world(self):
        world = geom(
            "penalty_area", "gkd",
            [hg.representation(
                geometry_type="polygon", coordinate_space="gspro_world_xz",
                points=[[0, 0], [10, 0], [10, 10], [0, 10]],
                coordinate_authority="test", comparable_to_gspro_world=True,
                transform_status="direct",
            )],
        )
        unity = geom(
            "bunker", "unity_asset",
            [hg.representation(
                geometry_type="polygon", coordinate_space="unknown_asset_or_serialized_space",
                points=[[0, 0], [10, 0], [10, 10], [0, 10]],
                coordinate_authority="test",
                transform_status="unproven",
            )],
        )
        row = compare.pairwise_comparisons([world, unity])[0]
        self.assertEqual(row["spatial_status"], "not-comparable-no-shared-trusted-space")
        inventory = compare.source_inventory([world, unity])
        score = compare.combined_source_scorecard(inventory, {"source_scorecard": {"sources": []}})
        unity_row = next(x for x in score if x["source_kind"] == "unity_asset")
        self.assertEqual(unity_row["evidence_state"], "coordinate-transform-blocked")

    def test_world_hazardgeometry_bridges_into_physical_shot_truth(self):
        bunker = geom(
            "bunker", "gkd",
            [hg.representation(
                geometry_type="polygon", coordinate_space="gspro_world_xz",
                points=[[0, 0], [10, 0], [10, 10], [0, 10]],
                coordinate_authority="test", comparable_to_gspro_world=True,
                transform_status="direct",
            )],
            identity={"course_key": "Pebble_gsp", "hole_display": 2},
        )
        observation = {
            "observation_id": "sand-1",
            "point_xz": {"x": 5.0, "z": 5.0},
            "expectation": "sand",
            "compatible_semantics": ["bunker", "bunker_or_sand"],
            "truth_strength": "strong",
            "validation_eligible": True,
            "hole_display": 2,
            "hole_raw_zero_based": 1,
        }
        truth = compare.truth_analysis([bunker], [observation], near_tolerance=3.0)
        row = truth["source_scorecard"]["sources"][0]
        self.assertEqual(row["source"], "gkd")
        self.assertEqual(row["positive_hits"], 1)
        self.assertEqual(row["positive_misses"], 0)

    def test_gkd_penalty_geometry_does_not_get_credit_for_known_sand(self):
        penalty = geom(
            "penalty_area", "gkd",
            [hg.representation(
                geometry_type="polygon", coordinate_space="gspro_world_xz",
                points=[[0, 0], [10, 0], [10, 10], [0, 10]],
                coordinate_authority="test", comparable_to_gspro_world=True,
                transform_status="direct",
            )],
            identity={"course_key": "Pebble_gsp", "hole_display": 2},
        )
        observation = {
            "observation_id": "sand-1",
            "point_xz": {"x": 5.0, "z": 5.0},
            "expectation": "sand",
            "compatible_semantics": ["bunker", "bunker_or_sand"],
            "truth_strength": "strong",
            "validation_eligible": True,
            "hole_display": 2,
            "hole_raw_zero_based": 1,
        }
        truth = compare.truth_analysis([penalty], [observation], near_tolerance=3.0)
        row = truth["source_scorecard"]["sources"][0]
        self.assertEqual(row["positive_hits"], 0)
        self.assertEqual(row["positive_misses"], 1)

    def test_different_minimap_captures_are_not_compared(self):
        rep = lambda: hg.representation(
            geometry_type="bbox", coordinate_space="minimap_normalized",
            bbox=[0.1, 0.1, 0.2, 0.2], coordinate_authority="test",
        )
        a = geom("bunker", "gemini_vlm", [rep()], identity={"course_key": "X", "hole_display": 1, "capture_id": "A"})
        b = geom("bunker", "sam2", [rep()], identity={"course_key": "X", "hole_display": 1, "capture_id": "B"})
        row = compare.pairwise_comparisons([a, b])[0]
        self.assertEqual(row["spatial_status"], "not-comparable-no-shared-trusted-space")

    def test_report_and_summary_never_promote(self):
        a = geom(
            "bunker", "gemini_vlm",
            [hg.representation(
                geometry_type="bbox", coordinate_space="minimap_normalized",
                bbox=[0.1, 0.1, 0.2, 0.2], coordinate_authority="test",
            )],
        )
        inventory = compare.source_inventory([a])
        truth = compare.truth_analysis([a], [], near_tolerance=3.0)
        score = compare.combined_source_scorecard(inventory, truth)
        summary = compare.build_summary([a], [], inventory, [], truth)
        report = compare.render_markdown(summary, score, [], truth, bundle_paths=[], round_paths=[])
        self.assertFalse(summary["strategy_authority"])
        self.assertEqual(summary["promotion_decision"], "none")
        self.assertFalse(score[0]["promotion_eligible"])
        self.assertIn("Strategy authority: OFF", report)
        self.assertIn("Promotion decision: NONE", report)


if __name__ == "__main__":
    unittest.main()
