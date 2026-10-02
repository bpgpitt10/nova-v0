#!/usr/bin/env python3
"""
GSPro Minimap Hazard Probe v3

This keeps the v2 hazard/zoom logic but upgrades player-marker detection.
The GSPro player marker is a screen-space filled circle, so its on-screen size
stays essentially constant while the course map zooms underneath it.

Detection priority:
1. compact vivid connected component matching the observed filled marker;
2. Hough circle radius very close to the observed GSPro marker radius (~7.6 px);
3. highly filled/saturated interior (rejects red penalty-line arcs/rings);
4. lower-map positional preference as a tie-breaker.

The direct connected-component path is important for red team colors: on some
courses the solid red player dot has weak grayscale contrast and Hough misses it,
while the saturated component signature remains very strong.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

import probe as base
import probe_v2 as v2

EXPECTED_PLAYER_RADIUS_PX = 7.6
PLAYER_RADIUS_TOLERANCE_PX = 2.1

# Preserve the broad v2 fallback BEFORE monkey-patching v2.detect_ball_marker.
_original_detect_ball_marker = v2.detect_ball_marker


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


def _compact_vivid_candidates(roi: np.ndarray) -> list[tuple[float, base.Point]]:
    """Find the solid team-color player dot without relying on grayscale Hough.

    Penalty boundaries may share the same red hue, but they are long/thin connected
    components. The player marker is a compact, highly filled ~15 px blob. Heatmap
    regions are much larger. This gives us a robust first-pass signature even when
    the team color itself is red.
    """
    H, W = roi.shape[:2]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]

    mask = ((sat >= 165) & (val >= 115)).astype(np.uint8) * 255
    # Tiny anti-alias gaps should not split the filled marker, but do not dilate
    # enough to merge nearby red penalty-line geometry.
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[float, base.Point]] = []

    for label in range(1, count):
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])
        area = int(stats[label, cv2.CC_STAT_AREA])

        if y < H * 0.10 or y > H * 0.985:
            continue
        if not (9 <= w <= 22 and 9 <= h <= 22 and 70 <= area <= 340):
            continue

        aspect = w / max(float(h), 1.0)
        fill = area / max(float(w * h), 1.0)
        if not (0.58 <= aspect <= 1.45 and fill >= 0.48):
            continue

        component = (labels == label).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        contour_area = cv2.contourArea(contour)
        perimeter = cv2.arcLength(contour, True)
        circularity = (4.0 * math.pi * contour_area / (perimeter * perimeter)) if perimeter > 0 else 0.0
        if circularity < 0.42:
            continue

        pixels = hsv[labels == label]
        mean_sat = float(pixels[:, 1].mean()) if pixels.size else 0.0
        mean_val = float(pixels[:, 2].mean()) if pixels.size else 0.0
        cx, cy = map(float, centroids[label])

        # The player is normally behind the selected target, so lower-map position
        # is meaningful but not allowed to overwhelm the compact/fill signature.
        size_equiv_radius = 0.25 * (w + h)
        size_error = abs(size_equiv_radius - EXPECTED_PLAYER_RADIUS_PX)
        score = (
            170.0 * fill
            + 95.0 * circularity
            + 0.30 * mean_sat
            + 0.06 * mean_val
            + 42.0 * (cy / H)
            - 22.0 * size_error
            - 2.0 * abs(cx - W / 2) / max(W / 2, 1)
        )
        candidates.append((score, base.Point(cx, cy)))

    return candidates


def detect_ball_marker_v3(roi: np.ndarray) -> base.Point:
    # Primary path: directly identify the compact saturated player component.
    direct = _compact_vivid_candidates(roi)
    if direct:
        return max(direct, key=lambda item: item[0])[1]

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

        # Team color is not semantically fixed; hue is deliberately not required.
        position_score = 22.0 * (y / H) - 3.0 * abs(x - W / 2) / max(W / 2, 1)

        score = size_score + fill_score + vivid_score + position_score
        candidates.append((score, base.Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]

    # Fall back to v2's original broad hue-independent detector. Keep the preserved
    # reference so this does not recurse after the monkey-patch below.
    return _original_detect_ball_marker(roi)


# v2's capture/retry path resolves this global at runtime, so replacing it here
# lets us reuse all of v2's hazard grouping, scale validation, W zoom-out recovery,
# debug rendering, and CLI behavior unchanged.
v2.detect_ball_marker = detect_ball_marker_v3


if __name__ == "__main__":
    raise SystemExit(v2.main())
