#!/usr/bin/env python3
"""Deterministic proof for the live-measured longitudinal Click Lab calibration."""

from __future__ import annotations

import click_lab_calibrated_runner as calibrated
import probe as base


def close(actual: float, expected: float, tolerance: float = 1e-6) -> None:
    if abs(actual - expected) > tolerance:
        raise AssertionError(f"expected {expected}, got {actual}")


def main() -> int:
    # 350 yd represented by 700 px => exactly 0.5 yd/px.
    ball = base.Point(100.0, 800.0)
    pin = base.Point(100.0, 100.0)

    target, scale = calibrated._predict_calibrated(
        ball,
        pin,
        350.0,
        10.4,
        200.0,
    )
    close(scale, 0.5)
    # Lateral stays unscaled: 10.4 / 0.5 = 20.8 px right.
    close(target.x, 120.8)
    # Forward uses 207.5 map yd: 207.5 / 0.5 = 415 px upward.
    close(target.y, 385.0)

    mirrored, _ = calibrated._predict_calibrated(
        ball,
        pin,
        350.0,
        -10.4,
        200.0,
    )
    close(mirrored.x, 79.2)
    close(mirrored.y, 385.0)

    close(calibrated.FORWARD_MAP_CALIBRATION, 1.0375)

    print("Click Lab live calibration proof PASS")
    print("  forward factor 1.0375: PASS")
    print("  lateral magnitude unchanged: PASS")
    print("  left/right mirror preserved: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
