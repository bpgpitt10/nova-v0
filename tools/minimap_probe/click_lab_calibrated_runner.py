#!/usr/bin/env python3
"""Live-calibrated GSPro Click Lab runner.

Physical Greywolf H1 testing on 2026-09-29 established two important facts:
- left/right handedness and lateral placement were correct;
- the ball->pin linear minimap model was short downrange by about 3.75% near a
  200 yd target (a 200 yd request produced 192-193 yd on GSPro's AIM card,
  while a 207.5 yd map-forward request produced 200 yd).

This wrapper keeps the validated lateral transform, applies the measured
longitudinal calibration explicitly, and makes post-click PASS require two
independent signals:
1) the magenta minimap marker for lateral placement; and
2) GSPro AIM-card OCR for actual radial distance.

A minimap marker transformed with the same ball/pin scale that generated the
click is diagnostic evidence only; it may not independently certify distance.
"""

from __future__ import annotations

import math
from pathlib import Path

import click_lab
import click_lab_ready_runner
import click_lab_runner

# Empirical physical calibration from the live 2026-09-29 Greywolf H1 test:
# desired 200 yd forward required 207.5 yd in the linear ball->pin map model.
# Keep this named and visible rather than hiding the correction in map scale math.
FORWARD_MAP_CALIBRATION = 207.5 / 200.0


def _predict_calibrated(ball, pin, distance_to_pin_yds, right_yds, forward_yds):
    print(f"Registration PIN:   ({pin.x:.1f}, {pin.y:.1f})")
    calibrated_forward = float(forward_yds) * FORWARD_MAP_CALIBRATION
    predicted, scale = click_lab_runner._original_predict(
        ball,
        pin,
        distance_to_pin_yds,
        right_yds,
        calibrated_forward,
    )
    print(f"Registration SCALE: {scale:.4f} yd/px")
    print(
        "Forward calibration: "
        f"{FORWARD_MAP_CALIBRATION:.5f}x "
        f"({float(forward_yds):.1f} desired -> {calibrated_forward:.1f} map yd)"
    )
    click_lab_runner._registration.update({
        "ball": ball,
        "pin": pin,
        "pin_distance": float(distance_to_pin_yds),
        "requested_right": float(right_yds),
        "requested_forward": float(forward_yds),
        "calibrated_forward": calibrated_forward,
        "predicted": predicted,
        "scale": float(scale),
    })
    return predicted, scale


def _verify_calibrated(screen, tesseract_path, debug_dir, expected_distance_yds, tolerance_yds):
    """Verify with independent radial AIM OCR + minimap lateral marker evidence."""
    warnings: list[str] = []
    try:
        roi = click_lab_runner._after_roi(screen)
        predicted = click_lab_runner._registration["predicted"]
        aim = click_lab_runner.detect_magenta_aim_marker(roi, predicted)
        ball = click_lab_runner.detect_actual_ball_marker(roi)
        pin = click_lab_runner.v2.detect_pin_marker(roi)
        pin_distance = float(click_lab_runner._registration["pin_distance"])

        dx = pin.x - ball.x
        dy = pin.y - ball.y
        pixels_to_pin = math.hypot(dx, dy)
        if pixels_to_pin < 20:
            raise RuntimeError(f"Post-click ball/pin separation only {pixels_to_pin:.1f}px.")
        scale = pin_distance / pixels_to_pin
        if not (0.03 <= scale <= 3.0):
            raise RuntimeError(f"Post-click minimap scale {scale:.4f} yd/px is implausible.")

        fwd_x, fwd_y = dx / pixels_to_pin, dy / pixels_to_pin
        right_x, right_y = -fwd_y, fwd_x
        aim_dx = aim.x - ball.x
        aim_dy = aim.y - ball.y
        marker_forward = (aim_dx * fwd_x + aim_dy * fwd_y) * scale
        marker_right = (aim_dx * right_x + aim_dy * right_y) * scale
    except Exception as marker_exc:
        return None, None, "UNVERIFIED", [
            f"Direct minimap-marker verification unavailable: {marker_exc}",
            "No PASS is possible without the post-click magenta marker.",
        ]

    # Always ask the legacy AIM-card reader for an independent radial distance.
    # Unlike the old runner, do not let same-scale minimap geometry substitute for
    # this measurement and call itself a GSPro AIM distance.
    aim_distance, aim_error, aim_status, aim_warnings = click_lab_runner._original_verify(
        screen,
        tesseract_path,
        debug_dir,
        expected_distance_yds,
        tolerance_yds,
    )
    warnings.extend(aim_warnings)
    if aim_distance is None:
        click_lab_runner._save_marker_verification(
            screen,
            ball,
            pin,
            aim,
            marker_forward,
            marker_right,
            float("nan"),
            Path(debug_dir),
        )
        return None, None, "UNVERIFIED", [
            *warnings,
            f"Minimap marker diagnostic: {marker_forward:.1f} map-yd forward, {marker_right:+.1f} yd right.",
            "GSPro AIM-card radial distance was not independently readable; refusing PASS.",
        ]

    observed_radius = float(aim_distance)
    if abs(marker_right) > observed_radius + max(1.0, tolerance_yds):
        return observed_radius, aim_error, "UNVERIFIED", [
            *warnings,
            f"Marker lateral component {marker_right:+.1f} yd exceeds AIM-card radius {observed_radius:.1f} yd.",
            "The two verification signals are geometrically inconsistent; refusing PASS.",
        ]

    # Live testing validated lateral scale/handedness, while the forward scale was
    # the observed distortion. Preserve marker-right and use the independent AIM
    # radius to reconstruct physical forward distance.
    observed_forward_magnitude = math.sqrt(max(0.0, observed_radius ** 2 - marker_right ** 2))
    observed_forward = math.copysign(observed_forward_magnitude, marker_forward)
    observed_right = marker_right

    requested_forward = float(click_lab_runner._registration["requested_forward"])
    requested_right = float(click_lab_runner._registration["requested_right"])
    forward_error = observed_forward - requested_forward
    right_error = observed_right - requested_right
    vector_error = math.hypot(forward_error, right_error)
    status = "PASS_DISTANCE" if vector_error <= tolerance_yds else "FAIL_DISTANCE"

    click_lab_runner._save_marker_verification(
        screen,
        ball,
        pin,
        aim,
        observed_forward,
        observed_right,
        vector_error,
        Path(debug_dir),
    )
    return observed_radius, observed_radius - expected_distance_yds, status, [
        *warnings,
        f"Independent AIM-card radial distance: {observed_radius:.1f} yd ({aim_status}).",
        f"Minimap lateral verification: {observed_right:+.1f} yd right.",
        f"Hybrid 2D verification: {observed_forward:.1f} yd forward, {observed_right:+.1f} yd right; vector error {vector_error:.1f} yd.",
    ]


# Override the hardened runner only at the two seams exposed by live validation.
click_lab.predict_minimap_pixel = _predict_calibrated
click_lab.verify_after_click = _verify_calibrated


if __name__ == "__main__":
    raise SystemExit(click_lab_ready_runner._run_ready())
