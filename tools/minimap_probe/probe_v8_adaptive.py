#!/usr/bin/env python3
"""Field-safe adaptive launcher for the optimized v8 tee orchestrator.

The first fast-path test proved that a fixed 80 ms GSPro heatmap settle is too
aggressive on the sim PC. A second test showed an equally important behavior: if we
send the restore Y too soon after the first Y, GSPro can leave the heatmap on even
though the key event itself was delivered.

This launcher therefore adapts to *render readiness* while also respecting a small
minimum inter-toggle gap:
- press Y and poll the minimap until the heatmap is actually visible;
- never send the second Y earlier than the measured-safe toggle gap;
- press Y to restore;
- verify the restored frame is materially closer to the starting minimap than the
  heatmap frame, rather than demanding pixel-for-pixel identity;
- never send a speculative third Y if restore verification is uncertain.

Importing target_card_v8 keeps the field-validated 5y/feet-inches OCR patch active.
"""

from __future__ import annotations

import ctypes
import os
import time

import aim_actuator
import green_heatmap
import probe as base
import probe_v8
import target_card_v8  # noqa: F401  (patch target-card OCR after v6 import chain)


CHANGE_RATIO_THRESHOLD = 0.0005
INITIAL_RENDER_WAIT_MS = 40.0
POLL_GAP_MS = 25.0
MAX_RENDER_WAIT_MS = 420.0
MAX_RESTORE_WAIT_MS = 700.0
# Field test 2026-09-06: restoring immediately after the first rendered heatmap
# could be ignored/ineffective. Keep the two Y pulses at least this far apart while
# still saving far more time than the original 320 ms blanket sleeps.
MIN_TOGGLE_GAP_MS = 260.0

# Exposed for future diagnostics without changing the v8 HoleModel contract.
last_heatmap_timing: dict[str, float | int | bool] = {}


def _minimap_change_ratio(reference_screen, candidate_screen, roi_override: str | None) -> float:
    reference_roi, _ = base.crop_minimap(reference_screen, roi_override)
    candidate_roi, _ = base.crop_minimap(candidate_screen, roi_override)
    if reference_roi.shape != candidate_roi.shape:
        raise RuntimeError("Heatmap readiness frames do not share minimap geometry.")
    changed = green_heatmap._difference_mask(reference_roi, candidate_roi)
    return float((changed > 0).mean())


def _poll_on_state(
    *,
    reference_screen,
    monitor: int,
    roi_override: str | None,
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
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        if last_ratio >= CHANGE_RATIO_THRESHOLD:
            return last_screen, attempts, last_ratio, elapsed_ms, True
        if elapsed_ms >= max_wait_ms:
            return last_screen, attempts, last_ratio, elapsed_ms, False
        time.sleep(POLL_GAP_MS / 1000.0)


def _poll_restore_state(
    *,
    initial_screen,
    heatmap_screen,
    heatmap_change_ratio: float,
    monitor: int,
    roi_override: str | None,
    initial_wait_ms: float,
    max_wait_ms: float,
):
    """Wait until the minimap is clearly back toward its pre-heatmap state.

    Requiring candidate==initial was too strict for a live rendered UI. Instead we
    require the candidate to be both absolutely close to initial and closer to
    initial than to the known heatmap frame. The threshold scales with the observed
    heatmap delta but remains conservative.
    """
    start = time.perf_counter()
    attempts = 0
    last_screen = None
    last_to_initial = 1.0
    last_to_heatmap = 1.0
    restore_threshold = max(0.0010, min(0.0060, heatmap_change_ratio * 0.12))

    if initial_wait_ms > 0:
        time.sleep(initial_wait_ms / 1000.0)

    while True:
        last_screen = base.capture_monitor(monitor)
        attempts += 1
        last_to_initial = _minimap_change_ratio(initial_screen, last_screen, roi_override)
        last_to_heatmap = _minimap_change_ratio(heatmap_screen, last_screen, roi_override)
        elapsed_ms = (time.perf_counter() - start) * 1000.0

        ready = (
            last_to_initial <= restore_threshold
            and last_to_initial < last_to_heatmap
        )
        if ready:
            return (
                last_screen,
                attempts,
                last_to_initial,
                last_to_heatmap,
                elapsed_ms,
                True,
                restore_threshold,
            )
        if elapsed_ms >= max_wait_ms:
            return (
                last_screen,
                attempts,
                last_to_initial,
                last_to_heatmap,
                elapsed_ms,
                False,
                restore_threshold,
            )
        time.sleep(POLL_GAP_MS / 1000.0)


def adaptive_toggle_heatmap_pair(
    initial_screen,
    monitor: int,
    key: str,
    pulse_ms: float,
    settle_ms: float,
):
    """Y toggle with adaptive render polling and a field-safe inter-toggle gap."""
    global last_heatmap_timing

    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for heatmap toggle.")
    hwnd, title = found

    user32 = ctypes.windll.user32 if os.name == "nt" else None
    previous_hwnd = int(user32.GetForegroundWindow()) if user32 is not None else 0
    first_sent = False
    restore_sent = False

    # Preserve CLI compatibility while keeping the optimized first look short.
    first_wait_ms = min(max(0.0, float(settle_ms)), INITIAL_RENDER_WAIT_MS)

    try:
        probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.015)
        first_sent = True
        first_toggle_completed_at = time.perf_counter()

        toggled_screen, on_attempts, on_ratio, on_ms, on_ready = _poll_on_state(
            reference_screen=initial_screen,
            monitor=monitor,
            roi_override=None,
            initial_wait_ms=first_wait_ms,
            max_wait_ms=MAX_RENDER_WAIT_MS,
        )
        if not on_ready:
            raise RuntimeError(
                "GSPro heatmap did not become visibly ready within "
                f"{MAX_RENDER_WAIT_MS:.0f} ms (last minimap change ratio {on_ratio:.5f})."
            )

        # GSPro appears to need a short debounce/cooldown between Y toggles. If the
        # heatmap rendered very quickly, use the remaining time productively as the
        # minimum gap rather than immediately firing a restore that may be ignored.
        since_first_ms = (time.perf_counter() - first_toggle_completed_at) * 1000.0
        toggle_gap_wait_ms = max(0.0, MIN_TOGGLE_GAP_MS - since_first_ms)
        if toggle_gap_wait_ms > 0:
            time.sleep(toggle_gap_wait_ms / 1000.0)

        probe_v8._focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.010)
        restore_sent = True

        (
            restored_screen,
            off_attempts,
            off_ratio,
            off_to_heatmap,
            off_ms,
            off_ready,
            restore_threshold,
        ) = _poll_restore_state(
            initial_screen=initial_screen,
            heatmap_screen=toggled_screen,
            heatmap_change_ratio=on_ratio,
            monitor=monitor,
            roi_override=None,
            initial_wait_ms=first_wait_ms,
            max_wait_ms=MAX_RESTORE_WAIT_MS,
        )

        last_heatmap_timing = {
            "adaptive": True,
            "on_attempts": int(on_attempts),
            "on_ready_ms": round(on_ms, 1),
            "on_change_ratio": round(on_ratio, 6),
            "toggle_gap_wait_ms": round(toggle_gap_wait_ms, 1),
            "min_toggle_gap_ms": MIN_TOGGLE_GAP_MS,
            "off_attempts": int(off_attempts),
            "off_ready_ms": round(off_ms, 1),
            "off_change_ratio_to_initial": round(off_ratio, 6),
            "off_change_ratio_to_heatmap": round(off_to_heatmap, 6),
            "restore_threshold": round(restore_threshold, 6),
            "restore_verified": bool(off_ready),
        }

        if not off_ready:
            # The restore key was already sent. Do NOT send another Y here; doing so
            # could turn heatmap back on if the render was merely delayed.
            raise RuntimeError(
                "Heatmap restore key was sent, but the minimap did not return close "
                f"enough to the starting state within {MAX_RESTORE_WAIT_MS:.0f} ms "
                f"(to start {off_ratio:.5f}, to heatmap {off_to_heatmap:.5f}, "
                f"threshold {restore_threshold:.5f})."
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
