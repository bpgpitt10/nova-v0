#!/usr/bin/env python3
"""Bounded GSPro W zoom-out recovery for later approach validation.

This module is intentionally NOT wired into the default runner yet.  The first
field test should validate the green-visibility decision before enabling UI
actuation.  When enabled later, recovery is one-way by product design: zoom out
only as needed to recover the whole target green; do not automatically zoom back in.
"""

from __future__ import annotations

import time

import aim_actuator


def press_w_once(*, pulse_ms: float = 45.0, settle_ms: float = 320.0) -> None:
    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for W zoom recovery")
    hwnd, _title = found
    if not aim_actuator.focus_gspro(hwnd, wait_s=0.02):
        raise RuntimeError("Could not safely focus GSPro for W zoom recovery")
    aim_actuator.pulse_key_windows("W", pulse_ms)
    time.sleep(max(0.0, float(settle_ms)) / 1000.0)


def recover_until_visible(
    *,
    capture_and_evaluate,
    max_pulses: int = 3,
    pulse_ms: float = 45.0,
    settle_ms: float = 320.0,
):
    """Call capture_and_evaluate() after each bounded W pulse until visible.

    capture_and_evaluate must return (visible: bool, payload: object).  The caller
    owns marker detection/green projection and can persist each attempt for review.
    """
    history = []
    visible, payload = capture_and_evaluate()
    history.append({"w_pulses": 0, "visible": bool(visible), "payload": payload})
    if visible:
        return True, 0, payload, history

    for count in range(1, max(0, int(max_pulses)) + 1):
        press_w_once(pulse_ms=pulse_ms, settle_ms=settle_ms)
        visible, payload = capture_and_evaluate()
        history.append({"w_pulses": count, "visible": bool(visible), "payload": payload})
        if visible:
            return True, count, payload, history

    return False, max(0, int(max_pulses)), payload, history
