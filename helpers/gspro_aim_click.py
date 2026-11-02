"""Auto Aim step 2: put Looper's aim into GSPro with ONE minimap click.

Only runs when the golfer presses Arm in Looper (an explicit, per-shot action),
and only if every check passes on a fresh capture of GSPro's window:

1. GSPro is connected, not minimized, DPI-safe (gspro_direct_click preflight).
2. The minimap shows the red ball dot and white pin dot lined up the way GSPro
   draws them, so the world -> minimap mapping for THIS frame is fixed by two
   known points (gspro_native_aim, the same code as the read-only preview).
3. The target lands inside the minimap with a safe margin, so the click can
   never hit a GSPro button.
4. The capture is under a second old when the click is planned, and the window
   has not moved or changed since.

The click restores the cursor to where it was. Afterwards the minimap is
captured again and GSPro's magenta aim reticle is looked for near the target,
so Looper can say whether the aim really landed.
"""
from __future__ import annotations

import math
import time
from typing import Callable

import cv2
import numpy as np

import gspro_direct_click as direct_click
import gspro_native_aim as native_aim

SCHEMA_VERSION = "looper-companion-aim-click-v1"
# GSPro's aim reticle is a magenta crosshair (FarmLinks screenshots, Nov 2026).
MAGENTA_LOW = np.array([138, 110, 120])
MAGENTA_HIGH = np.array([172, 255, 255])
MIN_MARKER_PIXELS = 12
VERIFY_MATCH_PX = 8.0
VERIFY_DELAY_S = 0.3
CAPTURE_ATTEMPTS = 4


def find_aim_marker(crop_bgr: np.ndarray):
    """Centre of GSPro's magenta aim reticle on the minimap crop, or None."""
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, MAGENTA_LOW, MAGENTA_HIGH)
    count, _, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    best = None
    for i in range(1, count):
        area = stats[i, cv2.CC_STAT_AREA]
        if area >= MIN_MARKER_PIXELS and (best is None or area > best[0]):
            best = (area, centroids[i])
    if best is None:
        return None
    return native_aim.Pixel(float(best[1][0]), float(best[1][1]))


def _capture(capture: Callable[[dict], np.ndarray], window: dict, sleep: Callable[[float], None]):
    last_error: Exception | None = None
    for _ in range(CAPTURE_ATTEMPTS):
        try:
            return capture(window)
        except Exception as error:  # capture lock busy with an observation read
            last_error = error
            sleep(0.12)
    raise RuntimeError(f"GSPro capture unavailable: {last_error}")


def aim_click(
    *,
    ball_world: tuple[float, float],
    pin_world: tuple[float, float],
    target_world: tuple[float, float],
    shot_key: str,
    find_window: Callable[[], dict],
    capture: Callable[[dict], np.ndarray],
    click: Callable[..., None],
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """Plan, click and verify. Never raises; returns a status for the page."""
    def blocked(reason: str, **extra) -> dict:
        return {"schemaVersion": SCHEMA_VERSION, "status": "blocked", "reason": reason, **extra}

    for value in (*ball_world, *pin_world, *target_world):
        if not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e6:
            return blocked("invalid-request")
    if not isinstance(shot_key, str) or not shot_key.strip() or len(shot_key) > 160:
        return blocked("missing-shot")

    window = find_window()
    if not isinstance(window, dict) or window.get("status") != "connected":
        return blocked("gspro-not-connected")
    if window.get("minimized"):
        return blocked("gspro-minimized")

    started = now()
    try:
        frame = _capture(capture, window, sleep)
        preview = native_aim.aim_preview(
            frame, ball_world=ball_world, pin_world=pin_world, target_world=target_world)
    except Exception as error:
        return blocked("minimap-not-read", detail=str(error)[:160])
    if preview.get("status") != "ready":
        return blocked(preview.get("status") or "minimap-not-read")
    if not preview["checks"]["alignedLikeGspro"]:
        return blocked("minimap-not-aligned")

    height, width = frame.shape[:2]
    roi = native_aim.RIGHT_MINIMAP_ROI
    x0, y0 = int(width * roi[0]), int(height * roi[1])
    mini = preview["minimap"]
    try:
        plan = direct_click.prepare_verified_minimap_click(
            window=window,
            minimap_roi=(x0, y0, mini["width"], mini["height"]),
            target_roi_px=tuple(mini["target"]),
            snapshot_age_ms=(now() - started) * 1000,
            # Two-point fit: ball and pin dots match their world points exactly;
            # the vertical-alignment check above is what validates the frame.
            pin_registration_error_px=0.0,
            shot_key=shot_key,
            ui_confirmed=True,
        )
    except ValueError as error:
        return blocked("preflight-failed", detail=str(error)[:160])

    try:
        click(plan, latest_window=find_window, allow_native_input=True)
    except Exception as error:
        return blocked("click-failed", detail=str(error)[:160])

    result = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "clicked",
        "click": {"desktopX": plan.desktop_x, "desktopY": plan.desktop_y},
        "minimap": mini,
        "verified": "not-checked",
    }
    sleep(VERIFY_DELAY_S)
    try:
        after = _capture(capture, find_window(), sleep)
        crop, _ = native_aim.crop_minimap(after)
        marker = find_aim_marker(crop)
    except Exception:
        return result
    if marker is None:
        result["verified"] = "marker-not-seen"
        return result
    offset = math.hypot(marker.x - mini["target"][0], marker.y - mini["target"][1])
    result["markerOffsetPx"] = round(offset, 1)
    result["markerPixel"] = [round(marker.x, 1), round(marker.y, 1)]
    result["verified"] = "match" if offset <= VERIFY_MATCH_PX else "mismatch"
    return result
