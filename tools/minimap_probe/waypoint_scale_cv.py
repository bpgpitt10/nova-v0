#!/usr/bin/env python3
"""Detect GSPro gray waypoint markers and OCR their displayed yardages.

This module intentionally solves only the minimap-local ruler problem. It does
not decide where Looper should aim and it never sends mouse/keyboard input.

The preserved tee corpus shows that GSPro renders route/default-aim waypoints as
a small light-gray vertical oval followed by a white numeric yardage label. The
label is the current-ball distance to that marker. Because both marker and a
future click live in the same minimap frame, ``yardage / ball->marker pixels``
gives a local yards-per-pixel ruler without assuming screen hole yardage equals
a straight ball->pin line.
"""

from __future__ import annotations

from dataclasses import dataclass
import argparse
import json
import os
import subprocess
import tempfile

import cv2
import numpy as np

from waypoint_scale import Point, WaypointObservation, resolve_minimap_scale


# Empirically stable across the preserved 18-hole Greywolf tee corpus.
GRAY_HSV_LOW = np.array([0, 18, 150], dtype=np.uint8)
GRAY_HSV_HIGH = np.array([179, 62, 240], dtype=np.uint8)
MAX_COMPONENT_SATURATION = 45.0
MIN_COMPONENT_VALUE = 185.0
MIN_COMPONENT_AREA = 35
MAX_COMPONENT_AREA = 220
HEADER_EXCLUSION_PX = 120


@dataclass(frozen=True)
class GrayWaypoint:
    pixel: Point
    yards: float
    ocr_text: str
    confidence: float


def _candidate_markers(image: np.ndarray) -> list[Point]:
    """Find the low-saturation light-gray GSPro waypoint ovals."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, GRAY_HSV_LOW, GRAY_HSV_HIGH)
    mask[: min(HEADER_EXCLUSION_PX, mask.shape[0]), :] = 0
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[Point] = []
    for label in range(1, count):
        x, y, width, height, area = [int(value) for value in stats[label]]
        if not (MIN_COMPONENT_AREA <= area <= MAX_COMPONENT_AREA):
            continue
        if not (6 <= width <= 20 and 9 <= height <= 25):
            continue
        aspect = width / max(height, 1)
        fill = area / max(width * height, 1)
        if not (0.40 <= aspect <= 1.40 and fill >= 0.35):
            continue

        component_pixels = hsv[y : y + height, x : x + width][
            labels[y : y + height, x : x + width] == label
        ]
        if component_pixels.size == 0:
            continue
        _hue, saturation, value = component_pixels.mean(axis=0)
        if saturation > MAX_COMPONENT_SATURATION or value < MIN_COMPONENT_VALUE:
            continue

        cx, cy = centroids[label]
        candidates.append(Point(float(cx), float(cy)))

    candidates.sort(key=lambda point: (point.y, point.x))
    return candidates


def _ocr_numeric_crop(
    image: np.ndarray,
    marker: Point,
    *,
    tesseract_path: str = "tesseract",
) -> tuple[str, float] | None:
    """Read the white yardage label rendered below/right of one gray marker."""
    height, width = image.shape[:2]
    x1 = max(0, int(round(marker.x)) - 8)
    x2 = min(width, int(round(marker.x)) + 105)
    y1 = max(0, int(round(marker.y)) + 3)
    y2 = min(height, int(round(marker.y)) + 58)
    if x2 - x1 < 20 or y2 - y1 < 12:
        return None

    crop = image[y1:y2, x1:x2]
    enlarged = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)

    # Fixed bright threshold was more stable than Otsu on the preserved corpus:
    # it read all visible tee waypoint labels correctly, while Otsu sometimes
    # confused 1/7 or appended background texture.
    _, prepared = cv2.threshold(gray, 185, 255, cv2.THRESH_BINARY)

    handle = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    temp_path = handle.name
    handle.close()
    try:
        cv2.imwrite(temp_path, prepared)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        completed = subprocess.run(
            [
                tesseract_path,
                temp_path,
                "stdout",
                "--psm",
                "7",
                "-c",
                "tessedit_char_whitelist=0123456789",
            ],
            capture_output=True,
            text=True,
            creationflags=creationflags,
            timeout=6,
        )
        if completed.returncode != 0:
            return None
        digits = "".join(char for char in completed.stdout if char.isdigit())
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass

    if not (2 <= len(digits) <= 3):
        return None
    yards = int(digits)
    if not (10 <= yards <= 700):
        return None
    return digits, 1.0


def detect_gray_waypoints(
    image: np.ndarray,
    *,
    tesseract_path: str = "tesseract",
) -> list[GrayWaypoint]:
    observations: list[GrayWaypoint] = []
    for marker in _candidate_markers(image):
        parsed = _ocr_numeric_crop(image, marker, tesseract_path=tesseract_path)
        if parsed is None:
            continue
        text, confidence = parsed
        observations.append(
            GrayWaypoint(
                pixel=marker,
                yards=float(text),
                ocr_text=text,
                confidence=confidence,
            )
        )
    return observations


def resolve_scale_from_image(
    image: np.ndarray,
    *,
    ball: Point,
    pin: Point,
    pin_distance_yds: float | None,
    par: int | None,
    tesseract_path: str = "tesseract",
):
    detected = detect_gray_waypoints(image, tesseract_path=tesseract_path)
    result = resolve_minimap_scale(
        ball=ball,
        pin=pin,
        pin_distance_yds=pin_distance_yds,
        par=par,
        waypoints=[
            WaypointObservation(
                yards=item.yards,
                pixel=item.pixel,
                confidence=item.confidence,
            )
            for item in detected
        ],
    )
    return result, detected


def _parse_point(value: str) -> Point:
    left, right = value.split(",", 1)
    return Point(float(left), float(right))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect GSPro gray waypoint ruler and resolve minimap scale"
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--ball", required=True, help="x,y minimap pixel")
    parser.add_argument("--pin", required=True, help="x,y minimap pixel")
    parser.add_argument("--pin-distance", type=float)
    parser.add_argument("--par", type=int)
    parser.add_argument("--tesseract", default="tesseract")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    image = cv2.imread(args.image)
    if image is None:
        raise RuntimeError(f"Could not read {args.image}")

    result, detected = resolve_scale_from_image(
        image,
        ball=_parse_point(args.ball),
        pin=_parse_point(args.pin),
        pin_distance_yds=args.pin_distance,
        par=args.par,
        tesseract_path=args.tesseract,
    )
    payload = {
        "yards_per_pixel": result.yards_per_pixel,
        "source": result.source,
        "waypoint_count": result.waypoint_count,
        "waypoint_spread_pct": result.waypoint_spread_pct,
        "diagnostic_pin_delta_pct": result.diagnostic_pin_delta_pct,
        "waypoints": [
            {
                "yards": item.yards,
                "x": item.pixel.x,
                "y": item.pixel.y,
                "ocr": item.ocr_text,
            }
            for item in detected
        ],
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(
            f"scale={result.yards_per_pixel:.6f} yd/px source={result.source} "
            f"waypoints={result.waypoint_count}"
        )
        for item in detected:
            print(
                f"  gray waypoint {item.ocr_text} yd @ "
                f"({item.pixel.x:.1f},{item.pixel.y:.1f})"
            )
        if result.diagnostic_pin_delta_pct is not None:
            print(f"  pin ruler delta: {result.diagnostic_pin_delta_pct:+.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
