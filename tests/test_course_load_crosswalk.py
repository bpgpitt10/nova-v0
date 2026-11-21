"""A successful load writes the outline it found back to the crosswalk, so bad coordinates bite once."""
import os
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "course_model"))
os.environ.setdefault("SUPABASE_SECRET_KEY", "")
import course_load_worker as worker  # noqa: E402

REPORT = {"osmCourse": {"type": "relation", "id": 15701177, "name": "Dunes West Golf Club", "areaHa": 84.2},
          "center": {"lat": 32.9123, "lon": -79.8301}}


class CrosswalkTests(unittest.TestCase):
    def test_update_from_a_load(self):
        body = worker.crosswalk_update(REPORT)
        self.assertEqual((body["osm_type"], body["osm_id"], body["lat"], body["lon"]), ("relation", 15701177, 32.9123, -79.8301))
        self.assertEqual((body["status"], body["verified"], body["distance_m"]), ("matched", True, 0))

    def test_nothing_without_an_outline(self):
        self.assertIsNone(worker.crosswalk_update({}))
        self.assertIsNone(worker.crosswalk_update({"osmCourse": {"type": "node", "id": 1}, "center": {"lat": 1, "lon": 2}}))

    def test_patch_targets_the_gspro_key(self):
        calls = []
        with patch.object(worker, "rest", lambda method, path, body=None, key=None: calls.append((method, path, body)) or [{}]):
            worker.record_in_crosswalk({"gspro_course_key": "duneswest_gsp"}, REPORT, "k")
        method, path, body = calls[0]
        self.assertEqual(method, "PATCH")
        self.assertEqual(urllib.parse.unquote(path), 'course_crosswalk?gspro_keys=cs.{"duneswest_gsp"}')
        self.assertEqual(body["osm_id"], 15701177)

    def test_no_key_no_write_and_errors_never_fail_the_load(self):
        with patch.object(worker, "rest", side_effect=AssertionError("should not be called")):
            worker.record_in_crosswalk({"gspro_course_key": None}, REPORT, "k")
        with patch.object(worker, "rest", side_effect=RuntimeError("network")):
            worker.record_in_crosswalk({"gspro_course_key": "x_gsp"}, REPORT, "k")  # prints, doesn't raise


if __name__ == "__main__":
    unittest.main()
