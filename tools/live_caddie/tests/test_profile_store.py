import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.live_caddie import profile_store


class ProfileStoreTests(unittest.TestCase):
    def _write(self, directory: Path, name: str, payload) -> Path:
        path = directory / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_object_with_clubs_is_inspected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                Path(tmp),
                "profiles.json",
                {
                    "schema_version": "looper-live-caddie-player-profiles-v1",
                    "generated_at": "2026-09-07T18:00:00Z",
                    "shot_count": 199,
                    "clubs": [{"club": "Driver", "stock_carry_yds": 250}],
                    "owner": {"email": "player@example.com"},
                },
            )
            result = profile_store.inspect_profile_file(path, method="test")
            self.assertTrue(result.available)
            self.assertEqual(result.club_count, 1)
            self.assertEqual(result.shot_count, 199)
            self.assertEqual(result.owner_email, "player@example.com")

    def test_array_payload_remains_backward_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                Path(tmp),
                "profiles.json",
                [{"club": "7i", "stock_carry_yds": 160}],
            )
            result = profile_store.inspect_profile_file(path, method="test")
            self.assertEqual(result.club_count, 1)
            self.assertIsNone(result.schema_version)

    def test_explicit_path_beats_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            explicit = self._write(root, "explicit.json", [{"club": "7i", "stock_carry_yds": 160}])
            env = self._write(root, "env.json", [{"club": "8i", "stock_carry_yds": 150}])
            with patch.dict(os.environ, {profile_store.PROFILE_ENV: str(env)}):
                result = profile_store.resolve_profile_store(str(explicit))
            self.assertEqual(result.method, "explicit")
            self.assertEqual(Path(result.path or ""), explicit)

    def test_environment_beats_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._write(Path(tmp), "env.json", [{"club": "8i", "stock_carry_yds": 150}])
            with patch.dict(os.environ, {profile_store.PROFILE_ENV: str(env)}):
                result = profile_store.resolve_profile_store()
            self.assertEqual(result.method, "environment")
            self.assertEqual(Path(result.path or ""), env)

    def test_missing_default_is_safe_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / "user"
            with patch.dict(os.environ, {"USERPROFILE": str(fake_home), profile_store.PROFILE_ENV: ""}):
                result = profile_store.resolve_profile_store()
            self.assertFalse(result.available)
            self.assertEqual(result.method, "standard-gspro-folder")
            self.assertIn(profile_store.PROFILE_FILENAME, result.path or "")

    def test_invalid_payload_fails_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(Path(tmp), "bad.json", {"clubs": []})
            with self.assertRaises(ValueError):
                profile_store.inspect_profile_file(path, method="test")


if __name__ == "__main__":
    unittest.main()
