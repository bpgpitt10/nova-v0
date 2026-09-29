#!/usr/bin/env python3
"""Hardened Windows Click Lab runner.

Live GSPro validation exposed two failure modes in the original lab:
- the magenta current-aim marker can be mistaken for the actual ball marker;
- AIM-card OCR is not a reliable post-click verification source in every UI state.

This runner patches only the isolated Click Lab so it:
1) refuses magenta aim markers as ball candidates;
2) prints registration diagnostics before any click;
3) verifies the accepted GSPro target directly from the magenta minimap marker;
4) falls back to legacy AIM-card OCR only when direct marker verification is unavailable.
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

import click_lab
import probe as base
import probe_v2 as v2

MAGENTA_H_MIN = 135
MAGENTA_H_MAX = 175
MAGENTA_S_MIN = 120
MAGENTA_V_MIN = 150

_registration: dict[str, object] = {}
_original_predict = click_lab.predict_minimap_pixel
_original_verify = click_lab.verify_after_click
_original_crop = click_lab.base.crop_minimap


def _magenta_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    return (
        (h >= MAGENTA_H_MIN)
        & (h <= MAGENTA_H_MAX)
        & (s >= MAGENTA_S_MIN)
        & (v >= MAGENTA_V_MIN)
    ).astype(np.uint8) * 255


def _magenta_pixels_near(roi: np.ndarray, point: base.Point, radius: int = 18) -> int:
    mask = _magenta_mask(roi)
    h, w = mask.shape[:2]
    x = int(round(point.x))
    y = int(round(point.y))
    x1, x2 = max(0, x - radius), min(w, x + radius + 1)
    y1, y2 = max(0, y - radius), min(h, y + radius + 1)
    return int(np.count_nonzero(mask[y1:y2, x1:x2]))


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


def _is_magenta_aim_marker(roi: np.ndarray, point: base.Point) -> bool:
    hue, sat, val = _hue_at(roi, point)
    if 135.0 <= hue <= 170.0 and sat >= 90.0 and val >= 120.0:
        return True
    # The crosshair has a hollow/transparent center, so center HSV alone can miss
    # it. The surrounding vivid-magenta pixel count is a stronger identity check.
    return _magenta_pixels_near(roi, point) >= 20


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
        point = base.Point(float(cx), float(cy))
        if _is_magenta_aim_marker(roi, point):
            continue
        score = circularity * 2.0 + 1.5 * (cy / max(h, 1)) - 0.25 * abs(cx - w / 2) / max(w / 2, 1)
        candidates.append((score, point))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def detect_actual_ball_marker(roi: np.ndarray) -> base.Point:
    # Prefer the compact generic player detector because it has a useful lower-map
    # prior, but explicitly reject the GSPro magenta aim target.
    try:
        candidate = base.detect_ball_marker(roi)
        if not _is_magenta_aim_marker(roi, candidate):
            hue, sat, val = _hue_at(roi, candidate)
            print(
                f"Registration BALL: ({candidate.x:.1f}, {candidate.y:.1f}) "
                f"HSV=({hue:.0f},{sat:.0f},{val:.0f}) [generic]"
            )
            return candidate
        print(f"Rejected magenta aim marker as BALL: ({candidate.x:.1f}, {candidate.y:.1f})")
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

    # Last chance: Hough candidates, still fail-closed on magenta.
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []
    for x, y, _radius in v2._hough_circles(roi):
        if y < h * 0.11 or y > h * 0.98:
            continue
        _hue, sat, val = v2._center_hsv(hsv, x, y)
        point = base.Point(float(x), float(y))
        if sat < 110 or val < 150 or _is_magenta_aim_marker(roi, point):
            continue
        score = sat + 0.12 * val + 55.0 * (y / h) - 8.0 * abs(x - w / 2) / max(w / 2, 1)
        candidates.append((score, point))
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


def detect_magenta_aim_marker(roi: np.ndarray, expected: base.Point | None = None) -> base.Point:
    mask = _magenta_mask(roi)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[float, base.Point]] = []

    for label in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[label]]
        if area < 40 or area > 3500 or w < 12 or h < 12 or w > 100 or h > 100:
            continue
        center = base.Point(x + (w - 1) / 2.0, y + (h - 1) / 2.0)
        score = 0.0 if expected is None else math.hypot(center.x - expected.x, center.y - expected.y)
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


def _crop_recording(image: np.ndarray, override: str | None = None):
    roi, box = _original_crop(image, override)
    _registration["roi_box"] = box
    return roi, box


def _predict_with_diagnostics(ball, pin, distance_to_pin_yds, right_yds, forward_yds):
    print(f"Registration PIN:   ({pin.x:.1f}, {pin.y:.1f})")
    predicted, scale = _original_predict(ball, pin, distance_to_pin_yds, right_yds, forward_yds)
    print(f"Registration SCALE: {scale:.4f} yd/px")
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


def _after_roi(screen: np.ndarray) -> np.ndarray:
    box = _registration.get("roi_box")
    if box is None:
        raise RuntimeError("Pre-click minimap ROI was not recorded.")
    x, y, w, h = box
    return screen[y:y + h, x:x + w].copy()


def _save_marker_verification(
    screen: np.ndarray,
    ball: base.Point,
    pin: base.Point,
    aim: base.Point,
    observed_forward: float,
    observed_right: float,
    vector_error: float,
    debug_dir: Path,
) -> None:
    x, y, _w, _h = _registration["roi_box"]
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
        f"GSPro aim {observed_forward:.1f} fwd {observed_right:+.1f} right; err {vector_error:.1f} yd",
        (max(12, aim_xy[0] - 250), max(30, aim_xy[1] - 20)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 0, 255),
        2,
        cv2.LINE_AA,
    )
    cv2.imwrite(str(debug_dir / "latest_click_lab_marker_verify.png"), annotated)


def _verify_after_click(screen, tesseract_path, debug_dir, expected_distance_yds, tolerance_yds):
    try:
        roi = _after_roi(screen)
        predicted = _registration["predicted"]
        aim = detect_magenta_aim_marker(roi, predicted)
        ball = detect_actual_ball_marker(roi)
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

        _save_marker_verification(
            screen,
            ball,
            pin,
            aim,
            observed_forward,
            observed_right,
            vector_error,
            Path(debug_dir),
        )
        return observed_distance, radial_error, status, [
            f"Minimap marker verification: observed {observed_forward:.1f} yd forward, "
            f"{observed_right:+.1f} yd right; vector error {vector_error:.1f} yd."
        ]
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


def _capture_monitor_modern(index: int) -> click_lab.CaptureFrame:
    try:
        import mss
    except ImportError as exc:
        raise RuntimeError("Live capture requires mss. Install tools/minimap_probe/requirements.txt") from exc
    with mss.MSS() as sct:
        if index < 1 or index >= len(sct.monitors):
            raise ValueError(f"Monitor {index} unavailable. Valid physical indexes: 1..{len(sct.monitors)-1}")
        monitor = sct.monitors[index]
        raw = np.array(sct.grab(monitor))
        return click_lab.CaptureFrame(
            image=cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR),
            monitor_left=int(monitor["left"]),
            monitor_top=int(monitor["top"]),
            monitor_width=int(monitor["width"]),
            monitor_height=int(monitor["height"]),
        )


# Patch only Click Lab's isolated runtime.
v2.detect_ball_marker = detect_actual_ball_marker
click_lab.base.crop_minimap = _crop_recording
click_lab.predict_minimap_pixel = _predict_with_diagnostics
click_lab.verify_after_click = _verify_after_click
click_lab.capture_monitor = _capture_monitor_modern


if __name__ == "__main__":
    raise SystemExit(click_lab.main())
