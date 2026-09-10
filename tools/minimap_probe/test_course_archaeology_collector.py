import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import course_archaeology_collector as collector


class CourseArchaeologyCollectorTests(unittest.TestCase):
    def test_choose_locallow_scores_expected_files(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for name in ("GSPro.db", "currentRound.dat", "output_log.txt"):
                (root / name).write_bytes(b"")
            self.assertGreaterEqual(collector.score_locallow(root), 15)

    def test_sqlite_snapshot_reads_coursegkd(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db = root / "GSPro.db"
            conn = sqlite3.connect(db)
            conn.execute(
                "CREATE TABLE Round (ID INTEGER PRIMARY KEY, CourseName TEXT, CourseGKD TEXT, ActiveHole INTEGER)"
            )
            conn.execute(
                "INSERT INTO Round (ID, CourseName, CourseGKD, ActiveHole) VALUES (1, ?, ?, 3)",
                ("testcourse_gsp", r"C:\\GSProV1\\Core\\GSP\\Courses\\testcourse_gsp\\testcourse_gsp.gkd"),
            )
            conn.commit()
            conn.close()

            snap = collector.sqlite_snapshot(db, root / "out", recent_rows=5)
            self.assertEqual(snap["recent_round_rows"][0]["CourseName"], "testcourse_gsp")
            self.assertIn("CourseGKD", snap["recent_round_rows"][0])

    def test_course_inventory_is_bounded_and_copies_small_gkd(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            course = root / "course"
            course.mkdir()
            (course / "course.gkd").write_text('{"Hazards":[]}', encoding="utf-8")
            (course / "large.unity3d").write_bytes(b"UnityFS" + b"sand bunker terrain" + b"x" * 1024)

            out = root / "out"
            result = collector.analyze_course_folder(
                course,
                out,
                max_copy_bytes=1024 * 1024,
                max_full_hash_bytes=1024 * 1024,
                max_files=100,
            )
            self.assertEqual(result["file_count"], 2)
            self.assertTrue((out / "course_files_small" / "course.gkd").exists())
            inventory = json.loads((out / "course_inventory.json").read_text(encoding="utf-8"))
            unity = next(x for x in inventory["files"] if x["relative_path"] == "large.unity3d")
            self.assertGreaterEqual(unity["signal_string_count"], 1)


if __name__ == "__main__":
    unittest.main()
