from pathlib import Path
import sys
import tempfile
import time
import unittest

import hazard_field_run_safe as safe


class HazardFieldRunSafeTests(unittest.TestCase):
    def test_all_step11_finalize_stages_have_hard_timeouts(self):
        expected = {
            "course_archaeology_collector.py",
            "gkd_archaeology.py",
            "course_asset_archaeology.py",
            "course_hazard_cache.py",
            "hazard_compare_report.py",
        }
        self.assertEqual(set(safe.STAGE_TIMEOUTS_SECONDS), expected)
        self.assertTrue(all(0 < value <= 120 for value in safe.STAGE_TIMEOUTS_SECONDS.values()))

    def test_hung_subprocess_times_out_and_returns_fail_soft(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            started = time.monotonic()
            result = safe._bounded_run_process(
                [sys.executable, "-c", "import time; time.sleep(2)"],
                cwd=root,
                log_path=root / "hung.log",
                timeout_override_s=0.05,
            )
            elapsed = time.monotonic() - started
            self.assertEqual(result["status"], "timeout")
            self.assertIsNone(result["returncode"])
            self.assertLess(elapsed, 1.0)
            self.assertIn("TIMEOUT", (root / "hung.log").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
