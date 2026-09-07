#!/usr/bin/env python3
"""Field-safe adaptive launcher for the optimized v8 tee orchestrator.

The first fast-path test proved that a fixed 80 ms GSPro heatmap settle is too
aggressive on the sim PC. Instead of retreating to the old 320 ms blanket sleeps,
this launcher polls the *minimap itself* and proceeds as soon as the Y-state change
is actually visible.

This preserves the fast parallel v8 pipeline while making render timing adaptive:
- after Y ON/OFF toggle, capture after a short initial delay;
- measure material minimap change against the initial frame;
- if GSPro has not rendered yet, retry briefly up to a bounded deadline;
- after the restore Y, verify the minimap has returned to the initial state;
- never send an extra restore toggle merely because visual verification timed out.

Importing target_card_v8 keeps the field-validated 5y/feet-inches OCR patch active.
"""

from __future__ import annotations

import ctypes
import os
import time

import numpy as np

import aim_actuator
import green_heatmap
import probe as base
import probe_v8
import target_card_v8  # noqa: F401  (patch target-card OCR after v6 import chain)


CHANGE_RATIO_THRESHOLD = 0.0005
INITIAL_RENDER_WAIT_MS = 40.0
POLL_GAP_MS = 25.0
MAX_RENDER_WAIT_MS = 420.0

# Exposed for future diagnostics without changing the v8 HoleModel contract.
last_heatmap_timing: dict[str, float | int | bool] = {}


def _minimap_change_ratio(reference_screen, candidate_screen, roi_override: str | None) -> float:
    reference_roi, _ = base.crop_minimap(reference_screen, roi_override)
    candidate_roi, _ = base.crop_minimap(candidate_screen, roi_override)
    if reference_roi.shape != candidate_roi.shape:
        raise RuntimeError("Heatmap readiness frames do not share minimap geometry.")
    changed = green_heatmap._difference_mask(reference_roi, candidate_roi)
    return float((changed > 0).mean())


def _poll_render_state(
    *,
    reference_screen,
    monitor: int,
    roi_override: str | None,
    want_changed: bool,
    initial_wait_ms: float,
    max_wait_ms: float,
):
    start = time.perf_counter()
    attempts = 0
    last_screen = None
    last_ratio = 0.0

    if initial_wait_ms > 0:
        time.sleep(initial_wait_ms / 1000.0)

    while True:
        last_screen = base.capture_monitor(monitor)
        attempts += 1
        last_ratio = _minimap_change_ratio(reference_screen, last_screen, roi_override)

        ready = (
            last_ratio >= CHANGE_RATIO_THRESHOLD
            if want_changed
            else last_ratio < CHANGE_RATIO_THRESHOLD
        )
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        if ready:
            return last_screen, attempts, last_ratio, elapsed_ms, True

        if elapsed_ms >= max_wait_ms:
            return last_screen, attempts, last_ratio, elapsed_ms, False

        time.sleep(POLL_GAP_MS / 1000.0)


def adaptive_toggle_heatmap_pair(
    initial_screen,
    monitor: int,
    key: str,
    pulse_ms: float,
    settle_ms: float,
):
    """Y toggle with visual readiness polling instead of fixed render sleeps."""
    global last_heatmap_timing

    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for heatmap toggle.")
    hwnd, title = found

    user32 = ctypes.windll.user32 if os.name == "nt" else None
    previous_hwnd = int(user32.GetForegroundWindow()) if user32 is not None else 0
    first_sent = False
    restore_sent = False

    # Keep CLI compatibility: a caller may intentionally ask for a larger minimum
    # delay, but the optimized default is capped by the adaptive launcher's 40 ms.
    first_wait_ms = min(max(0.0, float(settle_ms)), INITIAL_RENDER_WAIT_MS)

    try:
        probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.015)
        first_sent = True

        toggled_screen, on_attempts, on_ratio, on_ms, on_ready = _poll_render_state(
            reference_screen=initial_screen,
            monitor=monitor,
            roi_override=None,
            want_changed=True,
            initial_wait_ms=first_wait_ms,
            max_wait_ms=MAX_RENDER_WAIT_MS,
        )
        if not on_ready:
            raise RuntimeError(
                "GSPro heatmap did not become visibly ready within "
                f"{MAX_RENDER_WAIT_MS:.0f} ms (last minimap change ratio {on_ratio:.5f})."
            )

        probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.010)
        restore_sent = True

        restored_screen, off_attempts, off_ratio, off_ms, off_ready = _poll_render_state(
            reference_screen=initial_screen,
            monitor=monitor,
            roi_override=None,
            want_changed=False,
            initial_wait_ms=first_wait_ms,
            max_wait_ms=MAX_RENDER_WAIT_MS,
        )

        last_heatmap_timing = {
            "adaptive": True,
            "on_attempts": int(on_attempts),
            "on_ready_ms": round(on_ms, 1),
            "on_change_ratio": round(on_ratio, 6),
            "off_attempts": int(off_attempts),
            "off_ready_ms": round(off_ms, 1),
            "off_change_ratio": round(off_ratio, 6),
            "restore_verified": bool(off_ready),
        }

        if not off_ready:
            # The restore key was already sent. Do NOT send another Y here; doing so
            # could turn heatmap back on. Fail safely and leave a precise diagnostic.
            raise RuntimeError(
                "Heatmap restore key was sent, but the minimap did not visually match "
                f"the starting state within {MAX_RENDER_WAIT_MS:.0f} ms "
                f"(last change ratio {off_ratio:.5f})."
            )

        return toggled_screen, restored_screen, title

    finally:
        # Only best-effort restore if the first Y was sent and the second Y was not.
        # Once restore_sent=True, never blindly toggle again based on CV confidence.
        if first_sent and not restore_sent:
            try:
                probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.010)
            except Exception:
                pass
        if previous_hwnd and user32 is not None and previous_hwnd != hwnd:
            try:
                user32.SetForegroundWindow(previous_hwnd)
            except Exception:
                pass


# v8 resolves this global when main() runs.
probe_v8._toggle_heatmap_pair = adaptive_toggle_heatmap_pair


if __name__ == "__main__":
    raise SystemExit(probe_v8.main())
