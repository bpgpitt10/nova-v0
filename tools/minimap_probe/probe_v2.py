#!/usr/bin/env python3
"""Marker-detection upgrade for the standalone GSPro minimap probe.

This keeps the existing POC geometry code intact, but replaces the fragile
connected-component marker detectors with circle-based detectors. The reason:
the player marker can touch a red penalty boundary and the pin can touch white
map labels, which makes either marker merge into a much larger contour.
"""

from __future__ import annotations

import cv2
import numpy as np

import probe as base


def _hough_circles(roi: np.ndarray) -> list[tuple[float, float, float]]:
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=12,
        param1=80,
        param2=18,
        minRadius=5,
        maxRadius=14,
    )
    if circles is None:
        return []
    return [(float(x), float(y), float(r)) for x, y, r in circles[0]]


def _center_hsv(hsv: np.ndarray, x: float, y: float, radius: int = 3) -> tuple[float, float, float]:
    h, w = hsv.shape[:2]
    xi, yi = int(round(x)), int(round(y))
    x1, x2 = max(0, xi - radius), min(w, xi + radius + 1)
    y1, y2 = max(0, yi - radius), min(h, yi + radius + 1)
    patch = hsv[y1:y2, x1:x2]
    if patch.size == 0:
        return 0.0, 0.0, 0.0
    return (
        float(patch[:, :, 0].mean()),
        float(patch[:, :, 1].mean()),
        float(patch[:, :, 2].mean()),
    )


def detect_ball_marker_v2(roi: np.ndarray) -> base.Point:
    """Find the bright, saturated circular player marker regardless of hue.

    This deliberately does not assume red: the marker may follow GSPro team
    color. Circle detection also lets us find a red player marker even when it
    physically touches a red penalty-area boundary.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, _r in _hough_circles(roi):
        if y < H * 0.11 or y > H * 0.97:
            continue
        _h, sat, val = _center_hsv(hsv, x, y)
        # Player/team markers are vivid. Reject dark hazard lines and white pin/UI.
        if sat < 110 or val < 150:
            continue
        # GSPro usually keeps the player toward the lower part of the minimap.
        # Brightness prevents dark red boundary curves from winning this heuristic.
        score = sat + 0.12 * val + 55.0 * (y / H) - 8.0 * abs(x - W / 2) / max(W / 2, 1)
        candidates.append((score, base.Point(x, y)))

    if not candidates:
        # Keep the original detector as a fallback for layouts where the marker
        # is tiny enough that Hough does not see it.
        return base._original_detect_ball_marker(roi)  # type: ignore[attr-defined]

    return max(candidates, key=lambda item: item[0])[1]


def detect_pin_marker_v2(roi: np.ndarray) -> base.Point:
    """Find the bright white circular pin marker even when it touches label text."""
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, _r in _hough_circles(roi):
        if y < H * 0.11 or y > H * 0.92:
            continue
        _h, sat, val = _center_hsv(hsv, x, y)
        if val < 220 or sat > 65:
            continue
        # Pure white circles outrank gray distance markers and map ornamentation.
        whiteness = val - sat
        score = whiteness + 18.0 * (1.0 - y / H) - 5.0 * abs(x - W / 2) / max(W / 2, 1)
        candidates.append((score, base.Point(x, y)))

    if not candidates:
        return base._original_detect_pin_marker(roi)  # type: ignore[attr-defined]

    return max(candidates, key=lambda item: item[0])[1]


# Preserve original functions for fallback before monkey-patching the module globals
# used by base.analyze_image().
base._original_detect_ball_marker = base.detect_ball_marker  # type: ignore[attr-defined]
base._original_detect_pin_marker = base.detect_pin_marker  # type: ignore[attr-defined]
base.detect_ball_marker = detect_ball_marker_v2
base.detect_pin_marker = detect_pin_marker_v2

if __name__ == "__main__":
    raise SystemExit(base.main())
