import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import course_hazard_cache as cache


class CourseHazardCacheTests(unittest.TestCase):
    def _features(self, path: Path, x: float = 0.0) -> Path:
        payload = {
            "features": [{
                "feature_id": "penalty-1",
                "source": "test.gkd",
                "semantic_candidates": ["penalty_area"],
                "points_xyz": [
                    {"x": x, "y": 0, "z": 0},
                    {"x": x + 5, "y": 0, "z": 0},
                    {"x": x + 5, "y": 0, "z": 5},
                ],
                "polygon_candidate": True,
            }]
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_fingerprint_ignores_absolute_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._features(root / "one" / "features.json")
            b = self._features(root / "two" / "features.json")
            fa, _ = cache.analysis_fingerprint([a])
            fb, _ = cache.analysis_fingerprint([b])
            self.assertEqual(fa, fb)

    def test_changed_content_changes_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._features(root / "one" / "features.json", 0)
            b = self._features(root / "two" / "features.json", 7)
            fa, _ = cache.analysis_fingerprint([a])
            fb, _ = cache.analysis_fingerprint([b])
            self.assertNotEqual(fa, fb)

    def test_build_reuses_deterministic_entry_and_stays_shadow_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._features(root / "input" / "features.json")
            cache_root = root / "cache"
            first = cache.build_cache(
                course_key="Pebble_gsp", course_name="Pebble", analysis_inputs=[source], cache_root=cache_root
            )
            second = cache.build_cache(
                course_key="Pebble_gsp", course_name="Pebble", analysis_inputs=[source], cache_root=cache_root
            )
            self.assertEqual(first["cache_fingerprint"], second["cache_fingerprint"])
            self.assertEqual(first["entry_dir"], second["entry_dir"])
            self.assertEqual(first["bundle"]["object_count"], 1)
            self.assertFalse(first["bundle"]["strategy_authority"])
            self.assertEqual(second["status"], "reused")

    def test_latest_lookup_is_diagnostic_not_exact_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._features(root / "features.json")
            cache.build_cache(
                course_key="Pebble_gsp", course_name="Pebble", analysis_inputs=[source], cache_root=root / "cache"
            )
            hit = cache.lookup_cache(course_key="Pebble_gsp", course_name="Pebble", cache_root=root / "cache")
            self.assertEqual(hit["status"], "hit")
            self.assertEqual(hit["match_mode"], "course-key-latest-diagnostic")
            self.assertFalse(hit["exact_asset_match"])

    def test_exact_cache_fingerprint_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._features(root / "features.json")
            built = cache.build_cache(
                course_key="Pebble_gsp", course_name="Pebble", analysis_inputs=[source], cache_root=root / "cache"
            )
            hit = cache.lookup_cache(
                course_key="Pebble_gsp", course_name="Pebble", cache_root=root / "cache",
                cache_fingerprint_value=built["cache_fingerprint"],
            )
            self.assertEqual(hit["status"], "hit")
            self.assertEqual(hit["match_mode"], "exact-cache-fingerprint")
            self.assertTrue(hit["exact_analysis_match"])

    def test_raw_asset_fingerprint_can_prove_asset_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._features(root / "features.json")
            asset = root / "course.gkd"
            asset.write_bytes(b"course-version-a")
            built = cache.build_cache(
                course_key="Pebble_gsp", course_name="Pebble", analysis_inputs=[source], cache_root=root / "cache",
                fingerprint_inputs=[asset], asset_version="v1",
            )
            hit = cache.lookup_cache(
                course_key="Pebble_gsp", course_name="Pebble", cache_root=root / "cache",
                asset_fingerprint_value=built["asset_fingerprint"],
            )
            self.assertEqual(hit["status"], "hit")
            self.assertEqual(hit["match_mode"], "exact-asset-fingerprint")
            self.assertTrue(hit["exact_asset_match"])

    def test_wrong_course_is_miss(self):
        with tempfile.TemporaryDirectory() as tmp:
            hit = cache.lookup_cache(course_key="does-not-exist", cache_root=Path(tmp) / "cache")
            self.assertEqual(hit["status"], "miss")
            self.assertFalse(hit["strategy_authority"])


if __name__ == "__main__":
    unittest.main()
