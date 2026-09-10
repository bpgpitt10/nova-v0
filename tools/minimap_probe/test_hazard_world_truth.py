import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import hazard_world_truth as h


class HazardWorldTruthTests(unittest.TestCase):
    def square(self, semantic="bunker_or_sand", source="gkd"):
        return {
            "candidate_id": "c1",
            "source": source,
            "source_kind": "gkd",
            "semantics": [semantic],
            "points_xz": [
                {"x": 0.0, "z": 0.0},
                {"x": 10.0, "z": 0.0},
                {"x": 10.0, "z": 10.0},
                {"x": 0.0, "z": 10.0},
            ],
            "polygon_candidate": True,
            "coordinate_space": "gspro_world_xz",
            "coordinate_space_status": "test",
            "comparable_to_shots": True,
            "hole_hint": None,
            "strategy_authority": False,
        }

    def observation(self, expectation="sand", x=5.0, z=5.0, role="shot_end"):
        semantics = {
            "sand": ["bunker_or_sand"],
            "water_event": ["water", "penalty_area"],
            "water_boundary": ["water", "penalty_area"],
            "safe_surface": [],
        }.get(expectation, [])
        return {
            "observation_id": "o1",
            "role": role,
            "point_xz": {"x": x, "z": z},
            "expectation": expectation,
            "compatible_semantics": semantics,
            "validation_eligible": True,
            "hole_raw_zero_based": 0,
            "hole_display": 1,
        }

    def test_sand_inside_bunker_matches(self):
        result = h.validate([self.observation()], [self.square()])
        source = result["results"][0]["sources"]["gkd"]
        self.assertEqual(source["verdict"], "matched")
        self.assertTrue(source["nearest"]["contains"])

    def test_sand_far_from_bunker_misses(self):
        result = h.validate([self.observation(x=100, z=100)], [self.square()], near_tolerance=3.0)
        self.assertEqual(result["results"][0]["sources"]["gkd"]["verdict"], "missed")

    def test_safe_point_inside_hazard_is_contradiction(self):
        result = h.validate([self.observation(expectation="safe_surface")], [self.square()])
        self.assertEqual(result["results"][0]["sources"]["gkd"]["verdict"], "safe-point-inside-hazard")
        self.assertEqual(result["results"][0]["overall"]["verdict"], "contradiction")

    def test_water_entry_uses_boundary_distance(self):
        candidate = self.square(semantic="water")
        obs = self.observation(expectation="water_boundary", x=10.5, z=5.0, role="hazard_entry")
        result = h.validate([obs], [candidate], near_tolerance=1.0)
        source = result["results"][0]["sources"]["gkd"]
        self.assertEqual(source["verdict"], "boundary-matched")
        self.assertAlmostEqual(source["nearest"]["distance_to_boundary"], 0.5, places=6)

    def test_untrusted_unity_coordinates_cannot_validate(self):
        candidate = self.square()
        candidate.update(source="unity", source_kind="unity_asset", comparable_to_shots=False, coordinate_space="unknown_asset_or_serialized_space")
        result = h.validate([self.observation()], [candidate])
        self.assertEqual(result["results"][0]["overall"]["reason"], "no-world-space-comparable-geometry")
        self.assertEqual(result["results"][0]["sources"]["unity"]["untrusted_coordinate_candidate_count"], 1)

    def test_gkd_generic_hazard_does_not_validate_sand(self):
        candidate = self.square(semantic="hazard_unspecified")
        result = h.validate([self.observation()], [candidate])
        self.assertEqual(result["results"][0]["sources"]["gkd"]["verdict"], "no-compatible-geometry")

    def test_gimme_is_terminal_only(self):
        shots = [
            {
                "round_id": 1, "shot_id": "a", "hole_raw_zero_based": 0, "hole_display": 1,
                "hole_shot": 1, "global_shot_number": 7, "is_gimme": False,
                "starting_surface": "green", "ending_surface": "green",
                "starting_pos": {"x": 1, "y": 0, "z": 1}, "ending_pos": {"x": 2, "y": 0, "z": 2},
            },
            {
                "round_id": 1, "shot_id": "b", "hole_raw_zero_based": 0, "hole_display": 1,
                "hole_shot": 2, "global_shot_number": 7, "is_gimme": True,
                "starting_surface": "green", "ending_surface": "green",
                "starting_pos": {"x": 2, "y": 0, "z": 2}, "ending_pos": {"x": 2.2, "y": 0, "z": 2.2},
            },
        ]
        obs = h.build_observations(shots)
        terminal = [o for o in obs if o["role"] == "terminal_only"]
        self.assertEqual(len(terminal), 1)
        self.assertFalse(terminal[0]["validation_eligible"])
        self.assertEqual(terminal[0]["physicality_reason"], "gimme-terminal-repeated-global")

    def test_loads_gkd_features_as_world_comparable(self):
        payload = {
            "features": [{
                "feature_id": "g1",
                "source": "file:test.gkd",
                "semantic_candidates": ["penalty_area"],
                "points_xyz": [{"x": 0, "y": 1, "z": 0}, {"x": 5, "y": 1, "z": 0}, {"x": 5, "y": 1, "z": 5}],
                "polygon_candidate": True,
            }]
        }
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "features.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            rows = h.load_geometry_file(path)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["comparable_to_shots"])
        self.assertEqual(rows[0]["coordinate_space"], "gspro_world_xz")

    def test_loads_unproven_asset_geometry_as_diagnostic_only(self):
        payload = {
            "geometry": [{
                "asset_file": "course.gspcrse",
                "path_id": 99,
                "seed_semantic_hits": {"bunker": ["sand"]},
                "points": [[0, 0], [5, 0], [5, 5]],
                "polygon_candidate": True,
            }]
        }
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "geometry_candidates.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            rows = h.load_geometry_file(path)
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["comparable_to_shots"])
        self.assertIn("bunker_or_sand", rows[0]["semantics"])


if __name__ == "__main__":
    unittest.main()
