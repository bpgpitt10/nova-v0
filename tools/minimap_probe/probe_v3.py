#!/usr/bin/env python3
"""
GSPro Minimap Hazard Probe v3

This keeps the v2 hazard/zoom logic but upgrades player-marker detection.
The GSPro player marker is a screen-space filled circle, so its on-screen size
stays essentially constant while the course map zooms underneath it.

Detection priority:
1. circle radius very close to the observed GSPro marker radius (~7.6 px),
2. highly filled/saturated interior (rejects red penalty-line arcs/rings),
3. vivid color (hue-independent, so team color can change),
4. weak lower-map positional preference only as a tie-breaker.

Color is supporting evidence, not the primary identity signal.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

import probe as base
import probe_v2 as v2

EXPECTED_PLAYER_RADIUS_PX = 7.6
PLAYER_RADIUS_TOLERANCE_PX = 2.1


def _disk_mask(shape: tuple[int, int], x: float, y: float, radius: float) -> np.ndarray:
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.circle(mask, (int(round(x)), int(round(y))), max(1, int(round(radius))), 255, -1)
    return mask


def _candidate_stats(roi: np.ndarray, x: float, y: float, r: float) -> tuple[float, float, float, float]:
    """Return saturation fill fraction, mean saturation, mean value, mean hue."""
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    # Ignore the anti-aliased outer edge; the true player marker is filled inside.
    mask = _disk_mask(hsv.shape[:2], x, y, max(2.0, r * 0.68))
    pixels = hsv[mask > 0]
    if pixels.size == 0:
        return 0.0, 0.0, 0.0, 0.0

    sat = pixels[:, 1].astype(float)
    val = pixels[:, 2].astype(float)
    hue = pixels[:, 0].astype(float)
    filled = (sat >= 95) & (val >= 105)
    return float(filled.mean()), float(sat.mean()), float(val.mean()), float(hue.mean())


def detect_ball_marker_v3(roi: np.ndarray) -> base.Point:
    H, W = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, r in v2._hough_circles(roi):
        if y < H * 0.11 or y > H * 0.985:
            continue

        radius_error = abs(r - EXPECTED_PLAYER_RADIUS_PX)
        if radius_error > PLAYER_RADIUS_TOLERANCE_PX:
            continue

        fill_fraction, mean_sat, mean_val, mean_hue = _candidate_stats(roi, x, y, r)

        # A filled player dot should have a strongly colored interior. This rejects
        # thin penalty-line loops/arcs even if Hough sees them as circles.
        if fill_fraction < 0.52 or mean_sat < 85 or mean_val < 100:
            continue

        size_score = 180.0 - 70.0 * radius_error
        fill_score = 150.0 * fill_fraction
        vivid_score = 0.18 * mean_sat + 0.05 * mean_val

        # Purple/magenta is currently the user's team color and is especially
        # useful because it cannot be confused with GSPro red penalty boundaries.
        # Keep this only as a bonus so the detector still works with other colors.
        purple_bonus = 35.0 if 115.0 <= mean_hue <= 175.0 else 0.0

        # Position is deliberately weak: GSPro commonly places the player toward
        # the lower portion of the minimap, but we do not want this to override
        # the fixed-size filled-circle signature.
        position_score = 12.0 * (y / H) - 3.0 * abs(x - W / 2) / max(W / 2, 1)

        score = size_score + fill_score + vivid_score + purple_bonus + position_score
        candidates.append((score, base.Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]

    # Fall back to v2's broader hue-independent detector so a future GSPro theme
    # or display-scaling change fails gracefully rather than immediately breaking.
    return v2.detect_ball_marker(roi)


# v2's capture/retry path resolves this global at runtime, so replacing it here
# lets us reuse all of v2's hazard grouping, scale validation, W zoom-out recovery,
# debug rendering, and CLI behavior unchanged.
v2.detect_ball_marker = detect_ball_marker_v3


if __name__ == "__main__":
    raise SystemExit(v2.main())
