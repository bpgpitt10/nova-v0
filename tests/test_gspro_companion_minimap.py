"""Stage C offline math/CV regression and fail-closed native aim preflight.

No GSPro, camera, screenshot upload or mouse input is used by these tests.
"""
from pathlib import Path
import math
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import auto_aim_transform as xform
import gspro_direct_click as click
import gspro_minimap_markers as markers
import gspro_minimap_pipeline as pipeline
from waypoint_scale import Point, WaypointObservation, resolve_minimap_scale


WINDOW = {
    "status": "connected",
    "pid": 9001,
    "hwnd": 124445,
    "minimized": False,
    "bounds": {"left": -1920, "top": -60, "width": 1920, "height": 1080},
}


class HistoricalTransformTests(unittest.TestCase):
    def test_greywolf_h8_h13_proven_pixel_targets(self):
        cases = [
            (
                [[0.353548471, -0.157713020, 210.251806],
                 [0.157713020, 0.353548471, 68.2961123]],
                xform.Point(277.6226784, 852.1339198),
                xform.Point(275.9562842, 851.1857923),
                xform.Point(281.0500183, 174.3500061),
                0.5756693119,
                xform.Point(183.9537, 525.7971),
            ),
            (
                [[0.291182836, -0.187250734, 230.715324],
                 [0.187250734, 0.291182836, 71.2393193]],
                xform.Point(279.1972387, 852.6272189),
                xform.Point(278.2912088, 852.5274725),
                xform.Point(279.9500122, 173.25),
                0.4788347688,
                xform.Point(86.2310, 438.9844),
            ),
        ]
        for matrix, ball, tee, pin, ypp, expected in cases:
            with self.subTest(expected=expected):
                ball_can = xform.current_to_canonical(matrix, ball)
                target_can = xform.canonical_offset_target(
                    current_ball_canonical=ball_can,
                    canonical_tee=tee, canonical_pin=pin,
                    canonical_yards_per_pixel=ypp,
                    forward_yds=75, right_yds=10,
                )
                target_cur = xform.canonical_to_current(matrix, target_can)
                self.assertLess(abs(target_cur.x - expected.x), 0.02)
                self.assertLess(abs(target_cur.y - expected.y), 0.02)
                self.assertLess(
                    xform.canonical_error_yards(xform.current_to_canonical(matrix, target_cur), target_can, ypp), 1e-6,
                )

    def test_par4_does_not_fall_back_to_routed_hole_length(self):
        ball = Point(0, 300)
        pin = Point(0, 20)
        with self.assertRaisesRegex(RuntimeError, "non-par-3"):
            resolve_minimap_scale(ball=ball, pin=pin, pin_distance_yds=410, par=4)
        result = resolve_minimap_scale(
            ball=ball, pin=pin, pin_distance_yds=410, par=4,
            waypoints=[WaypointObservation(yards=150, pixel=Point(0, 0))],
        )
        self.assertEqual(result.source, "gray-waypoint")
        self.assertAlmostEqual(result.yards_per_pixel, 0.5, places=5)

    def test_course_anchor_mismatch_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "refusing ambiguous"):
            xform.course_point_to_canonical_pixel(
                tee_course=xform.Point(0, 0), pin_course=xform.Point(0, 500),
                target_course=xform.Point(10, 300),
                canonical_tee=xform.Point(140, 375),
                canonical_pin=xform.Point(140, 100),
                canonical_yards_per_pixel=0.5,
            )


class NativePreviewTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        roi, box = pipeline.crop_minimap(self.frame)
        self.assertEqual(box, (1628, 561, 282, 475))
        self.calibration = pipeline.TeeCalibration(
            hole_key="greywolf:8",
            window_fingerprint=(9001, 124445, -1920, -60, 1920, 1080),
            roi_normalized=pipeline.RIGHT_MINIMAP_ROI,
            canonical_pin=xform.Point(143, 100),
            canonical_ball=xform.Point(141, 375),
            yards_per_pixel=0.575811,
            scale_source="gray-waypoint",
            canonical_bgr=roi,
        )
        self.pin = xform.Point(143, 100)
        self.ball = xform.Point(141, 375)
        self.reg = SimpleNamespace(matrix_2x3=[[1., 0., 0.], [0., 1., 0.]])

    def preview(self, **overrides):
        kwargs = {
            "window": WINDOW, "hole_key": "greywolf:8", "shot_key": "greywolf:8:2",
            "explicitly_armed": True, "captured_at_monotonic": 5.0,
            "now_monotonic": 5.1, "forward_yds": 75.0, "right_yds": 10.0,
        }
        kwargs.update(overrides)
        with mock.patch.object(markers, "detect_actual_ball_marker", return_value=self.ball), \
             mock.patch.object(markers, "detect_pin_marker", return_value=self.pin), \
             mock.patch.object(pipeline.registration, "register_current_to_canonical_verified", return_value=(self.reg, 0.73)):
            return pipeline.preview_aim(self.calibration, self.frame, **kwargs)

    def test_valid_preview_is_still_not_permission_to_click(self):
        result = self.preview()
        self.assertEqual(result.mode, "current-offset")
        self.assertFalse(result.mouse_input_allowed)
        self.assertEqual(result.click_plan.pid, WINDOW["pid"])
        self.assertLess(result.current_pin_error_px, 3.0)
        self.assertTrue(-1920 <= result.click_plan.desktop_x < 0)
        with self.assertRaisesRegex(PermissionError, "disabled"):
            click.execute_prepared_click(result.click_plan, latest_window=lambda: WINDOW)

    def test_hole_window_and_shot_identity_are_bound(self):
        with self.assertRaisesRegex(ValueError, "hole changed"):
            self.preview(hole_key="greywolf:9")
        with self.assertRaisesRegex(ValueError, "window or hole changed"):
            self.preview(window={**WINDOW, "bounds": {**WINDOW["bounds"], "left": -1919}})
        with self.assertRaisesRegex(ValueError, "shot identity"):
            self.preview(shot_key=" ")

    def test_stale_frame_unarmed_and_ambiguous_mode_rejected(self):
        with self.assertRaisesRegex(ValueError, "stale"):
            self.preview(now_monotonic=6.1)
        with self.assertRaisesRegex(ValueError, "explicitly arm"):
            self.preview(explicitly_armed=False)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.preview(forward_yds=None, right_yds=None)

    def test_course_frame_must_be_verified_before_accepting_browser_xy(self):
        with self.assertRaisesRegex(ValueError, "Unverified GSPro-to-Looper"):
            self.preview(
                forward_yds=None, right_yds=None,
                tee_course=xform.Point(0, 0),
                pin_course=xform.Point(0, 400),
                target_course=xform.Point(10, 200),
                course_frame_id="unverified-local-hole-xy",
            )

    def test_pin_registration_over_tolerance_refused(self):
        with mock.patch.object(markers, "detect_actual_ball_marker", return_value=self.ball), \
             mock.patch.object(markers, "detect_pin_marker", return_value=self.pin), \
             mock.patch.object(pipeline.registration, "register_current_to_canonical_verified", return_value=(self.reg, 3.01)):
            with self.assertRaisesRegex(ValueError, "registration"):
                pipeline.preview_aim(
                    self.calibration, self.frame, window=WINDOW,
                    hole_key="greywolf:8", shot_key="greywolf:8:2",
                    explicitly_armed=True, captured_at_monotonic=5,
                    now_monotonic=5.1, forward_yds=75, right_yds=10,
                )

    def test_marker_verification_is_yard_space_not_pin_ruler(self):
        result = self.preview()
        with mock.patch.object(markers, "detect_magenta_aim_marker", return_value=result.target_current):
            verified = pipeline.verify_accepted_marker(
                result, self.frame, window=WINDOW,
                hole_key="greywolf:8", shot_key="greywolf:8:2",
            )
        self.assertTrue(verified.accepted)
        self.assertAlmostEqual(verified.error_yds, 0.0)
        far = xform.Point(result.target_current.x + 10, result.target_current.y)
        with mock.patch.object(markers, "detect_magenta_aim_marker", return_value=far):
            missed = pipeline.verify_accepted_marker(
                result, self.frame, window=WINDOW,
                hole_key="greywolf:8", shot_key="greywolf:8:2",
            )
        self.assertFalse(missed.accepted)
        self.assertGreater(missed.error_yds, 3)

    def test_calibration_requires_authoritative_scale(self):
        with mock.patch.object(markers, "detect_actual_ball_marker", return_value=self.ball), \
             mock.patch.object(markers, "detect_pin_marker", return_value=self.pin):
            with self.assertRaisesRegex(RuntimeError, "non-par-3"):
                pipeline.calibrate_tee(
                    self.frame, window=WINDOW, hole_key="greywolf:8",
                    par=4, pin_distance_yds=400,
                )
            good = pipeline.calibrate_tee(
                self.frame, window=WINDOW, hole_key="greywolf:8",
                par=4, pin_distance_yds=400,
                waypoint_observations=(WaypointObservation(
                    yards=150, pixel=Point(141, 75),
                ),),
            )
        self.assertEqual(good.scale_source, "gray-waypoint")
        self.assertAlmostEqual(good.yards_per_pixel, 0.5)

    def test_native_capture_unavailable_fails_closed(self):
        with mock.patch.object(pipeline.capture, "probe_gspro_capture", return_value={
            "status": "unsupported", "reason": "blank_or_low_detail_frame",
        }):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                pipeline.capture_native_bgr(WINDOW)


class MarkerDetectionTests(unittest.TestCase):
    def test_accepted_magenta_marker_detected_without_sharing_frame(self):
        roi = np.zeros((450, 280, 3), dtype=np.uint8)
        cv2.circle(roi, (155, 250), 11, (255, 0, 255), -1)
        actual = markers.detect_magenta_aim_marker(roi, xform.Point(155, 250))
        self.assertLess(math.hypot(actual.x - 155, actual.y - 250), 2)


if __name__ == "__main__":
    unittest.main()
