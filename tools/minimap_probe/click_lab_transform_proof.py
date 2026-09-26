#!/usr/bin/env python3
"""Tiny deterministic proof for Click Lab handedness and scaling."""

from __future__ import annotations

import math

import click_lab
import probe as base


def close(a: float, b: float, tolerance: float = 1e-6) -> None:
    if abs(a - b) > tolerance:
        raise AssertionError(f"expected {b}, got {a}")


def main() -> int:
    # Pin straight above ball on screen: +RIGHT must map to screen-right.
    ball = base.Point(100.0, 200.0)
    pin = base.Point(100.0, 100.0)
    target, scale = click_lab.predict_minimap_pixel(ball, pin, 100.0, 10.0, 50.0)
    close(scale, 1.0)
    close(target.x, 110.0)
    close(target.y, 150.0)

    # LEFT must mirror cleanly.
    target, _ = click_lab.predict_minimap_pixel(ball, pin, 100.0, -10.0, 50.0)
    close(target.x, 90.0)
    close(target.y, 150.0)

    # Rotated minimap: forward is screen-right, so player-right is screen-down.
    pin_rotated = base.Point(200.0, 200.0)
    target, _ = click_lab.predict_minimap_pixel(ball, pin_rotated, 100.0, 10.0, 50.0)
    close(target.x, 150.0)
    close(target.y, 210.0)

    # Scale test: 200 yd represented by 100 px => 2 yd/px.
    pin_scaled = base.Point(100.0, 100.0)
    target, scale = click_lab.predict_minimap_pixel(ball, pin_scaled, 200.0, 20.0, 100.0)
    close(scale, 2.0)
    close(target.x, 110.0)
    close(target.y, 150.0)

    expected = math.hypot(20.0, 100.0)
    if expected <= 100.0:
        raise AssertionError("sanity check failed")

    print("Click Lab transform proof PASS")
    print("  center/left/right handedness: PASS")
    print("  rotated minimap handedness:   PASS")
    print("  zoom/scale conversion:        PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
