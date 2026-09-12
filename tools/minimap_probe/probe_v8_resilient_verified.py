#!/usr/bin/env python3
"""Verified Y-toggle wrapper for the resilient Step 11 tee probe.

Field evidence showed a repeatable failure mode where the first Y pulse produced no
visible minimap change, while the second pulse changed the green heatmap. The old
blind two-pulse helper therefore mislabeled the second capture as "restored" even
though it was actually heatmap-on.

This wrapper keeps the existing resilient probe unchanged, but replaces only the
shared Y-toggle helper with a state-verified version:
- do not assume a pulse worked;
- wait once more before retrying, in case the render is merely delayed;
- retry a missed toggle;
- verify the final restored minimap is back to the initial visual state;
- fail soft rather than proceeding with an uncertain GSPro state.

Field-lab tooling only. No W. No strategy authority.
"""
from __future__ import annotations

import ctypes
import os
import time

import cv2

import aim_actuator
import probe as base
import probe_v8
import probe_v8_resilient


def _minimap_change(initial_screen, candidate_screen) -> tuple[bool, float, float]:
    """Return (materially_changed, changed_ratio, mean_abs_diff).

    Thresholds are intentionally well above the tiny render/compression drift seen
    in the failed Step 11 first-pulse captures, while remaining below the smallest
    actual green-heatmap change from the same run.
    """
    initial_roi, _ = base.crop_minimap(initial_screen, None)
    candidate_roi, _ = base.crop_minimap(candidate_screen, None)
    if initial_roi.shape != candidate_roi.shape:
        return True, 1.0, 999.0

    diff = cv2.absdiff(initial_roi, candidate_roi)
    max_diff = diff.max(axis=2)
    mean_diff = diff.mean(axis=2)
    changed_ratio = float(((max_diff >= 10) & (mean_diff >= 3)).mean())
    mean_abs = float(diff.mean())
    changed = bool(changed_ratio >= 0.001 or mean_abs >= 0.20)
    return changed, changed_ratio, mean_abs


def _capture_after(monitor: int, settle_ms: float):
    time.sleep(max(0.0, settle_ms) / 1000.0)
    return base.capture_monitor(monitor)


def _verified_toggle_heatmap_pair(
    initial_screen,
    monitor: int,
    key: str,
    pulse_ms: float,
    settle_ms: float,
):
    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for heatmap toggle.")
    hwnd, title = found

    user32 = ctypes.windll.user32 if os.name == "nt" else None
    previous_hwnd = int(user32.GetForegroundWindow()) if user32 is not None else 0
    toggled_screen = None
    restored_screen = None
    toggled_confirmed = False
    restored_confirmed = False
    extra_wait_ms = max(220.0, float(settle_ms) * 0.75)

    try:
        # First attempt.
        probe_v8._focus_and_pulse(hwnd, key, pulse_ms)
        candidate = _capture_after(monitor, settle_ms)
        changed, ratio, mean_abs = _minimap_change(initial_screen, candidate)

        # Before sending another key, allow one delayed-render capture. This avoids
        # accidentally undoing a valid but slow first toggle.
        if not changed:
            late_candidate = _capture_after(monitor, extra_wait_ms)
            late_changed, late_ratio, late_mean = _minimap_change(initial_screen, late_candidate)
            if late_changed:
                candidate = late_candidate
                changed, ratio, mean_abs = late_changed, late_ratio, late_mean

        # Step 11 evidence showed the first pulse can simply be ignored. Retry once.
        if not changed:
            print(
                "Y toggle verify: first pulse produced no minimap state change; "
                "retrying once."
            )
            probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.03)
            candidate = _capture_after(monitor, settle_ms)
            changed, ratio, mean_abs = _minimap_change(initial_screen, candidate)
            if not changed:
                late_candidate = _capture_after(monitor, extra_wait_ms)
                changed, ratio, mean_abs = _minimap_change(initial_screen, late_candidate)
                candidate = late_candidate

        if not changed:
            raise RuntimeError(
                "Y toggle could not be visually confirmed after retry "
                f"(changed_ratio={ratio:.4%}, mean_abs_diff={mean_abs:.3f})."
            )

        toggled_screen = candidate
        toggled_confirmed = True

        # Restore from the confirmed opposite state.
        probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.03)
        restored = _capture_after(monitor, settle_ms)
        still_changed, restore_ratio, restore_mean = _minimap_change(initial_screen, restored)

        if still_changed:
            late_restored = _capture_after(monitor, extra_wait_ms)
            still_changed, restore_ratio, restore_mean = _minimap_change(initial_screen, late_restored)
            restored = late_restored

        if still_changed:
            print(
                "Y restore verify: first restore pulse did not return to the initial "
                "minimap state; retrying once."
            )
            probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.03)
            restored = _capture_after(monitor, settle_ms)
            still_changed, restore_ratio, restore_mean = _minimap_change(initial_screen, restored)
            if still_changed:
                late_restored = _capture_after(monitor, extra_wait_ms)
                still_changed, restore_ratio, restore_mean = _minimap_change(initial_screen, late_restored)
                restored = late_restored

        if still_changed:
            raise RuntimeError(
                "Y restore could not be visually confirmed; refusing to continue with "
                "uncertain GSPro heatmap state "
                f"(changed_ratio={restore_ratio:.4%}, mean_abs_diff={restore_mean:.3f})."
            )

        restored_screen = restored
        restored_confirmed = True
        return toggled_screen, restored_screen, title
    finally:
        # If we definitely reached the opposite state but could not prove restore,
        # make one best-effort return pulse before giving control back. The resilient
        # caller will still mark the capture failed-soft/uncertain and skip AIM.
        if toggled_confirmed and not restored_confirmed:
            try:
                probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.03)
                time.sleep(max(0.0, settle_ms) / 1000.0)
            except Exception:
                pass
        if previous_hwnd and user32 is not None and previous_hwnd != hwnd:
            try:
                user32.SetForegroundWindow(previous_hwnd)
            except Exception:
                pass


def main() -> int:
    probe_v8._toggle_heatmap_pair = _verified_toggle_heatmap_pair
    return probe_v8_resilient.main()


if __name__ == "__main__":
    raise SystemExit(main())
