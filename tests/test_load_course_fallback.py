"""The loader packages a map area when OpenStreetMap can't supply the holes."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "course_model"))
import load_course as lc  # noqa: E402


class FallbackTests(unittest.TestCase):
    def test_holes_not_numbered_once(self):
        self.assertTrue(lc.holes_not_mapped(["fetch_osm_course_snapshot_core.py failed: OpenStreetMap doesn't have "
                                             "exactly one route per hole 1-18 inside the course boundary"]))

    def test_no_usable_holes(self):
        # Dunes West, 20 Nov: the outline is mapped, the holes aren't.
        self.assertTrue(lc.holes_not_mapped(["build_osm_course_package_canonical.py failed: Static geometry failed "
                                             "runtime contract; ready holes: []"]))
        self.assertTrue(lc.holes_not_mapped(["Static geometry incomplete; ready holes: [1, 2, 3]"]))

    def test_other_failures_still_fail(self):
        self.assertFalse(lc.holes_not_mapped(["urllib.error.HTTPError: HTTP Error 504: Gateway Time-out"]))
        self.assertFalse(lc.holes_not_mapped([]))
        self.assertFalse(lc.holes_not_mapped(None))


if __name__ == "__main__":
    unittest.main()
