"""Read-only integration tests for the previously proven gray waypoint ruler.

All images are synthetic; OCR outputs and registration transforms are mocked.
The historical 18-hole corpus / physical GSPro proof remains separate evidence.
"""
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

import numpy as np
import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_companion_minimap_calibration as integrated
import gspro_live_observations as observations
import waypoint_scale_cv
from waypoint_scale import Point

WIN = {
    "status": "connected", "pid": 9001, "hwnd": 123,
    "minimized": False, "dpiAwareness": "per-monitor",
    "bounds": {"left": -1920, "top": 0, "width": 1920, "height": 1080},
}
FRAME = np.zeros((1080, 1920, 3), np.uint8)
ROI = (0.848, 0.520, 0.995, 0.960)
CROP = np.zeros((475, 282, 3), np.uint8)
BALL = Point(140.0, 425.0)
PIN = Point(140.0, 50.0)


def state(kind="pre_shot", hole=8, shot_no=1, age=2000):
    return {
        "fileAgeMs": age,
        "shot": {
            "status": "ready" if kind == "pre_shot" else "completed_record_only",
            "kind": kind, "shotNumber": shot_no, "holeNumber": hole,
            "roundId": 251, "courseKey": "GreyWolf_gsp",
        },
        "layout": {"status": "unavailable", "reason": "course_layout_not_found"},
    }


def gray(yards=150.0, y=125.0, votes=8):
    return types.SimpleNamespace(pixel=Point(140.0, y), yards=yards,
                                 confidence=votes / 8, ocr_votes=votes)


class WaypointIntegrationTests(unittest.TestCase):
    def test_near_white_farmlinks_ovals_rank_ahead_of_text(self):
        # FarmLinks field screenshot (2026-10-12): neutral-white ovals next
        # to visible 445 and 253 yardages; old HSV saturation floor 18
        # incorrectly rejected markers whose actual saturation was ~7-9.
        image = np.full((900, 400, 3), (34, 100, 47), dtype=np.uint8)
        for x, y, text in ((205, 210, "445"), (160, 510, "253")):
            cv2.circle(image, (x, y), 8, (236, 243, 247), -1)
            cv2.putText(image, text, (x + 5, y + 31),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                        (245, 247, 248), 2, cv2.LINE_AA)
        # The pin is fully white, not a gray waypoint.
        cv2.circle(image, (206, 150), 8, (255, 255, 255), -1)
        found = waypoint_scale_cv._candidate_markers(image)
        self.assertGreaterEqual(len(found), 2)
        self.assertLess(np.hypot(found[0].x - 205, found[0].y - 210), 3)
        self.assertLess(np.hypot(found[1].x - 160, found[1].y - 510), 3)
        self.assertTrue(all(np.hypot(point.x - 206, point.y - 150) > 15 for point in found[:2]))

    def test_waypoint_timing_details_are_not_overwritten(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[]):
            result = self.observe(state("last_completed"))
        self.assertIn("waypointOcr", result["timingMs"])
        self.assertIsNotNone(result["timingMs"]["waypointOcr"])
        self.assertIn("ovalCandidateCount", result["waypointRuler"])

    def setUp(self):
        integrated._tee_cache = None
        self.engine = mock.patch.object(
            integrated.wind_ocr, "_tesseract_bundle",
            return_value=(Path("C:/Looper/ocr/tesseract.exe"), None),
        )
        self.engine.start()
        self.addCleanup(self.engine.stop)

    def observe(self, s=None):
        return integrated.observe(
            CROP, BALL, PIN, window=WIN, frame_bgr=FRAME,
            roi=ROI, state=s if s is not None else state(),
        )

    def test_dogleg_ruler_works_without_python_course_layout(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[gray()]) as ocr:
            result = self.observe(state("last_completed"))
        self.assertEqual(result["scale"]["status"], "provisional_gray_waypoint")
        self.assertEqual(result["scale"]["source"], "gray-waypoint")
        self.assertAlmostEqual(result["scale"]["yardsPerPixel"], 0.5)
        self.assertEqual(result["waypointRuler"]["candidates"][0]["yards"], 150)
        self.assertEqual(result["registration"]["status"], "unavailable")
        self.assertIsNone(integrated._tee_cache)
        self.assertEqual(ocr.call_args.kwargs["max_candidates"], 4)
        self.assertEqual(ocr.call_args.kwargs["time_budget_s"], 17)

    def test_pre_shot_tee_caches_private_frame_then_registered_zoom_candidate(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[gray()]):
            first = self.observe()
        self.assertEqual(first["registration"]["status"], "tee_anchor_candidate_cached")
        self.assertIsNotNone(integrated._tee_cache)
        self.assertEqual(integrated._tee_cache["calibration"].canonical_bgr.shape, CROP.shape)
        reg = types.SimpleNamespace(matrix_2x3=[[0.35355, -0.15771, 210.25], [0.15771, 0.35355, 68.30]],
                                    scale=0.387, rotation_deg=24.0, inliers=34,
                                    inlier_ratio=0.72, median_reprojection_error_px=0.63,
                                    confidence=0.86)
        with mock.patch.object(integrated.registration, "register_current_to_canonical_verified",
                               return_value=(reg, 0.73)) as solved, \
             mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints") as no_new_ocr:
            later = self.observe(state("last_completed", shot_no=1))
        solved.assert_called_once()
        no_new_ocr.assert_not_called()
        self.assertEqual(later["registration"]["status"], "registered_candidate_unverified")
        self.assertEqual(later["registration"]["pinErrorPixels"], 0.73)
        self.assertEqual(later["registration"]["canonicalTeePixel"], {"x": 140, "y": 425})
        self.assertEqual(later["registration"]["currentToCanonicalMatrix"], reg.matrix_2x3)
        self.assertAlmostEqual(later["scale"]["yardsPerPixel"], 0.1935)
        self.assertEqual(later["scale"]["status"], "provisional_registered_tee")
        self.assertNotIn("canonical_bgr", str(later))
        self.assertNotIn("_private_bgra", str(later))

    def test_old_completed_shot_never_seeds_new_tee(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[gray()]):
            result = self.observe(state("last_completed"))
        self.assertEqual(result["registration"]["reason"], "no_fresh_tee_preshot_evidence")
        self.assertIsNone(integrated._tee_cache)

    def test_hole_identity_change_rejects_previous_cache(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[gray()]):
            self.observe()
            other = self.observe(state("last_completed", hole=9, shot_no=1))
        self.assertEqual(other["registration"]["status"], "unavailable")
        self.assertIsNone(integrated._tee_cache)

    def test_no_false_authority_on_inconsistent_waypoint_rulers(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints",
                               return_value=[gray(150, 125), gray(210, 125)]):
            result = self.observe()
        self.assertEqual(result["scale"]["status"], "unavailable")
        self.assertEqual(result["waypointRuler"]["status"], "detected_unverified")
        self.assertIsNone(integrated._tee_cache)

    def test_bad_pin_registration_rejects_zoom_without_recalibrating(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[gray()]):
            self.observe()
        with mock.patch.object(integrated.registration, "register_current_to_canonical_verified",
                               side_effect=RuntimeError("pin cross-check missed")):
            result = self.observe(state("last_completed", shot_no=1))
        self.assertEqual(result["registration"]["status"], "unavailable")
        self.assertIn("registration_rejected", result["registration"]["reason"])
        self.assertEqual(result["scale"]["status"], "unavailable")

    def test_par3_direct_tee_ruler_caches_without_gray_waypoint(self):
        # 300 world meters x-axis => 328.084 yd; 375 pin px => 0.87489.
        s = state()
        s["shot"]["startingWorld"] = {"x": 0, "y": 0, "z": 0}
        s["layout"] = {
            "status": "ready", "par": 3, "holeNumber": 8,
            "teeWorld": {"x": 0, "y": 0, "z": 0},
            "pinWorld": {"x": 0, "y": 0, "z": 300},
        }
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints") as gray_ocr:
            first = self.observe(s)
        gray_ocr.assert_not_called()
        self.assertEqual(first["scale"]["status"], "provisional_par3")
        self.assertEqual(first["scale"]["source"], "ball-pin-par3")
        self.assertAlmostEqual(first["scale"]["yardsPerPixel"], 300 * 1.0936132983377078 / 375, places=5)
        self.assertEqual(first["registration"]["status"], "tee_anchor_candidate_cached")
        self.assertEqual(integrated._tee_cache["calibration"].scale_source, "ball-pin-par3")

    def test_par3_rejects_stale_or_mismatched_tee_layout(self):
        s = state()
        s["shot"]["startingWorld"] = {"x": 100, "y": 0, "z": 0}
        s["layout"] = {
            "status": "ready", "par": 3, "holeNumber": 8,
            "teeWorld": {"x": 0, "y": 0, "z": 0},
            "pinWorld": {"x": 0, "y": 0, "z": 300},
        }
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints", return_value=[]):
            result = self.observe(s)
        self.assertEqual(result["scale"]["status"], "unavailable")
        self.assertIsNone(integrated._tee_cache)

    def test_weak_single_label_vote_cannot_seed_a_tee(self):
        with mock.patch.object(integrated.waypoint_cv, "detect_gray_waypoints",
                               return_value=[gray(votes=1)]):
            result = self.observe()
        self.assertEqual(result["waypointRuler"]["status"], "detected_unverified")
        self.assertEqual(result["scale"]["reason"], "low_waypoint_ocr_confidence")
        self.assertIsNone(integrated._tee_cache)

    def test_no_tesseract_leaves_ruler_unavailable(self):
        with mock.patch.object(integrated.wind_ocr, "_tesseract_bundle", return_value=None):
            result = self.observe()
        self.assertEqual(result["scale"]["status"], "unavailable")
        self.assertEqual(result["waypointRuler"]["reason"], "bundled_tesseract_unavailable")

    def test_observation_reports_waypoint_before_missing_layout_gate(self):
        raw = np.zeros((1080, 1920, 4), dtype=np.uint8)
        raw[:, :, 3] = 255
        report = {"status": "captured", "windowWidth": 1920, "windowHeight": 1080,
                  "method": "PrintWindow", "quality": {"nonblank": True},
                  "_private_bgra": raw.tobytes()}
        candidate = {"waypointRuler": {"status": "scale_candidate", "candidates": []},
                     "registration": {"status": "unavailable", "reason": "no_anchor"},
                     "scale": {"status": "provisional_gray_waypoint", "yardsPerPixel": 0.5,
                               "source": "gray-waypoint"}}
        with mock.patch.object(observations.markers, "detect_actual_ball_marker", return_value=BALL), \
             mock.patch.object(observations.markers, "detect_pin_marker", return_value=PIN), \
             mock.patch.object(observations.waypoint_diagnostics, "observe", return_value=candidate):
            result = observations._image_observation(
                WIN, state("last_completed"), report=report,
            )
        self.assertEqual(result["status"], "markers_found")
        self.assertEqual(result["scale"]["source"], "gray-waypoint")
        self.assertEqual(result["scale"]["yardsPerPixel"], 0.5)
        self.assertEqual(result["waypointRuler"]["status"], "scale_candidate")


if __name__ == "__main__":
    unittest.main()
