#!/usr/bin/env python3
"""Bounded GSPro W zoom-out recovery for post-tee green refinement.

Recovery is one-way by product design: zoom out only as needed to recover the whole
current target green; never automatically zoom back in. Timing and bounds come from
the shared live-caddie assumptions file rather than this actuator module.
"""

from __future__ import annotations

import json
from pathlib import Path
import time

import aim_actuator


def _config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["actuation"]


def press_w_once(*, pulse_ms: float | None = None, settle_ms: float | None = None) -> None:
    config = _config()
    pulse_ms = float(config["zoom_pulse_ms"] if pulse_ms is None else pulse_ms)
    settle_ms = float(config["zoom_settle_ms"] if settle_ms is None else settle_ms)

    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for W zoom recovery")
    hwnd, _title = found
    if not aim_actuator.focus_gspro(hwnd, wait_s=0.02):
        raise RuntimeError("Could not safely focus GSPro for W zoom recovery")
    aim_actuator.pulse_key_windows(str(config["zoom_out_key"]), pulse_ms)
    time.sleep(max(0.0, settle_ms) / 1000.0)


def recover_until_visible(
    *,
    capture_and_evaluate,
    max_pulses: int | None = None,
    pulse_ms: float | None = None,
    settle_ms: float | None = None,
):
    """Call capture_and_evaluate() after each bounded W pulse until visible.

    capture_and_evaluate must return (visible: bool, payload: object). The caller
    owns marker detection/green projection and can persist each attempt for review.
    """
    config = _config()
    max_pulses = int(config["zoom_max_pulses"] if max_pulses is None else max_pulses)
    pulse_ms = float(config["zoom_pulse_ms"] if pulse_ms is None else pulse_ms)
    settle_ms = float(config["zoom_settle_ms"] if settle_ms is None else settle_ms)

    if not bool(config["never_zoom_back_in"]):
        raise RuntimeError("Looper zoom recovery invariant requires never_zoom_back_in=true")

    history = []
    visible, payload = capture_and_evaluate()
    history.append({"w_pulses": 0, "visible": bool(visible), "payload": payload})
    if visible:
        return True, 0, payload, history

    for count in range(1, max(0, max_pulses) + 1):
        press_w_once(pulse_ms=pulse_ms, settle_ms=settle_ms)
        visible, payload = capture_and_evaluate()
        history.append({"w_pulses": count, "visible": bool(visible), "payload": payload})
        if visible:
            return True, count, payload, history

    return False, max(0, max_pulses), payload, history
