#!/usr/bin/env python3
"""Windows Click Lab runner with a safety patch for GSPro marker identity.

GSPro can leave a magenta current-aim marker on the minimap. The original generic
player-marker detector can mistake that marker for the actual ball position,
which corrupts scale/origin calibration. This runner patches only Click Lab so
magenta aim markers are rejected as ball candidates and registration diagnostics
are printed before any click is allowed.
"""

from __future__ import annotations

import cv2
import numpy as np

import click_lab
import probe as base
import probe_v2 as v2


def _hue_at(roi: np.ndarray, point: base.Point, radius: int = 3) -> tuple[float, float, float]:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    x = int(round(point.x))
    y = int(round(point.y))
    x1, x2 = max(0, x - radius), min(w, x + radius + 1)
    y1, y2 = max(0, y - radius), min(h, y + radius + 1)
    patch = hsv[y1:y2, x1:x2]
    if patch.size == 0:
        return 0.0, 0.0, 0.0
    return tuple(float(patch[:, :, i].mean()) for i in range(3))


def _is_magenta_aim_marker(hue: float, sat: float, val: float) -> bool:
    return 135.0 <= hue <= 170.0 and sat >= 90.0 and val >= 120.0


def _red_ball_from_mask(roi: np.ndarray) -> base.Point | None:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    low_red = cv2.inRange(hsv, np.array([0, 120, 100]), np.array([12, 255, 255]))
    high_red = cv2.inRange(hsv, np.array([170, 120, 100]), np.array([179, 255, 255]))
    mask = cv2.bitwise_or(low_red, high_red)
    mask[: int(h * 0.10), :] = 0
    mask[int(h * 0.98) :, :] = 0

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[float, base.Point]] = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if not (4 <= cw <= 24 and 4 <= ch <= 24 and 12 <= area <= 320):
            continue
        perimeter = cv2.arcLength(contour, True)
        circularity = (4.0 * np.pi * area / (perimeter * perimeter)) if perimeter > 0 else 0.0
        if circularity < 0.28:
            continue
        moments = cv2.moments(contour)
        if moments["m00"] == 0:
            continue
        cx = moments["m10"] / moments["m00"]
        cy = moments["m01"] / moments["m00"]
        score = circularity * 2.0 + 1.5 * (cy / max(h, 1)) - 0.25 * abs(cx - w / 2) / max(w / 2, 1)
        candidates.append((score, base.Point(float(cx), float(cy))))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def detect_actual_ball_marker(roi: np.ndarray) -> base.Point:
    # Prefer the older compact-player detector because its strong lower-map
    # prior correctly selects the real red ball on the current GSPro layout.
    try:
        candidate = base.detect_ball_marker(roi)
        hue, sat, val = _hue_at(roi, candidate)
        if not _is_magenta_aim_marker(hue, sat, val):
            print(
                f"Registration BALL: ({candidate.x:.1f}, {candidate.y:.1f}) "
                f"HSV=({hue:.0f},{sat:.0f},{val:.0f}) [generic]"
            )
            return candidate
        print(
            f"Rejected magenta aim marker as BALL: ({candidate.x:.1f}, {candidate.y:.1f}) "
            f"HSV=({hue:.0f},{sat:.0f},{val:.0f})"
        )
    except Exception:
        pass

    red = _red_ball_from_mask(roi)
    if red is not None:
        hue, sat, val = _hue_at(roi, red)
        print(
            f"Registration BALL: ({red.x:.1f}, {red.y:.1f}) "
            f"HSV=({hue:.0f},{sat:.0f},{val:.0f}) [red fallback]"
        )
        return red

    # Last chance: use Hough candidates but refuse magenta. This is deliberately
    # fail-closed; a wrong origin is more dangerous than declining to click.
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []
    for x, y, _radius in v2._hough_circles(roi):
        if y < h * 0.11 or y > h * 0.98:
            continue
        hue, sat, val = v2._center_hsv(hsv, x, y)
        if sat < 110 or val < 150 or _is_magenta_aim_marker(hue, sat, val):
            continue
        score = sat + 0.12 * val + 55.0 * (y / h) - 8.0 * abs(x - w / 2) / max(w / 2, 1)
        candidates.append((score, base.Point(float(x), float(y))))
    if candidates:
        point = max(candidates, key=lambda item: item[0])[1]
        hue, sat, val = _hue_at(roi, point)
        print(
            f"Registration BALL: ({point.x:.1f}, {point.y:.1f}) "
            f"HSV=({hue:.0f},{sat:.0f},{val:.0f}) [Hough fallback]"
        )
        return point

    raise RuntimeError(
        "Could not identify the actual GSPro ball marker without using the magenta aim marker; refusing to click."
    )


_original_predict = click_lab.predict_minimap_pixel


def _predict_with_diagnostics(ball, pin, distance_to_pin_yds, right_yds, forward_yds):
    print(f"Registration PIN:  ({pin.x:.1f}, {pin.y:.1f})")
    result = _original_predict(ball, pin, distance_to_pin_yds, right_yds, forward_yds)
    predicted, scale = result
    print(f"Registration SCALE: {scale:.4f} yd/px")
    return predicted, scale


v2.detect_ball_marker = detect_actual_ball_marker
click_lab.predict_minimap_pixel = _predict_with_diagnostics


if __name__ == "__main__":
    raise SystemExit(click_lab.main())
