import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import course_asset_archaeology as a


class CourseAssetArchaeologyTests(unittest.TestCase):
    def test_semantic_hits_distinguish_bunker_and_water(self):
        bunker = a.semantic_hits("Fairway_Bunker_03 TVGsand")
        water = a.semantic_hits("CreekWaterSpline")
        self.assertIn("bunker", bunker)
        self.assertNotIn("water", bunker)
        self.assertIn("water", water)
        self.assertIn("spline", water)

    def test_pptr_signature_dict(self):
        ref = a.pptr_signature({"m_FileID": 0, "m_PathID": 42})
        self.assertEqual(ref, {"file_id": 0, "path_id": 42})

    def test_coordinate_sequence_from_xyz_points(self):
        data = {
            "SplinePoints": [
                {"x": 1, "y": 2, "z": 3},
                {"x": 4, "y": 5, "z": 6},
                {"x": 7, "y": 8, "z": 9},
            ]
        }
        found = a.coordinate_sequences(data, object_path_id=8)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["point_count"], 3)
        self.assertEqual(found[0]["bounds_xz"]["min_x"], 1.0)
        self.assertEqual(found[0]["bounds_xz"]["max_z"], 9.0)
        self.assertTrue(found[0]["polygon_candidate"])

    def test_coordinate_sequence_from_2d_numeric_tuples(self):
        data = {"boundary": [[0, 0], [10, 0], [10, 15], [0, 0]]}
        found = a.coordinate_sequences(data, object_path_id=9)
        self.assertEqual(found[0]["point_count"], 4)
        self.assertEqual(found[0]["points"][1]["x"], 10.0)
        self.assertEqual(found[0]["points"][2]["z"], 15.0)

    def test_semantics_propagate_gameobject_to_mesh_two_hops(self):
        reports = [
            {
                "file": "course.gspcrse",
                "objects": [
                    {
                        "path_id": 1,
                        "type": "GameObject",
                        "name": "Bunker_Left",
                        "semantic_score_direct": 9,
                        "semantic_hits": {"bunker": ["bunker"]},
                        "references": [{"json_path": "$.m_Component[0]", "file_id": 0, "path_id": 2}],
                        "coordinate_structures": [],
                    },
                    {
                        "path_id": 2,
                        "type": "MeshFilter",
                        "name": None,
                        "semantic_score_direct": 0,
                        "semantic_hits": {},
                        "references": [{"json_path": "$.m_Mesh", "file_id": 0, "path_id": 3}],
                        "coordinate_structures": [],
                    },
                    {
                        "path_id": 3,
                        "type": "Mesh",
                        "name": "Mesh_17",
                        "semantic_score_direct": 1,
                        "semantic_hits": {"terrain": ["mesh"]},
                        "references": [],
                        "coordinate_structures": [],
                    },
                ],
            }
        ]
        candidates = a.propagate_semantics(reports, max_hops=2)
        mesh = next(c for c in candidates if c["path_id"] == 3)
        self.assertEqual(mesh["seed_path_id"], 1)
        self.assertEqual(mesh["graph_hops"], 2)
        self.assertEqual(mesh["semantic_score_effective"], 5)
        self.assertIn("bunker", mesh["seed_semantic_hits"])

    def test_cross_file_pptr_is_not_joined_as_same_file(self):
        reports = [
            {
                "file": "a.assets",
                "objects": [
                    {
                        "path_id": 1,
                        "type": "GameObject",
                        "name": "Water",
                        "semantic_score_direct": 9,
                        "semantic_hits": {"water": ["water"]},
                        "references": [{"json_path": "$.external", "file_id": 1, "path_id": 2}],
                        "coordinate_structures": [],
                    },
                    {
                        "path_id": 2,
                        "type": "Mesh",
                        "name": "Unrelated",
                        "semantic_score_direct": 1,
                        "semantic_hits": {"terrain": ["mesh"]},
                        "references": [],
                        "coordinate_structures": [],
                    },
                ],
            }
        ]
        candidates = a.propagate_semantics(reports)
        ids = {c["path_id"] for c in candidates}
        self.assertIn(1, ids)
        self.assertNotIn(2, ids)

    def test_generic_mesh_is_not_a_hazard_seed(self):
        reports = [
            {
                "file": "course.assets",
                "objects": [
                    {
                        "path_id": 10,
                        "type": "Mesh",
                        "name": "Mesh",
                        "semantic_score_direct": 1,
                        "semantic_hits": {"terrain": ["mesh"]},
                        "references": [],
                        "coordinate_structures": [],
                    }
                ],
            }
        ]
        self.assertEqual(a.propagate_semantics(reports), [])


if __name__ == "__main__":
    unittest.main()
