"""Offline-verifiable plan for ONE GSPro minimap click.

Not exposed as HTTP or enabled by the installed companion. The old physical
proof is the authority for pixel registration/marker verification; this module
merely handles the final, strict Win32 window-relative -> desktop point contract.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
import ctypes
from ctypes import wintypes
import math
import os
import time

MAX_CAPTURE_AGE_MS = 1000
MAX_PIN_REGISTRATION_ERROR_PX = 3.0
MIN_MINIMAP_MARGIN_PX = 5.0


@dataclass(frozen=True)
class ClickPreflight:
    hwnd: int
    pid: int
    desktop_x: int
    desktop_y: int
    bounds: tuple[int, int, int, int]
    shot_key: str
    verified_pin_error_px: float


def prepare_verified_minimap_click(
    *,
    window: dict,
    minimap_roi: tuple[float, float, float, float],
    target_roi_px: tuple[float, float],
    snapshot_age_ms: float,
    pin_registration_error_px: float,
    shot_key: str,
    ui_confirmed: bool,
) -> ClickPreflight:
    """Return a fixed click plan only when *every* aim safety condition holds.

    ROI and point are measured in captured GSPro WINDOW-relative pixels;
    ROI can move per window size / display scale. It is not a fixed monitor crop.
    """
    if window.get("status") != "connected":
        raise ValueError("GSPro is not connected")
    if window.get("minimized"):
        raise ValueError("GSPro is minimized")
    if window.get("dpiAwareness") != "per-monitor":
        raise ValueError("Native GSPro coordinates are not per-monitor DPI safe")
    if not isinstance(window.get("hwnd"), int) or window["hwnd"] <= 0:
        raise ValueError("Unverified GSPro HWND")
    if not isinstance(window.get("pid"), int) or window["pid"] <= 0:
        raise ValueError("Unverified GSPro PID")
    if not ui_confirmed:
        raise ValueError("User has not explicitly armed this shot")
    if not isinstance(shot_key, str) or not shot_key.strip() or len(shot_key) > 160:
        raise ValueError("Missing stable shot identity")

    if not math.isfinite(snapshot_age_ms) or not (0 <= snapshot_age_ms <= MAX_CAPTURE_AGE_MS):
        raise ValueError("GSPro capture is stale")
    if not math.isfinite(pin_registration_error_px) or not (
        0 <= pin_registration_error_px <= MAX_PIN_REGISTRATION_ERROR_PX
    ):
        raise ValueError("Minimap pin registration failed")

    bounds = window.get("bounds") or {}
    left = bounds.get("left")
    top = bounds.get("top")
    width = bounds.get("width")
    height = bounds.get("height")
    if not all(isinstance(v, int) for v in (left, top, width, height)):
        raise ValueError("Window geometry unavailable")
    if width < 300 or height < 200:
        raise ValueError("Invalid GSPro window bounds")

    if len(minimap_roi) != 4 or len(target_roi_px) != 2:
        raise ValueError("Invalid minimap point")
    x0, y0, roi_w, roi_h = minimap_roi
    tx, ty = target_roi_px
    if not all(math.isfinite(float(v)) for v in (x0, y0, roi_w, roi_h, tx, ty)):
        raise ValueError("Non-finite minimap coordinates")
    if not (
        0 <= x0 < width and 0 <= y0 < height
        and roi_w > MIN_MINIMAP_MARGIN_PX * 2
        and roi_h > MIN_MINIMAP_MARGIN_PX * 2
        and x0 + roi_w <= width and y0 + roi_h <= height
    ):
        raise ValueError("Minimap ROI outside GSPro window")
    if not (
        MIN_MINIMAP_MARGIN_PX <= tx < roi_w - MIN_MINIMAP_MARGIN_PX
        and MIN_MINIMAP_MARGIN_PX <= ty < roi_h - MIN_MINIMAP_MARGIN_PX
    ):
        raise ValueError("Requested target is outside safe minimap interior")

    target_x = int(round(left + x0 + tx))
    target_y = int(round(top + y0 + ty))
    return ClickPreflight(
        hwnd=window["hwnd"],
        pid=window["pid"],
        desktop_x=target_x,
        desktop_y=target_y,
        bounds=(left, top, width, height),
        shot_key=shot_key,
        verified_pin_error_px=pin_registration_error_px,
    )


def execute_prepared_click(
    plan: ClickPreflight,
    *,
    latest_window: Callable[[], dict],
    allow_native_input: bool = False,
) -> None:
    """One-click OS actuator, entirely disconnected from the HTTP server.

    Future activation requires paired browser command + explicit user action,
    fresh shot key / pin registration and a simulator acceptance test. It is
    permanently disabled in Stage B builds because nothing passes True.
    """
    if not allow_native_input:
        raise PermissionError("Auto Aim native input is disabled in this build")
    if os.name != "nt":
        raise RuntimeError("Windows input required")
    current = latest_window()
    if current.get("status") != "connected" or current.get("pid") != plan.pid or current.get("hwnd") != plan.hwnd:
        raise RuntimeError("GSPro window changed after aim planning")
    bounds = current.get("bounds") or {}
    if (bounds.get("left"), bounds.get("top"), bounds.get("width"), bounds.get("height")) != plan.bounds:
        raise RuntimeError("GSPro window moved/resized after aim planning")
    if current.get("minimized"):
        raise RuntimeError("GSPro was minimized")
    if current.get("dpiAwareness") != "per-monitor":
        raise RuntimeError("GSPro DPI awareness changed; no input sent")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetCursorPos.argtypes = [wintypes.INT, wintypes.INT]
    user32.SetCursorPos.restype = wintypes.BOOL
    user32.mouse_event.argtypes = [
        wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        wintypes.DWORD, ctypes.c_size_t,
    ]

    if int(user32.GetForegroundWindow() or 0) != plan.hwnd:
        user32.SetForegroundWindow(plan.hwnd)
        # Windows foreground activation restrictions can deny focus.
        for _ in range(4):
            if int(user32.GetForegroundWindow() or 0) == plan.hwnd:
                break
            time.sleep(0.04)
    if int(user32.GetForegroundWindow() or 0) != plan.hwnd:
        raise RuntimeError("Could not focus GSPro; no input sent")

    old_cursor = wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(old_cursor)):
        raise RuntimeError("Could not save previous cursor position")
    try:
        if not user32.SetCursorPos(plan.desktop_x, plan.desktop_y):
            raise RuntimeError("Could not set cursor to GSPro minimap target")
        # This matches the primitive proven on the simulator in click lab.
        user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
        user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    finally:
        user32.SetCursorPos(old_cursor.x, old_cursor.y)
