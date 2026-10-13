"""Portable, fully synthetic Stage B GSPro discovery + capture-quality tests.

Physical GSPro window and GPU capture still require simulator testing.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_native_discovery as discovery
import gspro_window_capture as capture


class DataFolderDiscoveryTests(unittest.TestCase):
    def test_finds_real_locallow_folder_and_reports_only_file_presence(self):
        with TemporaryDirectory() as root:
            base = Path(root)
            local = base / "AppData" / "Local"
            target = base / "AppData" / "LocalLow" / "GSPro" / "GSPro"
            target.mkdir(parents=True)
            for filename in ("currentRound.dat", "output_log.txt", "GSPro.db"):
                (target / filename).write_text("mock", encoding="utf-8")
            result = discovery.discover_gspro_data_directory(
                local_app_data=str(local),
                home=base,
                image_path=str(base / "Games" / "GSPro.exe"),
            )
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["source"], "user-locallow")
            self.assertTrue(all(result["files"].values()))
            public = discovery.public_data_folder_status(result)
            self.assertNotIn("directory", public)
            self.assertNotIn(str(base), str(public))

    def test_prefers_user_data_files_over_install_folder(self):
        with TemporaryDirectory() as root:
            base = Path(root)
            game = base / "Games"
            user = base / "AppData" / "LocalLow" / "GSPro" / "GSPro"
            game.mkdir()
            user.mkdir(parents=True)
            (game / "GSPro.db").write_bytes(b"db")
            (user / "currentRound.dat").write_bytes(b"round")
            (user / "output_log.txt").write_bytes(b"log")
            selected = discovery.discover_gspro_data_directory(
                local_app_data=str(base / "AppData" / "Local"),
                home=base,
                image_path=str(game / "GSPro.exe"),
            )
            self.assertEqual(selected["source"], "user-locallow")
            self.assertEqual(selected["status"], "ready")

    def test_partial_data_is_not_called_ready(self):
        with TemporaryDirectory() as root:
            base = Path(root)
            data = base / "AppData" / "LocalLow" / "GSPro" / "GSPro"
            data.mkdir(parents=True)
            (data / "currentRound.dat").write_bytes(b"round")
            result = discovery.discover_gspro_data_directory(
                home=base,
                local_app_data=str(base / "AppData" / "Local"),
            )
            self.assertEqual(result["status"], "partial")
            self.assertFalse(result["files"]["output_log.txt"])

    def test_install_directory_without_telemetry_is_not_a_success(self):
        with TemporaryDirectory() as root:
            base = Path(root)
            game = base / "Games"
            game.mkdir()
            (game / "GSPro.exe").write_bytes(b"dummy")
            result = discovery.discover_gspro_data_directory(
                local_app_data=str(base / "AppData" / "Local"),
                home=base,
                image_path=str(game / "GSPro.exe"),
            )
            self.assertEqual(result["status"], "not-found")
            self.assertIsNone(result["directory"])


class DpiSafetyTests(unittest.TestCase):
    def test_explicit_dpi_failure_is_fail_closed(self):
        import gspro_direct_click as click
        window = {
            "status": "connected", "hwnd": 12, "pid": 9,
            "minimized": False, "dpiAwareness": "unverified",
            "bounds": {"left": 0, "top": 0, "width": 1280, "height": 720},
        }
        with self.assertRaisesRegex(ValueError, "DPI"):
            click.prepare_verified_minimap_click(
                window=window, minimap_roi=(900, 330, 220, 330),
                target_roi_px=(100, 150), snapshot_age_ms=100,
                pin_registration_error_px=0.5, shot_key="hole:1:shot:1",
                ui_confirmed=True,
            )


class CaptureDiagnosticsTests(unittest.TestCase):
    def test_rejects_blank_frame_even_when_printwindow_reports_success(self):
        width, height = 128, 72
        result = capture.assess_bgra_frame(bytes(width * height * 4), width, height)
        self.assertFalse(result["nonblank"])
        self.assertEqual(result["darkFraction"], 1.0)

    def test_accepts_multicolor_frame(self):
        width, height = 128, 72
        frame = bytearray(width * height * 4)
        for y in range(height):
            for x in range(width):
                offset = 4 * (y * width + x)
                frame[offset:offset + 4] = bytes([
                    (x * 7) % 256,
                    (y * 17) % 256,
                    ((x + y) * 5) % 256,
                    255,
                ])
        result = capture.assess_bgra_frame(bytes(frame), width, height)
        self.assertTrue(result["nonblank"])
        self.assertGreater(result["brightnessRange"], 20)

    def test_no_gspro_and_minimized_fail_closed_without_capture(self):
        no_window = capture.probe_gspro_capture({"status": "waiting"})
        self.assertEqual(no_window["status"], "not-connected")
        minimized = capture.probe_gspro_capture({
            "status": "connected",
            "minimized": True,
            "bounds": {"width": 1280, "height": 720},
        })
        self.assertEqual(minimized["reason"], "window_minimized")


if __name__ == "__main__":
    unittest.main()
