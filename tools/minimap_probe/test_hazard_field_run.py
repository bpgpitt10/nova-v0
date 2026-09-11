import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import hazard_field_run as field


class HazardFieldRunTests(unittest.TestCase):
    def test_new_capture_dirs_excludes_old_unchanged_capture(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            old = root / "tee_capture_old"
            old.mkdir()
            baseline = field._capture_dirs(root)
            started = time.time()
            new = root / "tee_capture_new"
            new.mkdir()
            rows = field._new_capture_dirs(root, baseline, started)
            self.assertEqual([p.name for p in rows], ["tee_capture_new"])

    def test_shadow_wait_is_fail_soft(self):
        with tempfile.TemporaryDirectory() as td:
            tee = Path(td) / "tee_capture_1"
            tee.mkdir()
            result = field._wait_for_shadow([tee], timeout_s=0)
            self.assertEqual(result["pending"], ["tee_capture_1"])

    def test_copy_budget_skips_large_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            source.mkdir()
            (source / "hazard_geometry_v0.json").write_text("{}", encoding="utf-8")
            (source / "giant.dat").write_bytes(b"x" * 200)
            records = []
            remaining = [1000]
            field._copy_allowed_tree(
                source,
                root / "dest",
                max_file_bytes=100,
                remaining_bytes=remaining,
                records=records,
                source_label="test",
            )
            self.assertTrue((root / "dest" / "hazard_geometry_v0.json").exists())
            self.assertFalse((root / "dest" / "giant.dat").exists())
            self.assertTrue(any(row["status"] == "skipped-file-budget" for row in records))

    def test_cache_entry_dirs_from_shadow_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cache = root / "cache"
            cache.mkdir()
            tee = root / "tee_capture_1"
            tee.mkdir()
            payload = {"source_status": {"course_cache": {"entry_dir": str(cache)}}}
            (tee / "hazard_field_shadow_v0.json").write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(field._cache_entry_dirs([tee]), [cache])

    def test_watcher_command_uses_v32_and_active_capture_by_default(self):
        args = mock.Mock(
            monitor=1,
            poll_ms=350,
            posttee_min_settle_ms=850,
            capture_retry_ms=1100,
            max_capture_attempts=2,
            transition_stable_observations=2,
            log_hole_fresh_seconds=3,
            gspro_dir="C:/GSPro",
            dry_run=False,
            roi=None,
            tesseract=None,
            no_aim_debug=False,
        )
        command = field.watcher_command(args, Path("state.json"))
        self.assertTrue(any(str(item).endswith("round_watch_v32.py") for item in command))
        self.assertIn("--execute-actions", command)
        self.assertNotIn("src-tauri", " ".join(map(str, command)).lower())


if __name__ == "__main__":
    unittest.main()
