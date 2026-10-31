"""Auto Aim step 1: where Looper WOULD click on GSPro's minimap. No input.

GSPro draws the minimap as a top-down, north-not-necessarily-up view that it
rotates and zooms every shot so the ball (red dot) sits low and the pin
(white dot) sits high on one vertical line. Looper knows both points exactly in
GSPro world metres (currentRound EndingPOS / GKD tee, and the GKD pin slot),
so the two dots fix the minimap's scale, rotation and offset for THIS frame:

    pixel = a * (x - i z) + b        (complex numbers; a = scale+rotation)

Checked on five real FarmLinks frames (deep rough, trees, bunker, fairway,
tee): OSM bunker centroids mapped this way land on sand-coloured pixels; the
mirrored alternative lands on grass. No waypoint labels are read.

The frame never leaves this process except as a small annotated crop of the
minimap returned to the Looper page on this PC.
"""
from __future__ import annotations

import base64
import math
from dataclasses import dataclass

import cv2
import numpy as np

import gspro_minimap_markers as markers

RIGHT_MINIMAP_ROI = (0.848, 0.520, 0.995, 0.960)
METERS_TO_YARDS = 1.0936132983377078
# The red ball dot is ~18 px on a 3760 px wide window: ~3.3% of the minimap width.
BALL_DOT_FRACTION = 0.033
MIN_BALL_PIN_PX = 60.0
MAX_ALIGNMENT_RATIO = 0.08


@dataclass(frozen=True)
class Pixel:
    x: float
    y: float


def crop_minimap(frame_bgr: np.ndarray, roi=RIGHT_MINIMAP_ROI):
    height, width = frame_bgr.shape[:2]
    x1, y1, x2, y2 = roi
    x0, y0 = int(width * x1), int(height * y1)
    xe, ye = int(width * x2), int(height * y2)
    if xe - x0 < 60 or ye - y0 < 90:
        raise ValueError("Minimap crop is too small")
    return frame_bgr[y0:ye, x0:xe].copy(), (x0, y0)


def find_red_ball_dot(roi: np.ndarray, pin: Pixel) -> Pixel:
    """The red ball dot: a compact round red blob, preferring the one on the
    pin's vertical line below it (GSPro aligns ball and pin vertically). Red
    OB/hazard lines are long and thin and are rejected by size and shape."""
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    red = cv2.bitwise_or(
        cv2.inRange(hsv, np.array([0, 120, 100]), np.array([12, 255, 255])),
        cv2.inRange(hsv, np.array([170, 120, 100]), np.array([179, 255, 255])),
    )
    expected = max(6.0, BALL_DOT_FRACTION * w)
    contours, _ = cv2.findContours(red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best: tuple[float, Pixel] | None = None
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if not (0.5 * expected <= cw <= 1.8 * expected and 0.5 * expected <= ch <= 1.8 * expected):
            continue
        area = cv2.contourArea(contour)
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / (perimeter * perimeter) if perimeter else 0.0
        if circularity < 0.55:
            continue
        m = cv2.moments(contour)
        if m["m00"] == 0:
            continue
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        if cy <= pin.y:
            continue
        score = abs(cx - pin.x) / max(cy - pin.y, 1.0) - 0.2 * circularity
        if best is None or score < best[0]:
            best = (score, Pixel(float(cx), float(cy)))
    if best is None:
        raise RuntimeError("Could not find GSPro's red ball dot on the minimap")
    return best[1]


def find_ball_and_pin(roi: np.ndarray) -> tuple[Pixel, Pixel]:
    pin_point = markers.detect_pin_marker(roi)
    pin = Pixel(float(pin_point.x), float(pin_point.y))
    ball = find_red_ball_dot(roi, pin)
    return ball, pin


def _complex_world(x: float, z: float) -> complex:
    # Top-down, not mirrored: east right, north up (image y grows downward).
    return complex(x, -z)


@dataclass(frozen=True)
class MinimapFrame:
    a: complex
    b: complex

    def to_pixel(self, x: float, z: float) -> Pixel:
        q = self.a * _complex_world(x, z) + self.b
        return Pixel(q.real, q.imag)

    def to_world(self, px: Pixel) -> tuple[float, float]:
        w = (complex(px.x, px.y) - self.b) / self.a
        return w.real, -w.imag

    @property
    def yards_per_pixel(self) -> float:
        return METERS_TO_YARDS / abs(self.a)


def solve_minimap_frame(ball_world, pin_world, ball_px: Pixel, pin_px: Pixel) -> MinimapFrame:
    wb, wp = _complex_world(*ball_world), _complex_world(*pin_world)
    pb, pp = complex(ball_px.x, ball_px.y), complex(pin_px.x, pin_px.y)
    if abs(wp - wb) < 1.0:
        raise ValueError("Ball and pin are too close to fix the minimap scale")
    a = (pp - pb) / (wp - wb)
    return MinimapFrame(a=a, b=pb - a * wb)


def _png_base64(image: np.ndarray, max_width: int = 320) -> str:
    h, w = image.shape[:2]
    if w > max_width:
        image = cv2.resize(image, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("Could not encode preview image")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def aim_preview(frame_bgr: np.ndarray, *, ball_world, pin_world, target_world, roi=RIGHT_MINIMAP_ROI) -> dict:
    """Where Looper would click for target_world on this frame. Read-only."""
    for value in (*ball_world, *pin_world, *target_world):
        if not math.isfinite(value):
            raise ValueError("Non-finite world coordinate")
    crop, (x0, y0) = crop_minimap(frame_bgr, roi)
    ball_px, pin_px = find_ball_and_pin(crop)
    separation = math.hypot(pin_px.x - ball_px.x, pin_px.y - ball_px.y)
    if separation < MIN_BALL_PIN_PX:
        raise RuntimeError("Ball and pin dots are too close on the minimap to aim precisely")
    alignment = abs(pin_px.x - ball_px.x) / separation
    frame = solve_minimap_frame(ball_world, pin_world, ball_px, pin_px)
    target_px = frame.to_pixel(*target_world)
    h, w = crop.shape[:2]
    inside = 0 <= target_px.x < w and 0 <= target_px.y < h

    annotated = crop.copy()
    r = max(5, int(w * 0.02))
    cv2.circle(annotated, (int(round(ball_px.x)), int(round(ball_px.y))), r + 3, (255, 255, 255), 2)
    cv2.circle(annotated, (int(round(pin_px.x)), int(round(pin_px.y))), r + 3, (255, 255, 255), 2)
    if inside:
        tx, ty = int(round(target_px.x)), int(round(target_px.y))
        cv2.line(annotated, (int(ball_px.x), int(ball_px.y)), (tx, ty), (0, 215, 255), 2)
        cv2.circle(annotated, (tx, ty), r + 6, (0, 215, 255), 3)
        cv2.drawMarker(annotated, (tx, ty), (0, 215, 255), cv2.MARKER_CROSS, 2 * r + 10, 2)

    return {
        "status": "ready" if inside else "target-off-map",
        "click": {"windowX": round(x0 + target_px.x, 1), "windowY": round(y0 + target_px.y, 1)} if inside else None,
        "minimap": {
            "ball": [round(ball_px.x, 1), round(ball_px.y, 1)],
            "pin": [round(pin_px.x, 1), round(pin_px.y, 1)],
            "target": [round(target_px.x, 1), round(target_px.y, 1)],
            "width": w, "height": h,
        },
        "checks": {
            "ballPinPixels": round(separation, 1),
            "ballPinVerticalAlignment": round(alignment, 3),
            "alignedLikeGspro": alignment <= MAX_ALIGNMENT_RATIO,
            "yardsPerPixel": round(frame.yards_per_pixel, 3),
        },
        "previewPng": _png_base64(annotated),
    }
