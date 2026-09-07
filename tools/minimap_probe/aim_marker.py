from __future__ import annotations
from dataclasses import dataclass, asdict
import json
import math
from pathlib import Path

import cv2
import numpy as np


@dataclass
class AimMarkerResult:
    x: float
    y: float
    radius_px: float
    inferred_distance_yds: float
    card_distance_yds: float
    distance_error_yds: float
    center_saturation: float
    center_value: float

    def to_dict(self) -> dict:
        return asdict(self)


def _default_config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["screen_detection"]["aim_marker"]


def _center_hsv(hsv: np.ndarray, x: float, y: float, radius: int) -> tuple[float, float, float]:
    height, width = hsv.shape[:2]
    xi, yi = int(round(x)), int(round(y))
    x1, x2 = max(0, xi - radius), min(width, xi + radius + 1)
    y1, y2 = max(0, yi - radius), min(height, yi + radius + 1)
    patch = hsv[y1:y2, x1:x2]
    if patch.size == 0:
        return 0.0, 0.0, 0.0
    return (
        float(patch[:, :, 0].mean()),
        float(patch[:, :, 1].mean()),
        float(patch[:, :, 2].mean()),
    )


def detect_aim_marker(
    roi: np.ndarray,
    *,
    ball_xy: tuple[float, float],
    aim_distance_yds: float,
    pin_xy: tuple[float, float] | None = None,
    pin_distance_yds: float | None = None,
    yards_per_pixel: float | None = None,
    detector_config: dict | None = None,
) -> AimMarkerResult:
    """Locate GSPro's gray selected-AIM dot using the AIM card distance as a checksum.

    Preferred post-tee calibration is ``yards_per_pixel`` derived from minimap
    registration.  That keeps AIM localization working even when GSPro has cropped
    the white minimap pin completely out of view.  The older visible-pin distance
    calibration remains available as a fallback.
    """
    config = detector_config or _default_config()

    if yards_per_pixel is not None:
        scale = float(yards_per_pixel)
        if scale <= 0:
            raise ValueError("yards_per_pixel must be positive")
    else:
        if pin_xy is None or pin_distance_yds is None:
            raise RuntimeError("AIM marker needs either yards_per_pixel or visible pin calibration")
        ball_pin_px = math.dist(ball_xy, pin_xy)
        if ball_pin_px < 10:
            raise RuntimeError("ball/pin separation too small to calibrate AIM marker distance")
        scale = float(pin_distance_yds) / ball_pin_px

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=float(config["hough_dp"]),
        minDist=float(config["hough_min_distance_px"]),
        param1=float(config["hough_param1"]),
        param2=float(config["hough_param2"]),
        minRadius=int(config["min_radius_px"]),
        maxRadius=int(config["max_radius_px"]),
    )
    if circles is None:
        raise RuntimeError("no circular AIM marker candidates found")

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    candidates: list[AimMarkerResult] = []
    exclusion = float(config["marker_exclusion_radius_px"])
    tolerance = float(config["distance_tolerance_yds"])
    patch_radius = int(config["center_patch_radius_px"])

    for raw_x, raw_y, raw_radius in circles[0]:
        x, y, radius = float(raw_x), float(raw_y), float(raw_radius)
        if math.dist((x, y), ball_xy) < exclusion:
            continue
        if pin_xy is not None and math.dist((x, y), pin_xy) < exclusion:
            continue
        _hue, saturation, value = _center_hsv(hsv, x, y, patch_radius)
        if saturation > float(config["max_saturation"]):
            continue
        if value < float(config["min_value"]) or value > float(config["max_value"]):
            continue

        inferred = math.dist((x, y), ball_xy) * scale
        error = abs(inferred - float(aim_distance_yds))
        if error > tolerance:
            continue
        candidates.append(AimMarkerResult(
            x=x,
            y=y,
            radius_px=radius,
            inferred_distance_yds=inferred,
            card_distance_yds=float(aim_distance_yds),
            distance_error_yds=error,
            center_saturation=saturation,
            center_value=value,
        ))

    if not candidates:
        raise RuntimeError(
            f"no gray AIM marker matched the {aim_distance_yds:.1f} yd AIM-card distance "
            f"within {tolerance:.1f} yd"
        )

    return min(candidates, key=lambda candidate: (candidate.distance_error_yds, candidate.center_saturation))
