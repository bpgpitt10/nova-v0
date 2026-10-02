#!/usr/bin/env python3
"""
GSPro Minimap Hazard Probe (POC)

Goal:
- Capture/crop the GSPro minimap.
- Detect the player marker and pin marker.
- Use GSPro DistanceToPin to calibrate the current minimap zoom.
- Extract red penalty-area boundaries.
- Report penalty geometry in yards relative to the ball->pin line.

This is intentionally isolated from Looper app code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np

DEFAULT_ROI = (0.848, 0.520, 0.995, 0.960)  # normalized x1,y1,x2,y2 from current GSPro layout
DEFAULT_CORRIDOR_HALF_WIDTH_YDS = 40.0


@dataclass
class Point:
    x: float
    y: float


@dataclass
class HazardSummary:
    component_id: int
    nearest_distance_yds: float
    farthest_distance_yds: float
    forward_min_yds: float
    forward_max_yds: float
    lateral_min_yds: float
    lateral_max_yds: float
    median_lateral_yds: float
    corridor_entry_yds: float | None


@dataclass
class ProbeResult:
    distance_to_pin_yds: float
    ball_pixel: Point
    pin_pixel: Point
    pixels_ball_to_pin: float
    yards_per_pixel: float
    penalty_components: list[HazardSummary]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro minimap hazard geometry POC")
    source = p.add_mutually_exclusive_group(required=False)
    source.add_argument("--image", help="Analyze an existing screenshot.")
    source.add_argument("--capture", action="store_true", help="Capture the selected monitor once.")
    p.add_argument("--watch", type=float, metavar="SECONDS",
                   help="Continuously capture and re-run every N seconds (implies --capture).")
    p.add_argument("--monitor", type=int, default=1,
                   help="mss monitor index for live capture. Default: 1")
    p.add_argument("--distance", type=float,
                   help="Distance to pin in yards. Overrides currentRound.dat.")
    p.add_argument("--current-round",
                   help="Explicit currentRound.dat path. Otherwise auto-discovers the normal GSPro path.")
    p.add_argument("--roi",
                   help="Override minimap crop as x,y,w,h in SCREEN pixels.")
    p.add_argument("--corridor", type=float, default=DEFAULT_CORRIDOR_HALF_WIDTH_YDS,
                   help="Half-width in yards for target-line hazard entry. Default: 40")
    p.add_argument("--debug-dir", default=str(Path(__file__).with_name("output")),
                   help="Where to save crop/debug images.")
    p.add_argument("--json", action="store_true", help="Print JSON result.")
    return p.parse_args()


def find_current_round(explicit: str | None = None) -> Path | None:
    if explicit:
        p = Path(os.path.expandvars(os.path.expanduser(explicit)))
        return p if p.exists() else None

    home = Path.home()
    direct = home / "AppData" / "LocalLow" / "GSPro" / "GSPro" / "currentRound.dat"
    if direct.exists():
        return direct

    root = home / "AppData" / "LocalLow" / "GSPro"
    if root.exists():
        matches = list(root.rglob("currentRound.dat"))
        if matches:
            return max(matches, key=lambda x: x.stat().st_mtime)
    return None


def load_json_loose(path: Path) -> Any:
    raw = path.read_bytes()
    last_error: Exception | None = None
    for enc in ("utf-8-sig", "utf-16", "utf-8"):
        try:
            return json.loads(raw.decode(enc))
        except Exception as e:
            last_error = e
    raise ValueError(f"Could not parse {path} as JSON: {last_error}")


def recursive_key_values(value: Any, keys: set[str]) -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for k, v in value.items():
            normalized = "".join(ch for ch in k.lower() if ch.isalnum())
            if normalized in keys:
                yield k, v
            yield from recursive_key_values(v, keys)
    elif isinstance(value, list):
        for item in value:
            yield from recursive_key_values(item, keys)


def distance_from_current_round(path: Path) -> float:
    data = load_json_loose(path)
    matches = list(recursive_key_values(
        data,
        {"distancetopin", "disttopin", "pindistance", "distancepin"}
    ))
    for _, v in matches:
        if isinstance(v, (int, float)) and float(v) > 0:
            return float(v)
    raise ValueError(f"No numeric DistanceToPin-like field found in {path}")


def capture_monitor(index: int) -> np.ndarray:
    try:
        import mss
    except ImportError as e:
        raise RuntimeError("Live capture requires `mss`. Run: pip install -r tools/minimap_probe/requirements.txt") from e

    with mss.mss() as sct:
        if index < 1 or index >= len(sct.monitors):
            raise ValueError(f"Monitor {index} not available. Physical monitor indexes: 1..{len(sct.monitors)-1}")
        shot = np.array(sct.grab(sct.monitors[index]))
        return cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)


def parse_roi_arg(text: str) -> tuple[int, int, int, int]:
    parts = [int(x.strip()) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("--roi must be x,y,w,h")
    return tuple(parts)  # type: ignore[return-value]


def crop_minimap(image: np.ndarray, override: str | None = None) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    h, w = image.shape[:2]
    if override:
        x, y, rw, rh = parse_roi_arg(override)
    else:
        x1, y1, x2, y2 = DEFAULT_ROI
        x, y = int(w * x1), int(h * y1)
        rw, rh = int(w * x2) - x, int(h * y2) - y
    if x < 0 or y < 0 or rw <= 0 or rh <= 0 or x + rw > w or y + rh > h:
        raise ValueError(f"Invalid minimap ROI {(x, y, rw, rh)} for screenshot {w}x{h}")
    return image[y:y+rh, x:x+rw].copy(), (x, y, rw, rh)


def contour_circularity(c: np.ndarray) -> float:
    area = cv2.contourArea(c)
    perimeter = cv2.arcLength(c, True)
    return (4 * math.pi * area / (perimeter * perimeter)) if perimeter > 0 else 0.0


def detect_ball_marker(roi: np.ndarray) -> Point:
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


def detect_pin_marker(roi: np.ndarray) -> Point:
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


def penalty_mask(roi: np.ndarray) -> np.ndarray:
    """
    GSPro red boundary lines are penalty-area boundaries (red-stake equivalent).
    Use high-saturation red hue; explicitly reject magenta/purple targeting UI.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 170, 120]), np.array([8, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([175, 170, 120]), np.array([179, 255, 255]))
    mask = cv2.bitwise_or(m1, m2)

    b, g, r = cv2.split(roi)
    magenta_like = ((b.astype(np.int16) - g.astype(np.int16)) > 80) & (b > 100)
    mask[magenta_like] = 0

    H = mask.shape[0]
    mask[: int(H * 0.11), :] = 0
    mask[int(H * 0.90):, :] = 0
    return mask


def analyze_penalties(
    roi: np.ndarray,
    ball: Point,
    pin: Point,
    distance_to_pin_yds: float,
    corridor_half_width_yds: float,
) -> ProbeResult:
    b = np.array([ball.x, ball.y], dtype=float)
    p = np.array([pin.x, pin.y], dtype=float)
    vec = p - b
    pin_pixels = float(np.linalg.norm(vec))
    if pin_pixels < 5:
        raise RuntimeError("Ball/pin pixel separation is implausibly small.")

    scale = distance_to_pin_yds / pin_pixels
    forward_unit = vec / pin_pixels
    right_unit = np.array([-forward_unit[1], forward_unit[0]])

    raw = penalty_mask(roi)
    closed = cv2.morphologyEx(
        raw,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(closed, 8)

    summaries: list[HazardSummary] = []
    next_id = 1

    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if area < 25 or max(w, h) < 15:
            continue

        ys, xs = np.where(labels == label)
        pts = np.column_stack([xs, ys]).astype(float)
        delta = pts - b
        forward = (delta @ forward_unit) * scale
        lateral = (delta @ right_unit) * scale
        euclidean = np.linalg.norm(delta, axis=1) * scale

        ahead = forward > 0
        if int(ahead.sum()) < 10:
            continue

        corridor = ahead & (np.abs(lateral) <= corridor_half_width_yds)
        corridor_entry = float(np.min(forward[corridor])) if np.any(corridor) else None

        summaries.append(HazardSummary(
            component_id=next_id,
            nearest_distance_yds=float(np.min(euclidean[ahead])),
            farthest_distance_yds=float(np.max(euclidean[ahead])),
            forward_min_yds=float(np.min(forward[ahead])),
            forward_max_yds=float(np.max(forward[ahead])),
            lateral_min_yds=float(np.min(lateral[ahead])),
            lateral_max_yds=float(np.max(lateral[ahead])),
            median_lateral_yds=float(np.median(lateral[ahead])),
            corridor_entry_yds=corridor_entry,
        ))
        next_id += 1

    summaries.sort(key=lambda s: s.nearest_distance_yds)

    return ProbeResult(
        distance_to_pin_yds=distance_to_pin_yds,
        ball_pixel=ball,
        pin_pixel=pin,
        pixels_ball_to_pin=pin_pixels,
        yards_per_pixel=scale,
        penalty_components=summaries,
    )


def side_label(v: float) -> str:
    if abs(v) < 3:
        return "center"
    return f"{abs(v):.0f} yd {'right' if v > 0 else 'left'}"


def print_result(result: ProbeResult, corridor: float) -> None:
    print()
    print("GSPro MINIMAP HAZARD PROBE")
    print("=" * 31)
    print(f"Pin distance:       {result.distance_to_pin_yds:.1f} yd")
    print(f"Ball -> pin pixels: {result.pixels_ball_to_pin:.1f} px")
    print(f"Map scale:          {result.yards_per_pixel:.4f} yd/px")
    print(f"Ball pixel:         ({result.ball_pixel.x:.1f}, {result.ball_pixel.y:.1f})")
    print(f"Pin pixel:          ({result.pin_pixel.x:.1f}, {result.pin_pixel.y:.1f})")
    print()
    print(f"Penalty-area boundaries ({len(result.penalty_components)} components):")
    if not result.penalty_components:
        print("  None detected in visible minimap.")
        return

    for h in result.penalty_components:
        lat = side_label(h.median_lateral_yds)
        corridor_text = (
            f"; enters ±{corridor:.0f} yd target corridor at {h.corridor_entry_yds:.0f} yd"
            if h.corridor_entry_yds is not None else
            f"; stays outside ±{corridor:.0f} yd target corridor"
        )
        print(
            f"  #{h.component_id}: nearest {h.nearest_distance_yds:.0f} yd; "
            f"forward {h.forward_min_yds:.0f}-{h.forward_max_yds:.0f} yd; "
            f"mostly {lat}{corridor_text}"
        )


def write_debug(
    roi: np.ndarray,
    result: ProbeResult,
    out_dir: Path,
    source_hash: str,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    canvas = roi.copy()
    mask = penalty_mask(roi)

    overlay = canvas.copy()
    overlay[mask > 0] = (0, 0, 255)
    canvas = cv2.addWeighted(canvas, 0.75, overlay, 0.25, 0)

    ball = (round(result.ball_pixel.x), round(result.ball_pixel.y))
    pin = (round(result.pin_pixel.x), round(result.pin_pixel.y))
    cv2.circle(canvas, ball, 9, (0, 255, 255), 2)
    cv2.circle(canvas, pin, 9, (255, 255, 0), 2)
    cv2.line(canvas, ball, pin, (255, 255, 0), 1)

    text = f"{result.yards_per_pixel:.4f} yd/px | pin {result.distance_to_pin_yds:.1f} yd"
    cv2.rectangle(canvas, (4, 62), (min(canvas.shape[1]-4, 290), 86), (0, 0, 0), -1)
    cv2.putText(canvas, text, (8, 79), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)

    path = out_dir / f"probe_{source_hash[:10]}.png"
    cv2.imwrite(str(path), canvas)
    return path


def analyze_image(image: np.ndarray, distance: float, roi_override: str | None, corridor: float, debug_dir: Path) -> tuple[ProbeResult, Path]:
    roi, _ = crop_minimap(image, roi_override)
    debug_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(debug_dir / "latest_crop.png"), roi)

    ball = detect_ball_marker(roi)
    pin = detect_pin_marker(roi)
    result = analyze_penalties(roi, ball, pin, distance, corridor)

    digest = hashlib.sha1(roi.tobytes()).hexdigest()
    debug = write_debug(roi, result, debug_dir, digest)
    cv2.imwrite(str(debug_dir / "latest_debug.png"), cv2.imread(str(debug)))
    return result, debug


def resolve_distance(args: argparse.Namespace) -> tuple[float, str]:
    if args.distance is not None:
        if args.distance <= 0:
            raise ValueError("--distance must be > 0")
        return float(args.distance), "CLI"

    path = find_current_round(args.current_round)
    if not path:
        raise RuntimeError(
            "Could not find currentRound.dat. Pass --distance for screenshot testing "
            "or --current-round with the explicit GSPro path."
        )
    return distance_from_current_round(path), str(path)


def load_image_file(path: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        raise ValueError(f"Could not open image: {path}")
    return img


def main() -> int:
    args = parse_args()
    debug_dir = Path(args.debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)

    try:
        distance, distance_source = resolve_distance(args)
        print(f"Distance source: {distance_source}")

        if args.image:
            img = load_image_file(args.image)
            result, debug = analyze_image(img, distance, args.roi, args.corridor, debug_dir)
            if args.json:
                print(json.dumps(asdict(result), indent=2))
            else:
                print_result(result, args.corridor)
                print(f"\nDebug image: {debug}")
            return 0

        interval = args.watch if args.watch is not None else None
        last_signature: str | None = None

        while True:
            if args.distance is None:
                distance, distance_source = resolve_distance(args)

            img = capture_monitor(args.monitor)
            signature = hashlib.sha1(img.tobytes()).hexdigest() + f":{distance:.4f}"
            if signature != last_signature:
                result, debug = analyze_image(img, distance, args.roi, args.corridor, debug_dir)
                if args.json:
                    print(json.dumps(asdict(result), indent=2))
                else:
                    print_result(result, args.corridor)
                    print(f"\nDebug image: {debug}")
                last_signature = signature

            if interval is None:
                break
            time.sleep(max(0.5, interval))

        return 0

    except KeyboardInterrupt:
        return 130
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
