#!/usr/bin/env python3
"""Deterministic proof for carrying calibrated tee pixels through GSPro zoom.

Measurements come from preserved Greywolf screenshots in the September OCR corpus.
The live CV solve itself is exercised separately; this proof locks the acceptance
math and the fail-closed pin cross-check discovered during corpus review.
"""

from __future__ import annotations

from dataclasses import replace
import math

from minimap_registration import (
    RegistrationResult,
    transform_point,
    verify_registration_pin,
)


def make_result(matrix, *, scale, rotation_deg, good, inliers, ratio, error):
    return RegistrationResult(
        matrix_2x3=matrix,
        keypoints_current=0,
        keypoints_canonical=0,
        good_matches=good,
        inliers=inliers,
        inlier_ratio=ratio,
        scale=scale,
        rotation_deg=rotation_deg,
        median_reprojection_error_px=error,
        confidence=0.0,
    )


def remaining_yards(registration, current_ball, canonical_pin, canonical_ypp):
    mapped_ball = transform_point(registration.matrix_2x3, *current_ball)
    return math.hypot(
        mapped_ball[0] - canonical_pin[0],
        mapped_ball[1] - canonical_pin[1],
    ) * canonical_ypp


def main() -> int:
    # Greywolf H8, shot 2. Current minimap is heavily zoomed and rotated relative
    # to tee: ~0.387x scale and +24 deg. GSPro showed 150.6 yd to pin.
    h8 = make_result(
        [[0.35354847110825, -0.15771301998840914, 210.2518062785354],
         [0.15771301998840914, 0.35354847110825, 68.29611233066437]],
        scale=0.38713036318124855,
        rotation_deg=24.04098076925208,
        good=45,
        inliers=39,
        ratio=39 / 45,
        error=0.43155908584594727,
    )
    h8_pin_error = verify_registration_pin(
        h8,
        current_pin_xy=(278.8500061, 174.3500061),
        canonical_pin_xy=(281.05001831, 174.3500061),
    )
    h8_remaining = remaining_yards(
        h8,
        (277.85576923, 851.91826923),
        (281.05001831, 174.3500061),
        0.5756693118789694,
    )
    assert h8_pin_error < 1.0
    assert abs(h8_remaining - 150.6) < 0.5

    # Greywolf H13, shot 2. Even stronger zoom/rotation: ~0.346x and +32.7 deg.
    # GSPro showed 112.5 yd to pin.
    h13 = make_result(
        [[0.2911828362512372, -0.18725073406583947, 230.71532371725417],
         [0.18725073406583947, 0.2911828362512372, 71.23931930603067]],
        scale=0.34619399407775775,
        rotation_deg=32.743825394348136,
        good=14,
        inliers=11,
        ratio=11 / 14,
        error=0.3237755298614502,
    )
    h13_pin_error = verify_registration_pin(
        h13,
        current_pin_xy=(278.8500061, 175.44999695),
        canonical_pin_xy=(279.95001221, 173.25),
    )
    h13_remaining = remaining_yards(
        h13,
        (279.12560386, 852.39130435),
        (279.95001221, 173.25),
        0.478834768813698,
    )
    assert h13_pin_error < 2.0
    assert abs(h13_remaining - 112.5) < 0.75

    # Two visually plausible wrong registrations from the blind corpus search are
    # rejected decisively by the independent pin marker.
    bad_h4 = make_result(
        [[0.9779503030872929, -0.019207289969013983, -59.40119631645186],
         [0.019207289969013983, 0.9779503030872929, -358.98796249101855]],
        scale=0.9781389038866013,
        rotation_deg=1.1251647217997334,
        good=28,
        inliers=13,
        ratio=13 / 28,
        error=0.3089806139469147,
    )
    try:
        verify_registration_pin(
            bad_h4,
            current_pin_xy=(279.95001221, 394.3500061),
            canonical_pin_xy=(285.45001221, 176.55000305),
        )
    except RuntimeError:
        pass
    else:
        raise AssertionError("Wrong registration should fail pin verification")

    print(
        f"H8 PASS: pin {h8_pin_error:.2f}px, remaining {h8_remaining:.2f} yd; "
        f"H13 PASS: pin {h13_pin_error:.2f}px, remaining {h13_remaining:.2f} yd"
    )
    print("MINIMAP ZOOM REGISTRATION PROOF PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
