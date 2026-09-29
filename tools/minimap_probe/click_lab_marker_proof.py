#!/usr/bin/env python3
"""Deterministic proof for Click Lab marker identity hardening.

This protects the live-sim regression found on 2026-09-29: GSPro's magenta
current-aim crosshair must not be selected as the actual ball/player marker.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

import click_lab_runner as runner
import probe as base


def main() -> int:
    roi = np.zeros((500, 300, 3), dtype=np.uint8)
    roi[:] = (45, 80, 45)

    # Actual player marker: compact filled red dot low on the minimap.
    actual_ball = base.Point(150.0, 445.0)
    cv2.circle(roi, (150, 445), 7, (0, 0, 255), -1)

    # GSPro current-aim target: vivid magenta ring/crosshair higher on the map.
    actual_aim = base.Point(92.0, 245.0)
    cv2.circle(roi, (92, 245), 15, (255, 0, 255), 3)
    cv2.line(roi, (72, 245), (112, 245), (255, 0, 255), 3)
    cv2.line(roi, (92, 225), (92, 265), (255, 0, 255), 3)

    ball = runner.detect_actual_ball_marker(roi)
    aim = runner.detect_magenta_aim_marker(roi, actual_aim)

    ball_error = math.hypot(ball.x - actual_ball.x, ball.y - actual_ball.y)
    aim_error = math.hypot(aim.x - actual_aim.x, aim.y - actual_aim.y)

    if ball_error > 4.0:
        raise AssertionError(
            f"BALL identity regression: expected near ({actual_ball.x},{actual_ball.y}), "
            f"got ({ball.x:.1f},{ball.y:.1f}), error={ball_error:.1f}px"
        )
    if aim_error > 4.0:
        raise AssertionError(
            f"AIM identity regression: expected near ({actual_aim.x},{actual_aim.y}), "
            f"got ({aim.x:.1f},{aim.y:.1f}), error={aim_error:.1f}px"
        )
    if math.hypot(ball.x - aim.x, ball.y - aim.y) < 80.0:
        raise AssertionError("BALL and AIM detectors collapsed onto the same marker.")

    print("Click Lab marker proof PASS")
    print(f"  BALL error: {ball_error:.1f}px")
    print(f"  AIM error:  {aim_error:.1f}px")
    print("  magenta aim excluded from ball identity: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
