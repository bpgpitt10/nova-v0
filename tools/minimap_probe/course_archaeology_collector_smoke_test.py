"""Tiny standalone smoke test used by CI/local dev without touching GSPro.

Run from repo root:
    python tools/minimap_probe/course_archaeology_collector_smoke_test.py
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import course_archaeology_collector as c


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        locallow = root / "LocalLow" / "GSPro" / "GSPro"
        locallow.mkdir(parents=True)
        db = locallow / "GSPro.db"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE Round (ID INTEGER PRIMARY KEY, CourseName TEXT, CourseGKD TEXT, ActiveHole INTEGER)")
        conn.execute("INSERT INTO Round VALUES (1, 'demo_gsp', ?, 1)", (str(root / 'demo_gsp' / 'demo.gkd'),))
        conn.commit()
        conn.close()
        (locallow / "currentRound.dat").write_text("[]", encoding="utf-8")

        course = root / "demo_gsp"
        course.mkdir()
        (course / "demo.gkd").write_text('{"Hazards":[]}', encoding="utf-8")
        (course / "demo.unity3d").write_bytes(b"UnityFS bunker sand water terrain")

        selected, _ = c.choose_locallow(str(locallow))
        assert selected == locallow
        snap = c.sqlite_snapshot(db, root / "out")
        assert snap["recent_round_rows"][0]["CourseName"] == "demo_gsp"
        inv = c.analyze_course_folder(course, root / "out", 1024 * 1024, 1024 * 1024, 100)
        assert inv["file_count"] == 2
        assert (root / "out" / "course_files_small" / "demo.gkd").exists()
    print("course archaeology collector smoke test: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
