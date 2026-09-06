#!/usr/bin/env python3
"""
GSPro Minimap Hazard Probe v2

POC upgrades over the original probe:
- more robust marker detection that does not assume the player marker is red;
- physical-scale-aware grouping of fragmented red penalty boundaries;
- direct ball->pin centerline crossing estimates;
- optional Windows keypress recovery when GSPro zoom hides a marker.

This remains isolated from Looper app code.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

import probe as base


@dataclass
class PenaltyObject:
    object_id: int
    nearest_yds: float
    farthest_yds: float
    forward_min_yds: float
    forward_max_yds: float
    lateral_min_yds: float
    lateral_max_yds: float
    median_lateral_yds: float
    centerline_crossings_yds: list[float]
    corridor_entry_yds: float | None
    corridor_exit_yds: float | None


@dataclass
class ProbeV2Result:
    distance_to_pin_yds: float
    ball_pixel: base.Point
    pin_pixel: base.Point
    pixels_ball_to_pin: float
    yards_per_pixel: float
    penalty_objects: list[PenaltyObject]
    zoom_retries_used: int


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro minimap hazard geometry POC v2")
    p.add_argument("--distance", type=float, required=True,
                   help="Current GSPro distance to pin in yards.")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--corridor", type=float, default=40.0,
                   help="Half-width of planning corridor in yards. Default 40.")
    p.add_argument("--centerline-band", type=float, default=4.0,
                   help="Half-width around ball-to-pin line used for direct red-boundary crossings.")
    p.add_argument("--merge-gap", type=float, default=4.0,
                   help="Approx physical red-line gap to reconnect in yards. Default 4.")
    p.add_argument("--zoom-out-key", choices=["q", "w", "Q", "W"],
                   help="Optional GSPro zoom-out key. Used only when marker detection fails.")
    p.add_argument("--zoom-attempts", type=int, default=4)
    p.add_argument("--debug-dir", default=str(Path(__file__).with_name("output")))
    p.add_argument("--json", action="store_true")
    return p.parse_args()


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


def detect_ball_marker(roi: np.ndarray) -> base.Point:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, _r in _hough_circles(roi):
        if y < H * 0.11 or y > H * 0.98:
            continue
        _h, sat, val = _center_hsv(hsv, x, y)
        if sat < 110 or val < 150:
            continue
        score = sat + 0.12 * val + 55.0 * (y / H) - 8.0 * abs(x - W / 2) / max(W / 2, 1)
        candidates.append((score, base.Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return base.detect_ball_marker(roi)


def detect_pin_marker(roi: np.ndarray) -> base.Point:
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    candidates: list[tuple[float, base.Point]] = []

    for x, y, _r in _hough_circles(roi):
        if y < H * 0.11 or y > H * 0.93:
            continue
        _h, sat, val = _center_hsv(hsv, x, y)
        if val < 220 or sat > 65:
            continue
        whiteness = val - sat
        score = whiteness + 18.0 * (1.0 - y / H) - 5.0 * abs(x - W / 2) / max(W / 2, 1)
        candidates.append((score, base.Point(x, y)))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return base.detect_pin_marker(roi)


def press_key_windows(key: str) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Automatic GSPro key recovery is Windows-only.")
    vk = ord(key.upper())
    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


def mask_player_marker(mask: np.ndarray, ball: base.Point, radius_px: int = 13) -> np.ndarray:
    out = mask.copy()
    cv2.circle(out, (round(ball.x), round(ball.y)), radius_px, 0, -1)
    return out


def odd_kernel_size(radius_px: int) -> int:
    return max(3, radius_px * 2 + 1)


def cluster_distances(values: np.ndarray, max_gap_yds: float = 6.0) -> list[float]:
    if values.size == 0:
        return []
    vals = np.sort(values.astype(float))
    groups: list[list[float]] = [[float(vals[0])]]
    for raw in vals[1:]:
        value = float(raw)
        if value - groups[-1][-1] <= max_gap_yds:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [float(np.median(group)) for group in groups]


def build_penalty_objects(
    roi: np.ndarray,
    ball: base.Point,
    pin: base.Point,
    distance_to_pin_yds: float,
    corridor_half_width_yds: float,
    centerline_band_yds: float,
    merge_gap_yds: float,
) -> tuple[list[PenaltyObject], float, float]:
    b = np.array([ball.x, ball.y], dtype=float)
    p = np.array([pin.x, pin.y], dtype=float)
    vec = p - b
    pin_pixels = float(np.linalg.norm(vec))
    if pin_pixels < 10:
        raise RuntimeError("Detected ball/pin separation is too small to calibrate reliably.")

    scale = distance_to_pin_yds / pin_pixels
    if not (0.03 <= scale <= 3.0):
        raise RuntimeError(f"Implausible minimap scale {scale:.4f} yd/px; marker detection likely wrong.")

    forward_unit = vec / pin_pixels
    right_unit = np.array([-forward_unit[1], forward_unit[0]])

    raw = mask_player_marker(base.penalty_mask(roi), ball)

    # Reconnect red boundary pieces interrupted by labels/anti-aliasing. The kernel
    # is chosen in physical yards so the behavior follows GSPro zoom.
    radius_px = int(round((merge_gap_yds / max(scale, 1e-6)) / 2.0))
    radius_px = max(1, min(radius_px, 12))
    k = odd_kernel_size(radius_px)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    merged = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, kernel)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(merged, 8)
    objects: list[PenaltyObject] = []
    next_id = 1

    for label in range(1, count):
        area_px = int(stats[label, cv2.CC_STAT_AREA])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])
        if area_px < 35 or max(w, h) < 16:
            continue

        ys, xs = np.where(labels == label)
        pts = np.column_stack([xs, ys]).astype(float)
        delta = pts - b
        forward = (delta @ forward_unit) * scale
        lateral = (delta @ right_unit) * scale
        euclidean = np.linalg.norm(delta, axis=1) * scale

        ahead = forward > 0
        if int(ahead.sum()) < 20:
            continue
        if np.max(forward[ahead]) < 8 and np.max(euclidean[ahead]) < 12:
            continue

        corridor = ahead & (np.abs(lateral) <= corridor_half_width_yds)
        centerline = ahead & (np.abs(lateral) <= centerline_band_yds)
        corridor_entry = float(np.min(forward[corridor])) if np.any(corridor) else None
        corridor_exit = float(np.max(forward[corridor])) if np.any(corridor) else None
        crossings = cluster_distances(forward[centerline], max_gap_yds=6.0)

        objects.append(PenaltyObject(
            object_id=next_id,
            nearest_yds=float(np.min(euclidean[ahead])),
            farthest_yds=float(np.max(euclidean[ahead])),
            forward_min_yds=float(np.min(forward[ahead])),
            forward_max_yds=float(np.max(forward[ahead])),
            lateral_min_yds=float(np.min(lateral[ahead])),
            lateral_max_yds=float(np.max(lateral[ahead])),
            median_lateral_yds=float(np.median(lateral[ahead])),
            centerline_crossings_yds=crossings,
            corridor_entry_yds=corridor_entry,
            corridor_exit_yds=corridor_exit,
        ))
        next_id += 1

    objects.sort(key=lambda obj: obj.nearest_yds)
    return objects, pin_pixels, scale


def detect_with_optional_zoom(args: argparse.Namespace) -> tuple[np.ndarray, base.Point, base.Point, int]:
    retries = 0
    last_error: Exception | None = None

    while True:
        screenshot = base.capture_monitor(args.monitor)
        roi, _ = base.crop_minimap(screenshot, args.roi)
        try:
            ball = detect_ball_marker(roi)
            pin = detect_pin_marker(roi)
            sep = math.hypot(pin.x - ball.x, pin.y - ball.y)
            scale = args.distance / sep if sep > 0 else 999.0
            if sep < 20 or not (0.03 <= scale <= 3.0):
                raise RuntimeError(f"Marker pair failed geometry sanity check: sep={sep:.1f}px scale={scale:.3f}")
            return roi, ball, pin, retries
        except Exception as exc:
            last_error = exc

        if not args.zoom_out_key or retries >= args.zoom_attempts:
            raise RuntimeError(f"Could not get reliable ball/pin markers: {last_error}")

        press_key_windows(args.zoom_out_key)
        retries += 1
        time.sleep(0.35)


def side_text(value: float) -> str:
    if abs(value) < 3:
        return "center"
    return f"{abs(value):.0f} yd {'right' if value > 0 else 'left'}"


def print_result(result: ProbeV2Result, corridor: float) -> None:
    print()
    print("GSPro MINIMAP HAZARD PROBE v2")
    print("==================================")
    print(f"Pin distance:       {result.distance_to_pin_yds:.1f} yd")
    print(f"Ball -> pin pixels: {result.pixels_ball_to_pin:.1f} px")
    print(f"Map scale:          {result.yards_per_pixel:.4f} yd/px")
    print(f"Ball pixel:         ({result.ball_pixel.x:.1f}, {result.ball_pixel.y:.1f})")
    print(f"Pin pixel:          ({result.pin_pixel.x:.1f}, {result.pin_pixel.y:.1f})")
    print(f"Zoom retries used:  {result.zoom_retries_used}")
    print()
    print(f"Penalty objects ({len(result.penalty_objects)}):")
    if not result.penalty_objects:
        print("  None detected in visible minimap.")
        return

    for obj in result.penalty_objects:
        crossings = ", ".join(f"{x:.0f}" for x in obj.centerline_crossings_yds) or "none"
        corridor_text = (
            f"corridor {obj.corridor_entry_yds:.0f}-{obj.corridor_exit_yds:.0f} yd"
            if obj.corridor_entry_yds is not None and obj.corridor_exit_yds is not None
            else f"outside ±{corridor:.0f} yd corridor"
        )
        print(
            f"  #{obj.object_id}: nearest {obj.nearest_yds:.0f} yd; "
            f"forward {obj.forward_min_yds:.0f}-{obj.forward_max_yds:.0f}; "
            f"mostly {side_text(obj.median_lateral_yds)}; {corridor_text}; "
            f"centerline red crossings [{crossings}]"
        )


def write_debug(
    roi: np.ndarray,
    ball: base.Point,
    pin: base.Point,
    objects: list[PenaltyObject],
    scale: float,
    distance: float,
    out_dir: Path,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    canvas = roi.copy()
    mask = base.penalty_mask(roi)
    overlay = canvas.copy()
    overlay[mask > 0] = (0, 0, 255)
    canvas = cv2.addWeighted(canvas, 0.75, overlay, 0.25, 0)

    ball_xy = (round(ball.x), round(ball.y))
    pin_xy = (round(pin.x), round(pin.y))
    cv2.circle(canvas, ball_xy, 9, (0, 255, 255), 2)
    cv2.circle(canvas, pin_xy, 9, (255, 255, 0), 2)
    cv2.line(canvas, ball_xy, pin_xy, (255, 255, 0), 1)

    cv2.rectangle(canvas, (4, 62), (min(canvas.shape[1] - 4, 350), 88), (0, 0, 0), -1)
    cv2.putText(
        canvas,
        f"v2 {scale:.4f} yd/px | pin {distance:.1f} yd | objects {len(objects)}",
        (8, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        (255, 255, 255),
        1,
        cv2.LINE_AA,
    )

    path = out_dir / "latest_debug_v2.png"
    cv2.imwrite(str(path), canvas)
    cv2.imwrite(str(out_dir / "latest_crop_v2.png"), roi)
    return path


def main() -> int:
    args = parse_args()
    if args.distance <= 0:
        print("ERROR: --distance must be > 0", file=sys.stderr)
        return 1

    try:
        roi, ball, pin, retries = detect_with_optional_zoom(args)
        objects, pin_pixels, scale = build_penalty_objects(
            roi=roi,
            ball=ball,
            pin=pin,
            distance_to_pin_yds=args.distance,
            corridor_half_width_yds=args.corridor,
            centerline_band_yds=args.centerline_band,
            merge_gap_yds=args.merge_gap,
        )

        result = ProbeV2Result(
            distance_to_pin_yds=args.distance,
            ball_pixel=ball,
            pin_pixel=pin,
            pixels_ball_to_pin=pin_pixels,
            yards_per_pixel=scale,
            penalty_objects=objects,
            zoom_retries_used=retries,
        )
        debug = write_debug(roi, ball, pin, objects, scale, args.distance, Path(args.debug_dir))

        if args.json:
            print(json.dumps(asdict(result), indent=2))
        else:
            print_result(result, args.corridor)
            print(f"\nDebug image: {debug}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
