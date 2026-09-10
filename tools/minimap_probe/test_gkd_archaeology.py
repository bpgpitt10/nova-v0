import base64
import gzip
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gkd_archaeology as g


class GkdArchaeologyTests(unittest.TestCase):
    def fixture(self):
        return {
            "gkversion": "4.07",
            "CourseName": "Synthetic Valley",
            "SceneFolderName": "synthetic_valley_gsp",
            "Holes": [
                {
                    "holeNumber": 1,
                    "tees": [{"name": "Blue", "position": {"x": 10, "y": 2, "z": 20}}],
                    "pin": {"x": 100, "y": 5, "z": 220},
                    "Hazards": [
                        {
                            "hazardType": "red penalty",
                            "hasDZ": True,
                            "coords": [
                                {"x": 40, "y": 1, "z": 80},
                                {"x": 50, "y": 1, "z": 80},
                                {"x": 50, "y": 1, "z": 95},
                                {"x": 40, "y": 1, "z": 80},
                            ],
                        }
                    ],
                }
            ],
        }

    def test_plain_json_decode_and_metadata(self):
        report = g.analyze_gkd_bytes(json.dumps(self.fixture()).encode(), "plain.gkd")
        self.assertTrue(report["decoded"])
        values = {m["value"] for m in report["analysis"]["metadata_candidates"]}
        self.assertIn("4.07", values)
        self.assertIn("Synthetic Valley", values)
        self.assertGreater(report["analysis"]["feature_count"], 0)

    def test_base64_gzip_json_decode(self):
        raw = json.dumps(self.fixture()).encode()
        report = g.analyze_gkd_bytes(base64.b64encode(gzip.compress(raw)), "wrapped")
        self.assertTrue(report["decoded"])
        chain = " ".join(report["decode_chain"])
        self.assertIn("base64", chain)
        self.assertIn("gzip", chain)

    def test_embedded_prefix_json(self):
        raw = b"GKD_HEADER_v1\x00\x01garbage\n" + json.dumps(self.fixture()).encode()
        report = g.analyze_gkd_bytes(raw, "prefixed")
        self.assertTrue(report["decoded"])
        self.assertIn("embedded-json", " ".join(report["decode_chain"]))

    def test_coordinate_feature_and_hole_hint(self):
        report = g.analyze_gkd_bytes(json.dumps(self.fixture()).encode(), "plain")
        hazard = next(f for f in report["analysis"]["features"] if f["container_key"] == "coords")
        self.assertEqual(hazard["point_count"], 4)
        self.assertEqual(hazard["hole_hint"]["value"], 1)
        self.assertIn("penalty_area", hazard["semantic_candidates"])
        self.assertTrue(hazard["explicitly_closed"])
        self.assertEqual(hazard["bounds_xz"]["min_x"], 40.0)

    def test_generic_hazard_never_becomes_bunker(self):
        fixture = {"Hazards": [{"coords": [[0, 0], [10, 0], [10, 10]]}]}
        report = g.analyze_gkd_bytes(json.dumps(fixture).encode(), "generic")
        feature = report["analysis"]["features"][0]
        self.assertIn("hazard_unspecified", feature["semantic_candidates"])
        self.assertNotIn("bunker_or_sand", feature["semantic_candidates"])

    def test_db_coursegkd_opaque_payload_not_path(self):
        payload = base64.b64encode(json.dumps(self.fixture()).encode()).decode()
        rows = [{"ID": 12, "CourseName": "Synthetic Valley", "CourseGKD": payload}]
        self.assertFalse(g.looks_like_windows_gkd_path(payload))
        payloads = g.payloads_from_round_rows(rows)
        self.assertEqual(len(payloads), 1)
        self.assertTrue(g.analyze_gkd_bytes(payloads[0][1], payloads[0][0])["decoded"])

    def test_real_path_is_not_payload(self):
        path = r"C:\GSProV1\Core\GSP\Courses\greywolf_gsp\greywolf_gsp.gkd"
        self.assertTrue(g.looks_like_windows_gkd_path(path))
        self.assertEqual(g.payloads_from_round_rows([{"ID": 1, "CourseGKD": path}]), [])


if __name__ == "__main__":
    unittest.main()
