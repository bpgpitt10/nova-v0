#!/usr/bin/env python3
"""Controlled GSPro full-shot aim pulses for exposing the live AIM target card.

The read-only live probe may need to make GSPro render its player-colored AIM card.
A human L/R tap is not safe because GSPro aim movement is duration based. This
module therefore:
- focuses a verified GSPro window before sending input;
- sends a measured L pulse followed by the same R pulse;
- captures the scene after each stage;
- estimates residual camera/aim shift with phase correlation;
- applies at most a tiny bounded corrective pulse when the visual measurement is
  reliable;
- refuses speculative correction when confidence is poor.

The caller supplies capture_fn so this module remains independent of the probe's
monitor/screenshot implementation.
"""

from __future__ import annotations

import ctypes
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import cv2
import numpy as np


KEYEVENTF_KEYUP = 0x0002
SW_RESTORE = 9


@dataclass
class AimCorrection:
    key: str
    duration_ms: float
    residual_before_px: float
    residual_after_px: float | None = None


@dataclass
class AimSummonResult:
    attempted: bool
    existing: bool = False
    gspro_window_title: str | None = None
    pulse_ms: float = 0.0
    left_dx_px: float | None = None
    residual_dx_px: float | None = None
    response_left: float | None = None
    response_return: float | None = None
    verified: bool | None = None
    corrections: list[AimCorrection] = field(default_factory=list)
    warning: str | None = None
    final_screen: np.ndarray | None = None


def _require_windows() -> None:
    if os.name != "nt":
        raise RuntimeError("GSPro aim actuation is Windows-only.")


def _window_title(hwnd: int) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value.strip()


def find_gspro_window() -> tuple[int, str] | None:
    """Find a visible top-level window whose title clearly identifies GSPro."""
    _require_windows()
    user32 = ctypes.windll.user32
    matches: list[tuple[int, str]] = []

    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    @callback_type
    def enum_proc(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            title = _window_title(int(hwnd))
            normalized = title.lower().replace(" ", "")
            if "gspro" in normalized:
                matches.append((int(hwnd), title))
        except Exception:
            pass
        return True

    user32.EnumWindows(enum_proc, 0)
    if not matches:
        return None

    # Prefer the largest title-bearing GSPro window if there are launchers/helpers.
    def score(item: tuple[int, str]) -> tuple[int, int]:
        hwnd, title = item
        rect = ctypes.wintypes.RECT() if hasattr(ctypes, "wintypes") else None
        area = 0
        if rect is not None and user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
        return area, len(title)

    return max(matches, key=score)


def focus_gspro(hwnd: int, wait_s: float = 0.10) -> bool:
    """Bring the verified GSPro window foreground and confirm it really owns input."""
    _require_windows()
    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(max(0.0, wait_s))
    return int(user32.GetForegroundWindow()) == int(hwnd)


def pulse_key_windows(key: str, duration_ms: float) -> None:
    """Hold one GSPro aim key for a controlled duration and always release it."""
    _require_windows()
    if not key or len(key) != 1:
        raise ValueError("Aim key must be one character.")
    if duration_ms <= 0:
        raise ValueError("Aim pulse duration must be > 0 ms.")

    vk = ord(key.upper())
    user32 = ctypes.windll.user32
    user32.keybd_event(vk, 0, 0, 0)
    try:
        deadline = time.perf_counter() + duration_ms / 1000.0
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            # Sleep most of the remaining interval; the final millisecond is left to
            # the scheduler rather than busy-spinning the simulator PC.
            time.sleep(max(0.0005, remaining - 0.001))
    finally:
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


def _scene_gray(screen: np.ndarray) -> np.ndarray:
    """Stable lower-center 3D scene ROI, excluding cards, HUD, side panels/minimap."""
    h, w = screen.shape[:2]
    y0, y1 = int(h * 0.47), int(h * 0.82)
    x0, x1 = int(w * 0.22), int(w * 0.78)
    crop = screen[y0:y1, x0:x1]
    if crop.size == 0:
        raise RuntimeError("Aim return scene ROI was empty.")
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    return gray


def _measure_shift(reference: np.ndarray, candidate: np.ndarray) -> tuple[float, float, float]:
    a = _scene_gray(reference)
    b = _scene_gray(candidate)
    if a.shape != b.shape:
        raise RuntimeError("Aim return screenshots had different dimensions.")
    h, w = a.shape
    window = cv2.createHanningWindow((w, h), cv2.CV_32F)
    (dx, dy), response = cv2.phaseCorrelate(a, b, window)
    return float(dx), float(dy), float(response)


def _save_debug(debug_dir: Path | None, name: str, image: np.ndarray | None) -> None:
    if debug_dir is None or image is None:
        return
    debug_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(debug_dir / name), image)


def summon_aim_card(
    initial_screen: np.ndarray,
    capture_fn: Callable[[], np.ndarray],
    pulse_ms: float = 45.0,
    settle_ms: float = 180.0,
    return_tolerance_px: float = 1.5,
    max_correction_ms: float = 20.0,
    max_corrections: int = 2,
    debug_dir: Path | None = None,
) -> AimSummonResult:
    """Expose AIM card with L/R while returning as closely as possible to start aim."""
    result = AimSummonResult(attempted=True, pulse_ms=float(pulse_ms))
    result.final_screen = initial_screen
    _save_debug(debug_dir, "latest_aim_summon_before.png", initial_screen)

    if pulse_ms <= 0 or settle_ms < 0:
        result.warning = "Invalid AIM pulse/settle timing; no input sent."
        return result

    found = find_gspro_window()
    if found is None:
        result.warning = "Could not find a visible GSPro window; no L/R input sent."
        return result

    hwnd, title = found
    result.gspro_window_title = title
    user32 = ctypes.windll.user32
    previous_hwnd = int(user32.GetForegroundWindow())
    left_was_sent = False
    right_was_sent = False

    try:
        if not focus_gspro(hwnd):
            result.warning = "Could not safely focus GSPro; no L/R input sent."
            return result

        # First controlled pulse makes GSPro render/move its AIM state.
        pulse_key_windows("L", pulse_ms)
        left_was_sent = True
        time.sleep(settle_ms / 1000.0)
        after_left = capture_fn()
        _save_debug(debug_dir, "latest_aim_summon_after_left.png", after_left)

        # Always pair it with the same-duration opposite pulse before doing any
        # measurement/correction. This is the neutral baseline operation.
        if not focus_gspro(hwnd, wait_s=0.04):
            raise RuntimeError("GSPro lost foreground focus before the return pulse.")
        pulse_key_windows("R", pulse_ms)
        right_was_sent = True
        time.sleep(settle_ms / 1000.0)
        returned = capture_fn()
        result.final_screen = returned
        _save_debug(debug_dir, "latest_aim_summon_returned.png", returned)

        left_dx, _left_dy, response_left = _measure_shift(initial_screen, after_left)
        residual_dx, _residual_dy, response_return = _measure_shift(initial_screen, returned)
        result.left_dx_px = left_dx
        result.residual_dx_px = residual_dx
        result.response_left = response_left
        result.response_return = response_return

        # We only trust correction math if the intentional L move was measurable and
        # both phase-correlation responses contain useful signal.
        reliable = (
            abs(left_dx) >= 0.75
            and response_left >= 0.035
            and response_return >= 0.035
        )
        if not reliable:
            result.verified = None
            result.warning = (
                "AIM card was summoned with matched L/R pulses, but visual return "
                "verification was low-confidence; no speculative correction applied."
            )
            _save_debug(debug_dir, "latest_aim_summon_final.png", result.final_screen)
            return result

        if abs(residual_dx) <= return_tolerance_px:
            result.verified = True
            _save_debug(debug_dir, "latest_aim_summon_final.png", result.final_screen)
            return result

        previous_abs = abs(residual_dx)
        for _ in range(max(0, int(max_corrections))):
            # If residual has the same sign as the intentional L shift, the pair left
            # us slightly toward L, so correct with R; otherwise correct with L.
            correction_key = "R" if residual_dx * left_dx > 0 else "L"
            duration_ms = pulse_ms * abs(residual_dx / left_dx)
            duration_ms = min(max(duration_ms, 2.0), max_correction_ms)

            if not focus_gspro(hwnd, wait_s=0.04):
                result.warning = "GSPro lost focus before AIM return correction."
                break

            corr = AimCorrection(
                key=correction_key,
                duration_ms=float(duration_ms),
                residual_before_px=float(residual_dx),
            )
            pulse_key_windows(correction_key, duration_ms)
            time.sleep(settle_ms / 1000.0)
            corrected = capture_fn()
            _save_debug(
                debug_dir,
                f"latest_aim_summon_correction_{len(result.corrections) + 1}.png",
                corrected,
            )

            new_residual_dx, _dy, new_response = _measure_shift(initial_screen, corrected)
            corr.residual_after_px = float(new_residual_dx)
            result.corrections.append(corr)
            result.final_screen = corrected
            result.residual_dx_px = new_residual_dx
            result.response_return = new_response

            if new_response < 0.035:
                result.warning = "AIM correction was applied, but final visual verification became low-confidence."
                result.verified = None
                break

            if abs(new_residual_dx) <= return_tolerance_px:
                result.verified = True
                break

            # Do not chase a correction that made the return worse; read-only mode
            # should prefer stopping over oscillating around the original aim.
            if abs(new_residual_dx) >= previous_abs * 0.98:
                result.warning = "AIM return correction did not improve the measured residual; stopped safely."
                result.verified = False
                break

            previous_abs = abs(new_residual_dx)
            residual_dx = new_residual_dx
        else:
            result.verified = abs(result.residual_dx_px or 999.0) <= return_tolerance_px

        if result.verified is None and result.warning is None:
            result.verified = abs(result.residual_dx_px or 999.0) <= return_tolerance_px
        if result.verified is False and result.warning is None:
            result.warning = "AIM card was summoned but aim return remained outside tolerance."

        _save_debug(debug_dir, "latest_aim_summon_final.png", result.final_screen)
        return result

    except Exception as exc:
        # If L was sent but the normal R path failed, best-effort neutralize before
        # returning. We deliberately do not run further correction without screenshots.
        if left_was_sent and not right_was_sent:
            try:
                if focus_gspro(hwnd, wait_s=0.04):
                    pulse_key_windows("R", pulse_ms)
                    time.sleep(settle_ms / 1000.0)
                    result.final_screen = capture_fn()
            except Exception:
                pass
        result.warning = f"AIM summon failed safely: {exc}"
        _save_debug(debug_dir, "latest_aim_summon_final.png", result.final_screen)
        return result
    finally:
        # Restore whatever window the user had before the probe invoked GSPro.
        if previous_hwnd and previous_hwnd != hwnd:
            try:
                user32.SetForegroundWindow(previous_hwnd)
            except Exception:
                pass
