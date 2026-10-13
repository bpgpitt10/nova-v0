#!/usr/bin/env python3
"""Detect GSPro gray waypoint markers and OCR their displayed yardages.

This module intentionally solves only the minimap-local ruler problem. It does
not decide where Looper should aim and it never sends mouse/keyboard input.

The preserved corpus shows that GSPro renders route/default-aim waypoints as a
small light-gray vertical oval followed by a white numeric yardage label. The
label is the current-ball distance to that marker. Because both marker and a
future click live in the same minimap frame, ``yardage / ball->marker pixels``
gives a local yards-per-pixel ruler without assuming screen hole yardage equals
a straight ball->pin line.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

from waypoint_scale import Point, WaypointObservation, resolve_minimap_scale


# Empirically stable across the preserved Greywolf tee corpus and the older
# approach/lie screenshot corpus.
GRAY_HSV_LOW = np.array([0, 18, 150], dtype=np.uint8)
GRAY_HSV_HIGH = np.array([179, 62, 240], dtype=np.uint8)
# Live FarmLinks 4K markers measured around H=21..25, S=7..9, V=220..248.
# Unlike the older Greywolf tinted markers they are effectively neutral-white.
# Excluding full-255 white helps keep the white flag/pin out of the oval pool.
NEAR_WHITE_HSV_LOW = np.array([0, 0, 185], dtype=np.uint8)
NEAR_WHITE_HSV_HIGH = np.array([179, 20, 252], dtype=np.uint8)
MAX_COMPONENT_SATURATION = 45.0
MIN_COMPONENT_VALUE = 185.0
MIN_COMPONENT_AREA = 35
MAX_COMPONENT_AREA = 220
HEADER_EXCLUSION_PX = 120
OCR_THRESHOLDS = (150, 160, 170, 180, 190, 200, 210, 220)


@dataclass(frozen=True)
class GrayWaypoint:
    pixel: Point
    yards: float
    ocr_text: str
    confidence: float
    ocr_votes: int


def _candidate_markers(image: np.ndarray) -> list[Point]:
    """Find the low-saturation light-gray GSPro waypoint ovals."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    tinted = cv2.inRange(hsv, GRAY_HSV_LOW, GRAY_HSV_HIGH)
    neutral = cv2.inRange(hsv, NEAR_WHITE_HSV_LOW, NEAR_WHITE_HSV_HIGH)
    mask = cv2.bitwise_or(tinted, neutral)
    mask[: min(HEADER_EXCLUSION_PX, mask.shape[0]), :] = 0
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[Point, int]] = []
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
        candidates.append((Point(float(cx), float(cy)), area))

    # Prefer real full-size marker ovals over individual small white digits.
    # Previously the four-candidate OCR budget could be exhausted on text
    # fragments above the second waypoint (e.g. FarmLinks 445 / 253).
    candidates.sort(key=lambda entry: (-entry[1], entry[0].y, entry[0].x))
    return [point for point, _area in candidates]


def count_gray_waypoint_candidates(image: np.ndarray) -> int:
    """Safe numeric diagnostic: distinguish marker segmentation from digit OCR."""
    return len(_candidate_markers(image))


def _run_digit_ocr(
    gray: np.ndarray,
    threshold: int,
    *,
    tesseract_path: str,
) -> str | None:
    _, prepared = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    handle = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    temp_path = handle.name
    handle.close()
    try:
        cv2.imwrite(temp_path, prepared)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        command = [
            tesseract_path, temp_path, "stdout", "-l", "eng",
            "--psm", "7", "-c", "tessedit_char_whitelist=0123456789",
        ]
        # Works with the per-user bundled OCR engine as well as normal installs.
        tessdata = Path(tesseract_path).resolve().parent / "tessdata"
        if (tessdata / "eng.traineddata").is_file():
            command.extend(["--tessdata-dir", str(tessdata)])
        completed = subprocess.run(
            command,
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
    return digits


def _ocr_numeric_crop(
    image: np.ndarray,
    marker: Point,
    *,
    tesseract_path: str = "tesseract",
    deadline: float | None = None,
) -> tuple[str, float, int] | None:
    """Read the white yardage label rendered below/right of one gray marker.

    Multiple fixed thresholds are deliberately voted instead of trusting one
    segmentation. PNG tee captures are easy; JPEG approach captures can shift a
    digit edge enough that a single threshold confuses e.g. 51/91. Voting made
    the saved tee labels exact and recovered the older compressed approach labels.
    """
    height, width = image.shape[:2]
    x1 = max(0, int(round(marker.x)) - 8)
    x2 = min(width, int(round(marker.x)) + 105)
    y1 = max(0, int(round(marker.y)) + 3)
    y2 = min(height, int(round(marker.y)) + 58)
    if x2 - x1 < 20 or y2 - y1 < 12:
        return None

    crop = image[y1:y2, x1:x2]
    enlarged = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)

    reads: list[str] = []
    for threshold in OCR_THRESHOLDS:
        if deadline is not None and time.monotonic() >= deadline:
            break
        parsed = _run_digit_ocr(gray, threshold, tesseract_path=tesseract_path)
        if parsed is not None:
            reads.append(parsed)

    if not reads:
        return None
    text, votes = Counter(reads).most_common(1)[0]
    confidence = votes / len(OCR_THRESHOLDS)
    return text, confidence, votes


def detect_gray_waypoints(
    image: np.ndarray,
    *,
    tesseract_path: str = "tesseract",
    max_candidates: int | None = None,
    time_budget_s: float | None = None,
) -> list[GrayWaypoint]:
    """Original recognizer, optionally bounded for companion HTTP polling."""
    observations: list[GrayWaypoint] = []
    deadline = time.monotonic() + time_budget_s if time_budget_s is not None else None
    candidates = _candidate_markers(image)
    if max_candidates is not None:
        candidates = candidates[:max(0, int(max_candidates))]
    for marker in candidates:
        if deadline is not None and time.monotonic() >= deadline:
            break
        try:
            parsed = _ocr_numeric_crop(
                image, marker, tesseract_path=tesseract_path, deadline=deadline
            )
        except (OSError, subprocess.TimeoutExpired, cv2.error):
            continue
        if parsed is None:
            continue
        label, confidence, votes = parsed
        observations.append(
            GrayWaypoint(
                pixel=marker,
                yards=float(label),
                ocr_text=label,
                confidence=confidence,
                ocr_votes=votes,
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
                "ocr_votes": item.ocr_votes,
                "confidence": item.confidence,
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
                f"({item.pixel.x:.1f},{item.pixel.y:.1f}) "
                f"votes={item.ocr_votes}/{len(OCR_THRESHOLDS)}"
            )
        if result.diagnostic_pin_delta_pct is not None:
            print(f"  pin ruler delta: {result.diagnostic_pin_delta_pct:+.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
