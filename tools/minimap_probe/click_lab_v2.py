#!/usr/bin/env python3
"""Hardened Click Lab runtime.

This wraps the original click_lab without changing its isolated safety contract.
It adds two protections learned from first live GSPro validation:

1. GSPro's magenta current-aim target must never be selected as the ball marker.
2. Post-click verification should use the magenta minimap target marker directly,
   not depend on the optional AIM-card OCR.

The original click_lab.py remains intact as the baseline experiment.
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

import click_lab as lab
import probe as base
import probe_v2 as v2


# OpenCV hue is 0..179. GSPro's current-aim crosshair is vivid magenta.
MAGENTA_H_MIN = 135
MAGENTA_H_MAX = 175
MAGENTA_S_MIN = 120
MAGENTA_V_MIN = 150

_registration: dict[str, object] = {}
_original_predict = lab.predict_minimap_pixel
_original_verify = lab.verify_after_click
_original_crop = lab.base.crop_minimap


def _magenta_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    return (
        (h >= MAGENTA_H_MIN)
        & (h <= MAGENTA_H_MAX)
        & (s >= MAGENTA_S_MIN)
        & (v >= MAGENTA_V_MIN)
    ).astype(np.uint8) * 255


def _magenta_pixels_near(roi: np.ndarray, x: float, y: float, radius: int = 18) -> int:
    mask = _magenta_mask(roi)
    h, w = mask.shape[:2]
    xi, yi = int(round(x)), int(round(y))
    x1, x2 = max(0, xi - radius), min(w, xi + radius + 1)
    y1, y2 = max(0, yi - radius), min(h, yi + radius + 1)
    return int(np.count_nonzero(mask[y1:y2, x1:x2]))


def detect_ball_marker_without_aim(roi: np.ndarray) -> base.Point:
    """Use v2 player-marker scoring while rejecting GSPro's magenta aim crosshair."""
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    height, width = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, _radius in v2._hough_circles(roi):
        if y < height * 0.11 or y > height * 0.98:
            continue
        _hue, sat, val = v2._center_hsv(hsv, x, y)
        if sat < 110 or val < 150:
            continue
        # Live validation showed that the large magenta aim target can otherwise
        # outscore the true player/ball marker. Reject its distinctive pixels.
        if _magenta_pixels_near(roi, x, y) >= 20:
            continue
        score = sat + 0.12 * val + 55.0 * (y / height) - 8.0 * abs(x - width / 2) / max(width / 2, 1)
        candidates.append((score, base.Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]

    fallback = base.detect_ball_marker(roi)
    if _magenta_pixels_near(roi, fallback.x, fallback.y) >= 20:
        raise RuntimeError(
            "Only a magenta GSPro aim marker matched the player-marker detector; refusing registration."
        )
    return fallback


def detect_magenta_aim_marker(roi: np.ndarray, expected: base.Point | None = None) -> base.Point:
    """Detect the center of GSPro's magenta current-aim crosshair."""
    mask = _magenta_mask(roi)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[float, base.Point]] = []

    for label in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[label]]
        if area < 40 or area > 3500:
            continue
        if w < 12 or h < 12 or w > 100 or h > 100:
            continue
        center = base.Point(x + (w - 1) / 2.0, y + (h - 1) / 2.0)
        if expected is None:
            score = -float(area)
        else:
            score = math.hypot(center.x - expected.x, center.y - expected.y)
        candidates.append((score, center))

    if not candidates:
        raise RuntimeError("Could not detect GSPro magenta aim marker after click.")

    candidates.sort(key=lambda item: item[0])
    chosen = candidates[0][1]
    if expected is not None:
        gap = math.hypot(chosen.x - expected.x, chosen.y - expected.y)
        if gap > 90:
            raise RuntimeError(
                f"Nearest magenta aim marker is {gap:.1f}px from predicted click; refusing ambiguous verification."
            )
    return chosen


def crop_minimap_recording(image: np.ndarray, override: str | None = None):
    roi, box = _original_crop(image, override)
    _registration["roi_box"] = box
    return roi, box


def predict_recording(ball, pin, distance_to_pin_yds, right_yds, forward_yds):
    predicted, scale = _original_predict(
        ball,
        pin,
        distance_to_pin_yds,
        right_yds,
        forward_yds,
    )
    _registration.update({
        "ball": ball,
        "pin": pin,
        "pin_distance": float(distance_to_pin_yds),
        "requested_right": float(right_yds),
        "requested_forward": float(forward_yds),
        "predicted": predicted,
        "scale": float(scale),
    })
    return predicted, scale


def _screen_to_roi(screen: np.ndarray) -> np.ndarray:
    box = _registration.get("roi_box")
    if box is None:
        raise RuntimeError("Pre-click minimap ROI was not recorded.")
    x, y, w, h = box
    return screen[y:y + h, x:x + w].copy()


def _annotate_marker_verification(
    screen: np.ndarray,
    ball: base.Point,
    pin: base.Point,
    aim: base.Point,
    observed_forward: float,
    observed_right: float,
    vector_error: float,
    debug_dir: Path,
) -> None:
    box = _registration["roi_box"]
    x, y, _w, _h = box
    annotated = screen.copy()

    def xy(point: base.Point):
        return int(round(x + point.x)), int(round(y + point.y))

    ball_xy, pin_xy, aim_xy = xy(ball), xy(pin), xy(aim)
    cv2.circle(annotated, ball_xy, 9, (255, 255, 255), 2)
    cv2.putText(annotated, "BALL", (ball_xy[0] + 10, ball_xy[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
    cv2.circle(annotated, pin_xy, 9, (255, 255, 255), 2)
    cv2.putText(annotated, "PIN", (pin_xy[0] + 10, pin_xy[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
    cv2.drawMarker(annotated, aim_xy, (255, 0, 255), cv2.MARKER_CROSS, 28, 3)
    cv2.putText(
        annotated,
        f"GSPro aim: {observed_forward:.1f} fwd, {observed_right:+.1f} right; err {vector_error:.1f} yd",
        (max(12, aim_xy[0] - 260), max(30, aim_xy[1] - 20)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 0, 255),
        2,
        cv2.LINE_AA,
    )
    cv2.imwrite(str(debug_dir / "latest_click_lab_marker_verify.png"), annotated)


def verify_after_click_by_marker(screen, tesseract_path, debug_dir, expected_distance_yds, tolerance_yds):
    """Primary verification: read GSPro's actual magenta minimap target in the live frame."""
    try:
        roi = _screen_to_roi(screen)
        predicted = _registration["predicted"]
        aim = detect_magenta_aim_marker(roi, predicted)

        # Re-detect ball/pin AFTER the click. This remains valid if GSPro changes
        # minimap scale/orientation during target selection.
        ball = detect_ball_marker_without_aim(roi)
        pin = v2.detect_pin_marker(roi)
        pin_distance = float(_registration["pin_distance"])

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
        observed_forward = (aim_dx * fwd_x + aim_dy * fwd_y) * scale
        observed_right = (aim_dx * right_x + aim_dy * right_y) * scale

        requested_forward = float(_registration["requested_forward"])
        requested_right = float(_registration["requested_right"])
        forward_error = observed_forward - requested_forward
        right_error = observed_right - requested_right
        vector_error = math.hypot(forward_error, right_error)
        observed_distance = math.hypot(observed_forward, observed_right)
        radial_error = observed_distance - expected_distance_yds
        status = "PASS_DISTANCE" if vector_error <= tolerance_yds else "FAIL_DISTANCE"

        debug_path = Path(debug_dir)
        _annotate_marker_verification(
            screen,
            ball,
            pin,
            aim,
            observed_forward,
            observed_right,
            vector_error,
            debug_path,
        )
        warnings = [
            f"Minimap marker verification: observed {observed_forward:.1f} yd forward, "
            f"{observed_right:+.1f} yd right; vector error {vector_error:.1f} yd."
        ]
        return observed_distance, radial_error, status, warnings
    except Exception as marker_exc:
        observed, error, status, warnings = _original_verify(
            screen,
            tesseract_path,
            debug_dir,
            expected_distance_yds,
            tolerance_yds,
        )
        return observed, error, status, [
            f"Direct minimap-marker verification unavailable: {marker_exc}",
            *warnings,
        ]


def capture_monitor_modern(index: int) -> lab.CaptureFrame:
    try:
        import mss
    except ImportError as exc:
        raise RuntimeError("Live capture requires mss. Install tools/minimap_probe/requirements.txt") from exc
    with mss.MSS() as sct:
        if index < 1 or index >= len(sct.monitors):
            raise ValueError(f"Monitor {index} unavailable. Valid physical indexes: 1..{len(sct.monitors)-1}")
        monitor = sct.monitors[index]
        raw = np.array(sct.grab(monitor))
        return lab.CaptureFrame(
            image=cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR),
            monitor_left=int(monitor["left"]),
            monitor_top=int(monitor["top"]),
            monitor_width=int(monitor["width"]),
            monitor_height=int(monitor["height"]),
        )


# Patch only the isolated lab's dependencies/runtime hooks.
v2.detect_ball_marker = detect_ball_marker_without_aim
lab.base.crop_minimap = crop_minimap_recording
lab.predict_minimap_pixel = predict_recording
lab.verify_after_click = verify_after_click_by_marker
lab.capture_monitor = capture_monitor_modern


if __name__ == "__main__":
    raise SystemExit(lab.main())
