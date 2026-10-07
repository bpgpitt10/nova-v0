"""No-simulator safety tests for the parked native one-click actuator."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_direct_click as actuator


WINDOW = {
    "status": "connected",
    "hwnd": 124445,
    "pid": 9001,
    "minimized": False,
    "bounds": {"left": -1920, "top": -120, "width": 1920, "height": 1080},
}


def plan(**overrides):
    arguments = {
        "window": WINDOW,
        "minimap_roi": (1460, 550, 380, 450),
        "target_roi_px": (186.5, 200.0),
        "snapshot_age_ms": 100,
        "pin_registration_error_px": 0.73,
        "shot_key": "greywolf:8:2",
        "ui_confirmed": True,
    }
    arguments.update(overrides)
    return actuator.prepare_verified_minimap_click(**arguments)


class ActuatorSafetyTests(unittest.TestCase):
    def test_negative_desktop_and_dpi_independent_window_mapping(self):
        preflight = plan()
        self.assertEqual(preflight.desktop_x, -274)
        self.assertEqual(preflight.desktop_y, 630)
        self.assertEqual(preflight.bounds, (-1920, -120, 1920, 1080))
        self.assertEqual(preflight.verified_pin_error_px, 0.73)

    def test_never_click_without_user_arm(self):
        with self.assertRaisesRegex(ValueError, "armed"):
            plan(ui_confirmed=False)

    def test_old_snapshot_or_bad_registration_refused(self):
        with self.assertRaisesRegex(ValueError, "stale"):
            plan(snapshot_age_ms=1001)
        with self.assertRaisesRegex(ValueError, "registration"):
            plan(pin_registration_error_px=3.01)

    def test_off_map_and_window_mismatch_refused(self):
        with self.assertRaisesRegex(ValueError, "safe minimap"):
            plan(target_roi_px=(1, 200))
        with self.assertRaisesRegex(ValueError, "minimap ROI"):
            plan(minimap_roi=(1800, 600, 400, 400))
        with self.assertRaisesRegex(ValueError, "minimized"):
            plan(window={**WINDOW, "minimized": True})

    def test_native_click_disabled_even_with_valid_plan(self):
        safe = plan()
        with self.assertRaisesRegex(PermissionError, "disabled"):
            actuator.execute_prepared_click(safe, latest_window=lambda: WINDOW)

    def test_required_shot_identity(self):
        with self.assertRaisesRegex(ValueError, "shot"):
            plan(shot_key=" ")


if __name__ == "__main__":
    unittest.main()
