#!/usr/bin/env python3
"""GSPro minimap absolute-click validation lab.

This is intentionally isolated from Looper Live Caddie. It answers one mechanical
question only: given a desired course-space target point, can we predict the
corresponding GSPro minimap pixel and click it accurately?

Safety model:
- preview-only by default; no mouse input unless --click is explicitly supplied;
- never changes minimap zoom or sends aim-arrow keys;
- requires reliable ball + pin marker detection in the current minimap frame;
- requires the predicted point to fall inside the detected minimap ROI;
- requires a verified GSPro foreground window before mouse input;
- sends exactly one left click, then restores the user's cursor position;
- saves before / preview / after evidence and a JSON result for every run.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes
import json
import math
import os
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

import aim_actuator
import probe as base
import probe_v2 as v2
import target_card
import target_cards_v6

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

@dataclass
class Pair:
    x: float
    y: float

@dataclass
class CaptureFrame:
    image: np.ndarray
    monitor_left: int
    monitor_top: int
    monitor_width: int
    monitor_height: int

@dataclass
class ClickLabResult:
    mode: str
    clicked: bool
    gspro_window_title: str | None
    distance_to_pin_yds: float
    distance_source: str
    ball_pixel_roi: Pair
    pin_pixel_roi: Pair
    predicted_pixel_roi: Pair
    predicted_pixel_screen: Pair
    predicted_pixel_desktop: Pair
    minimap_roi_screen: tuple[int, int, int, int]
    yards_per_pixel: float
    target_right_yds: float
    target_forward_yds: float
    expected_target_distance_yds: float
    aim_card_distance_yds: float | None
    aim_card_distance_error_yds: float | None
    verification: str
    warnings: list[str]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Guarded GSPro minimap click validation lab")
    parser.add_argument("--monitor", type=int, default=1)
    parser.add_argument("--roi", help="Optional minimap crop x,y,w,h in monitor screenshot pixels.")
    parser.add_argument("--distance", type=float, help="Manual distance-to-pin fallback/override in yards.")
    parser.add_argument("--tesseract", help="Explicit tesseract.exe path if auto-discovery fails.")
    parser.add_argument("--right", type=float, help="Target yards right (+) / left (-) of live ball->pin line.")
    parser.add_argument("--forward", type=float, help="Target yards forward from live ball position.")
    parser.add_argument("--ball-course", help="Absolute Looper ball coordinate x,y yards.")
    parser.add_argument("--pin-course", help="Absolute Looper pin coordinate x,y yards.")
    parser.add_argument("--target-course", help="Absolute Looper target coordinate x,y yards.")
    parser.add_argument("--click", action="store_true", help="Actually click once. Omit for preview only.")
    parser.add_argument("--settle-ms", type=float, default=350.0)
    parser.add_argument("--verify-tolerance", type=float, default=3.0)
    parser.add_argument("--edge-margin", type=float, default=3.0)
    parser.add_argument("--debug-dir", default=str(Path(__file__).with_name("output") / "click_lab"))
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()

def parse_pair(text: str, label: str) -> Pair:
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 2:
        raise ValueError(f"{label} must be x,y")
    return Pair(float(parts[0]), float(parts[1]))

def _fixed_ocr(image, tesseract_exe: str, whitelist: str, psm: str = "7") -> str:
    prepared = target_card._prep_ocr(image)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        cv2.imwrite(tmp_path, prepared)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        completed = subprocess.run(
            [tesseract_exe, tmp_path, "stdout", "--psm", psm, "-c", f"tessedit_char_whitelist={whitelist}"],
            capture_output=True,
            text=True,
            creationflags=creationflags,
            timeout=8,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"Tesseract exited {completed.returncode}")
        return completed.stdout.strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

target_card._ocr = _fixed_ocr

def capture_monitor(index: int) -> CaptureFrame:
    try:
        import mss
    except ImportError as exc:
        raise RuntimeError("Live capture requires mss. Install tools/minimap_probe/requirements.txt") from exc
    with mss.mss() as sct:
        if index < 1 or index >= len(sct.monitors):
            raise ValueError(f"Monitor {index} unavailable. Valid physical indexes: 1..{len(sct.monitors)-1}")
        monitor = sct.monitors[index]
        raw = np.array(sct.grab(monitor))
        return CaptureFrame(
            image=cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR),
            monitor_left=int(monitor["left"]),
            monitor_top=int(monitor["top"]),
            monitor_width=int(monitor["width"]),
            monitor_height=int(monitor["height"]),
        )

def read_pin_distance(screen: np.ndarray, explicit_distance: float | None, tesseract_path: str | None, debug_dir: Path):
    warnings: list[str] = []
    if explicit_distance is not None:
        if explicit_distance <= 0:
            raise ValueError("--distance must be > 0")
        return float(explicit_distance), "CLI override", warnings
    states = target_cards_v6.read_cards(screen, tesseract_path=tesseract_path, debug_dir=debug_dir)
    pin = states.get("pin")
    if pin is None:
        raise RuntimeError("Could not read the white GSPro PIN card. Use --distance only as a deliberate lab fallback.")
    return float(pin.distance_yds), pin.source, warnings

def unit(dx: float, dy: float):
    length = math.hypot(dx, dy)
    if length < 1e-9:
        raise ValueError("Cannot build a frame from coincident points")
    return dx / length, dy / length

def resolve_target_components(args: argparse.Namespace, distance_to_pin_yds: float):
    absolute_values = [args.ball_course, args.pin_course, args.target_course]
    uses_absolute = any(value is not None for value in absolute_values)
    if uses_absolute:
        if not all(value is not None for value in absolute_values):
            raise ValueError("Absolute mode requires --ball-course, --pin-course, and --target-course together.")
        if args.right is not None or args.forward is not None:
            raise ValueError("Use absolute course coordinates OR --right/--forward, not both.")
        ball = parse_pair(args.ball_course, "--ball-course")
        pin = parse_pair(args.pin_course, "--pin-course")
        target = parse_pair(args.target_course, "--target-course")
        fx, fy = unit(pin.x - ball.x, pin.y - ball.y)
        rx, ry = fy, -fx
        dx = target.x - ball.x
        dy = target.y - ball.y
        right_yds = dx * rx + dy * ry
        forward_yds = dx * fx + dy * fy
        expected_distance = math.hypot(dx, dy)
        course_pin_distance = math.hypot(pin.x - ball.x, pin.y - ball.y)
        if abs(course_pin_distance - distance_to_pin_yds) > 8:
            raise RuntimeError(
                f"Looper coordinates imply {course_pin_distance:.1f} yd to pin but GSPro shows "
                f"{distance_to_pin_yds:.1f} yd; refusing an ambiguous absolute transform."
            )
        return right_yds, forward_yds, expected_distance, "absolute-course"
    if args.right is None or args.forward is None:
        raise ValueError("Supply --right AND --forward, or all three absolute course coordinates.")
    right_yds = float(args.right)
    forward_yds = float(args.forward)
    return right_yds, forward_yds, math.hypot(right_yds, forward_yds), "right-forward"

def predict_minimap_pixel(ball: base.Point, pin: base.Point, distance_to_pin_yds: float, right_yds: float, forward_yds: float):
    dx = pin.x - ball.x
    dy = pin.y - ball.y
    pixels_to_pin = math.hypot(dx, dy)
    if pixels_to_pin < 20:
        raise RuntimeError(f"Ball/pin separation only {pixels_to_pin:.1f}px; registration is unreliable.")
    yards_per_pixel = distance_to_pin_yds / pixels_to_pin
    if not (0.03 <= yards_per_pixel <= 3.0):
        raise RuntimeError(f"Implausible minimap scale {yards_per_pixel:.4f} yd/px")
    sfx, sfy = dx / pixels_to_pin, dy / pixels_to_pin
    srx, sry = -sfy, sfx
    target_x = ball.x + (forward_yds / yards_per_pixel) * sfx + (right_yds / yards_per_pixel) * srx
    target_y = ball.y + (forward_yds / yards_per_pixel) * sfy + (right_yds / yards_per_pixel) * sry
    return base.Point(target_x, target_y), yards_per_pixel

def annotate_preview(screen, roi_box, ball, pin, predicted, expected_distance_yds):
    annotated = screen.copy()
    x, y, w, h = roi_box
    cv2.rectangle(annotated, (x, y), (x + w, y + h), (255, 255, 0), 2)
    to_screen = lambda p: (int(round(x + p.x)), int(round(y + p.y)))
    ball_xy, pin_xy, target_xy = to_screen(ball), to_screen(pin), to_screen(predicted)
    cv2.circle(annotated, ball_xy, 7, (255, 255, 255), 2)
    cv2.circle(annotated, pin_xy, 7, (255, 255, 255), 2)
    cv2.drawMarker(annotated, target_xy, (0, 255, 255), cv2.MARKER_CROSS, 24, 3)
    cv2.line(annotated, ball_xy, target_xy, (0, 255, 255), 2)
    cv2.putText(annotated, f"CLICK LAB {expected_distance_yds:.1f} yd",
                (max(12, target_xy[0] - 150), max(30, target_xy[1] - 18)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2, cv2.LINE_AA)
    return annotated

def get_window_rect(hwnd: int):
    if os.name != "nt":
        raise RuntimeError("GSPro mouse actuation is Windows-only.")
    rect = ctypes.wintypes.RECT()
    user32 = ctypes.windll.user32
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("Could not read GSPro window bounds.")
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)

def click_once_and_restore(hwnd: int, desktop_x: int, desktop_y: int):
    if not aim_actuator.focus_gspro(hwnd, wait_s=0.03):
        raise RuntimeError("Could not safely focus GSPro; no mouse input sent.")
    user32 = ctypes.windll.user32
    if int(user32.GetForegroundWindow()) != int(hwnd):
        raise RuntimeError("GSPro is not foreground; no mouse input sent.")
    original = ctypes.wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(original)):
        raise RuntimeError("Could not read cursor position; no mouse input sent.")
    try:
        if not user32.SetCursorPos(int(desktop_x), int(desktop_y)):
            raise RuntimeError("Could not move cursor to predicted minimap point.")
        time.sleep(0.025)
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.025)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    finally:
        time.sleep(0.025)
        user32.SetCursorPos(int(original.x), int(original.y))

def verify_after_click(screen, tesseract_path, debug_dir, expected_distance_yds, tolerance_yds):
    try:
        states = target_cards_v6.read_cards(screen, tesseract_path=tesseract_path, debug_dir=debug_dir)
        aim = states.get("aim")
        if aim is None:
            return None, None, "UNVERIFIED", ["AIM card was not detected after click."]
        observed = float(aim.distance_yds)
        error = observed - expected_distance_yds
        status = "PASS_DISTANCE" if abs(error) <= tolerance_yds else "FAIL_DISTANCE"
        return observed, error, status, []
    except Exception as exc:
        return None, None, "UNVERIFIED", [f"AIM-card verification failed: {exc}"]

def main() -> int:
    args = parse_args()
    debug_dir = Path(args.debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)
    before = capture_monitor(args.monitor)
    cv2.imwrite(str(debug_dir / "latest_click_lab_before.png"), before.image)
    distance_to_pin, distance_source, warnings = read_pin_distance(before.image, args.distance, args.tesseract, debug_dir)
    roi, roi_box = base.crop_minimap(before.image, args.roi)
    cv2.imwrite(str(debug_dir / "latest_click_lab_minimap.png"), roi)
    ball = v2.detect_ball_marker(roi)
    pin = v2.detect_pin_marker(roi)
    right_yds, forward_yds, expected_distance, mode = resolve_target_components(args, distance_to_pin)
    predicted, yards_per_pixel = predict_minimap_pixel(ball, pin, distance_to_pin, right_yds, forward_yds)
    margin = max(0.0, float(args.edge_margin))
    roi_h, roi_w = roi.shape[:2]
    if not (margin <= predicted.x <= roi_w - 1 - margin and margin <= predicted.y <= roi_h - 1 - margin):
        raise RuntimeError(
            f"Predicted target ({predicted.x:.1f},{predicted.y:.1f}) falls outside safe minimap interior "
            f"({roi_w}x{roi_h}, margin {margin:.1f}px); refusing to click."
        )
    roi_x, roi_y, _, _ = roi_box
    screen_x = roi_x + predicted.x
    screen_y = roi_y + predicted.y
    desktop_x = before.monitor_left + screen_x
    desktop_y = before.monitor_top + screen_y
    preview = annotate_preview(before.image, roi_box, ball, pin, predicted, expected_distance)
    cv2.imwrite(str(debug_dir / "latest_click_lab_preview.png"), preview)
    found = aim_actuator.find_gspro_window()
    title = found[1] if found else None
    clicked = False
    observed = None
    error = None
    verification = "PREVIEW_ONLY"
    if args.click:
        if found is None:
            raise RuntimeError("Could not find visible GSPro window; no mouse input sent.")
        hwnd, title = found
        left, top, right, bottom = get_window_rect(hwnd)
        if not (left <= desktop_x < right and top <= desktop_y < bottom):
            raise RuntimeError(
                f"Predicted desktop point ({desktop_x:.0f},{desktop_y:.0f}) is outside GSPro window "
                f"({left},{top})-({right},{bottom}); refusing to click."
            )
        click_once_and_restore(hwnd, int(round(desktop_x)), int(round(desktop_y)))
        clicked = True
        time.sleep(max(0.0, float(args.settle_ms)) / 1000.0)
        after = capture_monitor(args.monitor)
        cv2.imwrite(str(debug_dir / "latest_click_lab_after.png"), after.image)
        observed, error, verification, verify_warnings = verify_after_click(
            after.image, args.tesseract, debug_dir, expected_distance, max(0.0, float(args.verify_tolerance))
        )
        warnings.extend(verify_warnings)
    result = ClickLabResult(
        mode=mode,
        clicked=clicked,
        gspro_window_title=title,
        distance_to_pin_yds=distance_to_pin,
        distance_source=distance_source,
        ball_pixel_roi=Pair(ball.x, ball.y),
        pin_pixel_roi=Pair(pin.x, pin.y),
        predicted_pixel_roi=Pair(predicted.x, predicted.y),
        predicted_pixel_screen=Pair(screen_x, screen_y),
        predicted_pixel_desktop=Pair(desktop_x, desktop_y),
        minimap_roi_screen=roi_box,
        yards_per_pixel=yards_per_pixel,
        target_right_yds=right_yds,
        target_forward_yds=forward_yds,
        expected_target_distance_yds=expected_distance,
        aim_card_distance_yds=observed,
        aim_card_distance_error_yds=error,
        verification=verification,
        warnings=warnings,
    )
    payload = asdict(result)
    (debug_dir / "latest_click_lab_result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("\nGSPro MINIMAP CLICK LAB\n=======================")
    print(f"Mode:                 {result.mode}")
    print(f"GSPro:                {result.gspro_window_title or 'not found'}")
    print(f"Pin distance:         {result.distance_to_pin_yds:.1f} yd [{result.distance_source}]")
    print(f"Map scale:            {result.yards_per_pixel:.4f} yd/px")
    print(f"Target:               {result.target_forward_yds:.1f} yd forward, {result.target_right_yds:+.1f} yd right")
    print(f"Expected distance:    {result.expected_target_distance_yds:.1f} yd")
    print(f"Predicted ROI pixel:  ({result.predicted_pixel_roi.x:.1f}, {result.predicted_pixel_roi.y:.1f})")
    print(f"Desktop click pixel:  ({result.predicted_pixel_desktop.x:.0f}, {result.predicted_pixel_desktop.y:.0f})")
    print(f"Action:               {'ONE CLICK SENT' if result.clicked else 'PREVIEW ONLY — NO INPUT SENT'}")
    if result.clicked:
        if observed is not None:
            print(f"GSPro AIM distance:   {observed:.1f} yd")
            print(f"Distance error:       {error:+.1f} yd")
        print(f"Verification:         {verification}")
    print(f"Evidence:             {debug_dir}")
    for warning in warnings:
        print(f"WARNING:              {warning}")
    if args.json:
        print(json.dumps(payload, indent=2))
    return 2 if verification == "FAIL_DISTANCE" else 0

if __name__ == "__main__":
    raise SystemExit(main())
