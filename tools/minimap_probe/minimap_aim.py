#!/usr/bin/env python3
"""Passive GSPro minimap AIM-marker sensor.

GSPro already draws the current aim point on the minimap as a small neutral-gray
circular marker, usually with a gray yardage label. Step 11 field review showed that
we were spending 2.4-3.4 seconds briefly moving LEFT/RIGHT merely to expose an AIM
card even when this marker was already visible in the frozen first frame.

The marker's *pixel position* is more useful than the AIM card alone: paired with the
visible ball/pin and a trusted PIN distance, it gives both aim distance and direction
without changing GSPro state. This module detects only the marker; it does not OCR
the label and never presses a key.

If the gray marker is occluded by the white pin (observed when aim ~= pin), this
sensor returns unavailable rather than guessing. The existing bounded AIM-card
summon remains the fallback.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import math
from typing import Any

import cv2
import numpy as np

import probe_v2 as v2
import probe_v4  # noqa: F401; installs robust marker patches


@dataclass
class PassiveAimState:
    distance_yds: float
    elevation_raw: str | None = None
    elevation_direction: str | None = None
    elevation_delta_ft: float | None = None
    elevation_delta_yds: float | None = None
    source: str = "gspro-minimap-aim-marker"
    distance_ocr_raw: str | None = None
    card_bbox: tuple[int, int, int, int] = (0, 0, 0, 0)


@dataclass
class AimMarker:
    x: float
    y: float
    bbox: tuple[int, int, int, int]
    area_px: int
    fill_ratio: float
    aspect_ratio: float
    mean_saturation: float
    mean_value: float
    detector_score: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _gray_marker_candidates(minimap_bgr: np.ndarray) -> list[AimMarker]:
    if minimap_bgr is None or minimap_bgr.ndim != 3:
        return []
    h, w = minimap_bgr.shape[:2]
    hsv = cv2.cvtColor(minimap_bgr, cv2.COLOR_BGR2HSV)

    # Marker field observations at the standard 564x950 minimap are ~17-18 px,
    # neutral gray (S~6, V~203). Scale the geometry gates with minimap width while
    # keeping broad enough limits for GSPro UI scaling.
    diameter_nominal = max(8.0, w * 0.031)
    min_d = max(7, int(round(diameter_nominal * 0.62)))
    max_d = max(min_d + 2, int(round(diameter_nominal * 1.55)))
    min_area = max(20, int(round(math.pi * (diameter_nominal * 0.28) ** 2)))
    max_area = max(min_area + 20, int(round(math.pi * (diameter_nominal * 0.78) ** 2)))

    mask = cv2.inRange(hsv, np.array([0, 0, 130], dtype=np.uint8), np.array([180, 35, 245], dtype=np.uint8))
    # Exclude title/header and extreme footer. The aim marker lives in course imagery.
    mask[: int(round(h * 0.11)), :] = 0
    mask[int(round(h * 0.97)) :, :] = 0

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out: list[AimMarker] = []
    for label in range(1, count):
        x, y, bw, bh, area = [int(v) for v in stats[label]]
        if not (min_area <= area <= max_area and min_d <= bw <= max_d and min_d <= bh <= max_d):
            continue
        aspect = min(bw, bh) / max(bw, bh)
        fill = area / max(1, bw * bh)
        if aspect < 0.78 or fill < 0.53:
            continue
        component = labels == label
        values = hsv[component]
        mean_s = float(values[:, 1].mean()) if len(values) else 255.0
        mean_v = float(values[:, 2].mean()) if len(values) else 0.0
        if mean_s > 25.0 or not (155.0 <= mean_v <= 235.0):
            continue
        cx, cy = [float(v) for v in centroids[label]]
        size_score = max(0.0, 1.0 - abs((bw + bh) / 2.0 - diameter_nominal) / max(diameter_nominal, 1.0))
        neutral_score = max(0.0, 1.0 - mean_s / 25.0)
        value_score = max(0.0, 1.0 - abs(mean_v - 205.0) / 55.0)
        score = 0.35 * aspect + 0.25 * min(1.0, fill / 0.70) + 0.20 * size_score + 0.10 * neutral_score + 0.10 * value_score
        out.append(AimMarker(
            x=cx,
            y=cy,
            bbox=(x, y, bw, bh),
            area_px=area,
            fill_ratio=float(fill),
            aspect_ratio=float(aspect),
            mean_saturation=mean_s,
            mean_value=mean_v,
            detector_score=float(score),
        ))
    return sorted(out, key=lambda item: item.detector_score, reverse=True)


def read_passive_aim(minimap_bgr: np.ndarray, *, pin_distance_yds: float) -> tuple[PassiveAimState | None, dict[str, Any]]:
    pin_distance = float(pin_distance_yds)
    if not math.isfinite(pin_distance) or pin_distance <= 0:
        return None, {"status": "unavailable", "reason": "invalid-pin-distance", "attempted_actuation": False}

    try:
        ball = v2.detect_ball_marker(minimap_bgr)
        pin = v2.detect_pin_marker(minimap_bgr)
    except Exception as exc:
        return None, {"status": "unavailable", "reason": f"marker-detection: {exc}", "attempted_actuation": False}

    ball_xy = np.asarray([float(ball.x), float(ball.y)], dtype=float)
    pin_xy = np.asarray([float(pin.x), float(pin.y)], dtype=float)
    pin_pixels = float(np.linalg.norm(pin_xy - ball_xy))
    if pin_pixels < 10.0:
        return None, {"status": "unavailable", "reason": "ball-pin-separation-too-small", "attempted_actuation": False}
    yards_per_pixel = pin_distance / pin_pixels
    if not (0.02 <= yards_per_pixel <= 3.0):
        return None, {"status": "unavailable", "reason": f"implausible-scale:{yards_per_pixel:.4f}", "attempted_actuation": False}

    candidates = []
    for item in _gray_marker_candidates(minimap_bgr):
        aim_xy = np.asarray([item.x, item.y], dtype=float)
        ball_px = float(np.linalg.norm(aim_xy - ball_xy))
        pin_px = float(np.linalg.norm(aim_xy - pin_xy))
        # If AIM is directly under the white pin it is visually unavailable. Do not
        # mistake anti-aliased pin pixels for a gray AIM marker or infer aim==pin.
        if pin_px < max(10.0, minimap_bgr.shape[1] * 0.022):
            continue
        if ball_px < max(8.0, minimap_bgr.shape[1] * 0.014):
            continue
        distance = ball_px * yards_per_pixel
        if not (2.0 <= distance <= max(550.0, pin_distance * 1.75 + 25.0)):
            continue
        candidates.append((item.detector_score, item, distance, pin_px))

    if not candidates:
        return None, {
            "status": "not-visible",
            "reason": "no-separate-neutral-gray-aim-marker",
            "attempted_actuation": False,
            "ball_pixel": {"x": float(ball.x), "y": float(ball.y)},
            "pin_pixel": {"x": float(pin.x), "y": float(pin.y)},
            "pin_distance_yds": pin_distance,
            "yards_per_pixel": yards_per_pixel,
        }

    candidates.sort(key=lambda row: row[0], reverse=True)
    score, marker, distance, pin_px = candidates[0]
    state = PassiveAimState(distance_yds=float(distance))
    meta = {
        "status": "passive-minimap-marker",
        "attempted": False,
        "attempted_actuation": False,
        "verified_return": None,
        "source": state.source,
        "distance_yds": float(distance),
        "ball_pixel": {"x": float(ball.x), "y": float(ball.y)},
        "pin_pixel": {"x": float(pin.x), "y": float(pin.y)},
        "aim_pixel": {"x": marker.x, "y": marker.y},
        "aim_marker": marker.to_dict(),
        "pin_distance_yds": pin_distance,
        "yards_per_pixel": yards_per_pixel,
        "aim_to_pin_pixels": pin_px,
        "confidence": float(max(0.0, min(1.0, score))),
        "note": "Passive minimap position gives aim distance/direction; elevation remains unavailable unless AIM-card fallback is used.",
    }
    return state, meta
