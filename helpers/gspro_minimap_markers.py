"""GSPro minimap player/pin/accepted-target CV detectors.
Transplanted from the physically proven minimap probe on
branch live-caddie-auto-aim-v1. No capture or mouse input here.
"""
from __future__ import annotations
import math
import cv2
import numpy as np
from auto_aim_transform import Point

MAGENTA_H_MIN = 135
MAGENTA_H_MAX = 175
MAGENTA_S_MIN = 120
MAGENTA_V_MIN = 150

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

def contour_circularity(c: np.ndarray) -> float:
    area = cv2.contourArea(c)
    perimeter = cv2.arcLength(c, True)
    return (4 * math.pi * area / (perimeter * perimeter)) if perimeter > 0 else 0.0


def detect_generic_ball_marker(roi: np.ndarray) -> Point:
    """
    Detect the compact, highly saturated player marker.
    Deliberately does NOT assume red because team color may control this marker.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = hsv.shape[:2]
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    mask = ((sat > 175) & (val > 120)).astype(np.uint8) * 255

    mask[: int(H * 0.11), :] = 0
    mask[int(H * 0.97):, :] = 0

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[float, Point]] = []

    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        if not (3 <= w <= 18 and 3 <= h <= 18 and 8 <= area <= 180):
            continue
        aspect = w / h
        circ = contour_circularity(c)
        if not (0.5 <= aspect <= 2.0 and circ >= 0.30):
            continue
        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        cx, cy = M["m10"] / M["m00"], M["m01"] / M["m00"]
        score = (cy / H) * 3.0 - abs(cx - W / 2) / (W / 2) * 0.8 + circ
        candidates.append((score, Point(cx, cy)))

    if not candidates:
        raise RuntimeError("Could not detect player marker. Use the debug crop to inspect ROI/marker color.")
    return max(candidates, key=lambda x: x[0])[1]


def detect_generic_pin_marker(roi: np.ndarray) -> Point:
    """Detect the small bright white pin dot; reject the large white cart-path/boundary geometry."""
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = hsv.shape[:2]
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    mask = ((sat < 35) & (val > 235)).astype(np.uint8) * 255
    mask[: int(H * 0.11), :] = 0
    mask[int(H * 0.90):, :] = 0

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[float, Point]] = []

    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        if not (4 <= w <= 20 and 4 <= h <= 20 and 12 <= area <= 200):
            continue
        aspect = w / h
        circ = contour_circularity(c)
        if not (0.5 <= aspect <= 2.0 and circ >= 0.40):
            continue
        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        cx, cy = M["m10"] / M["m00"], M["m01"] / M["m00"]
        score = (1.0 - cy / H) * 2.0 - abs(cx - W / 2) / (W / 2) * 0.5 + circ
        candidates.append((score, Point(cx, cy)))

    if not candidates:
        raise RuntimeError("Could not detect white pin marker.")
    return max(candidates, key=lambda x: x[0])[1]

def _magenta_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    return (
        (h >= MAGENTA_H_MIN)
        & (h <= MAGENTA_H_MAX)
        & (s >= MAGENTA_S_MIN)
        & (v >= MAGENTA_V_MIN)
    ).astype(np.uint8) * 255


def _magenta_pixels_near(roi: np.ndarray, point: Point, radius: int = 18) -> int:
    mask = _magenta_mask(roi)
    h, w = mask.shape[:2]
    x = int(round(point.x))
    y = int(round(point.y))
    x1, x2 = max(0, x - radius), min(w, x + radius + 1)
    y1, y2 = max(0, y - radius), min(h, y + radius + 1)
    return int(np.count_nonzero(mask[y1:y2, x1:x2]))


def _hue_at(roi: np.ndarray, point: Point, radius: int = 3) -> tuple[float, float, float]:
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


def _is_magenta_aim_marker(roi: np.ndarray, point: Point) -> bool:
    hue, sat, val = _hue_at(roi, point)
    if 135.0 <= hue <= 170.0 and sat >= 90.0 and val >= 120.0:
        return True
    # The crosshair has a hollow/transparent center, so center HSV alone can miss
    # it. The surrounding vivid-magenta pixel count is a stronger identity check.
    return _magenta_pixels_near(roi, point) >= 20


def _red_ball_from_mask(roi: np.ndarray) -> Point | None:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    low_red = cv2.inRange(hsv, np.array([0, 120, 100]), np.array([12, 255, 255]))
    high_red = cv2.inRange(hsv, np.array([170, 120, 100]), np.array([179, 255, 255]))
    mask = cv2.bitwise_or(low_red, high_red)
    mask[: int(h * 0.10), :] = 0
    mask[int(h * 0.98) :, :] = 0

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[float, Point]] = []
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
        point = Point(float(cx), float(cy))
        if _is_magenta_aim_marker(roi, point):
            continue
        score = circularity * 2.0 + 1.5 * (cy / max(h, 1)) - 0.25 * abs(cx - w / 2) / max(w / 2, 1)
        candidates.append((score, point))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def detect_actual_ball_marker(roi: np.ndarray) -> Point:
    # Prefer the compact generic player detector because it has a useful lower-map
    # prior, but explicitly reject the GSPro magenta aim target.
    try:
        candidate = detect_generic_ball_marker(roi)
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
    candidates: list[tuple[float, Point]] = []
    for x, y, _radius in _hough_circles(roi):
        if y < h * 0.11 or y > h * 0.98:
            continue
        _hue, sat, val = _center_hsv(hsv, x, y)
        point = Point(float(x), float(y))
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


def detect_magenta_aim_marker(roi: np.ndarray, expected: Point | None = None) -> Point:
    mask = _magenta_mask(roi)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[float, Point]] = []

    for label in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[label]]
        if area < 40 or area > 3500 or w < 12 or h < 12 or w > 100 or h > 100:
            continue
        center = Point(x + (w - 1) / 2.0, y + (h - 1) / 2.0)
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

def detect_pin_marker(roi: np.ndarray) -> Point:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    candidates: list[tuple[float, Point]] = []

    for x, y, _r in _hough_circles(roi):
        if y < H * 0.11 or y > H * 0.93:
            continue
        _h, sat, val = _center_hsv(hsv, x, y)
        if val < 220 or sat > 65:
            continue
        whiteness = val - sat
        score = whiteness + 18.0 * (1.0 - y / H) - 5.0 * abs(x - W / 2) / max(W / 2, 1)
        candidates.append((score, Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return detect_generic_pin_marker(roi)

