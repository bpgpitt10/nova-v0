import unittest

from tools.live_caddie.aim_geometry import (
    AimContext2D,
    calibration_from_contexts,
    cross_track_delta_yds,
    verify_requested_offset,
)


class AimGeometryTests(unittest.TestCase):
    def test_rightward_delta_on_straight_baseline_is_positive(self):
        baseline = AimContext2D(180.0, 0.0)
        shifted = AimContext2D(180.0, 6.0)
        self.assertAlmostEqual(cross_track_delta_yds(baseline, shifted), 6.0, places=6)

    def test_cross_track_works_for_rotated_baseline(self):
        baseline = AimContext2D(100.0, 100.0)
        # Unit right of a 45-degree baseline is (-sqrt(.5), +sqrt(.5)).
        shifted = AimContext2D(100.0 - 7.0710678, 100.0 + 7.0710678)
        self.assertAlmostEqual(cross_track_delta_yds(baseline, shifted), 10.0, places=4)

    def test_calibration_uses_observed_cross_track_per_ms(self):
        calibration = calibration_from_contexts(
            baseline=AimContext2D(200.0, 0.0),
            sampled=AimContext2D(200.0, -4.5),
            pulse_ms=45.0,
            confidence=0.9,
        )
        self.assertAlmostEqual(calibration.observed_cross_track_yds, -4.5)
        self.assertAlmostEqual(calibration.yards_per_ms, 0.1)
        self.assertAlmostEqual(calibration.confidence, 0.9)

    def test_verification_reports_signed_residual(self):
        result = verify_requested_offset(
            baseline=AimContext2D(180.0, 0.0),
            achieved=AimContext2D(180.0, 6.7),
            requested_offset_yds=6.0,
            tolerance_yds=1.0,
        )
        self.assertTrue(result.verified)
        self.assertAlmostEqual(result.residual_yds, 0.7)


if __name__ == "__main__":
    unittest.main()
