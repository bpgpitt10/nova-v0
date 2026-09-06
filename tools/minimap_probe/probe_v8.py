#!/usr/bin/env python3
"""GSPro tee-capture orchestrator v8.

Purpose
-------
Move beyond isolated screen/minimap probes and capture a reusable tee HoleModel in
one deterministic sequence.

At the tee GSPro always shows the full hole in the minimap, so v8 deliberately does
NOT zoom. It captures dynamic pre-shot state, toggles the green heatmap with Y,
acquires one canonical HEATMAP-ON minimap, restores the UI, extracts hazards + the
target green in a shared coordinate system, then acquires the player AIM card.

The initial and toggled minimaps are used transiently to identify which frame is
heatmap-on and to isolate all heatmap-changed green pixels. Only the heatmap-on
minimap is the canonical HoleModel image.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import cv2

import aim_actuator
import green_heatmap
import lie_state
import probe as base
import probe_v2 as v2
import probe_v4  # noqa: F401; applies marker/hazard patches
import probe_v6 as v6  # noqa: F401; applies hardened PIN/AIM OCR patches
import target_cards_v6


SW_RESTORE = 9


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro tee HoleModel capture orchestrator v8")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--lie-roi", help="Override minimap lie footer as x,y,w,h in screen pixels.")
    p.add_argument("--tesseract", help="Explicit path to tesseract.exe if auto-discovery fails.")
    p.add_argument("--heatmap-key", default="Y")
    p.add_argument("--heatmap-settle-ms", type=float, default=320.0)
    p.add_argument("--heatmap-pulse-ms", type=float, default=45.0)
    p.add_argument("--corridor", type=float, default=40.0)
    p.add_argument("--centerline-band", type=float, default=4.0)
    p.add_argument("--merge-gap", type=float, default=4.0)
    p.add_argument("--no-aim-summon", action="store_true")
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=180.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def _capture_dir(root: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = Path(root) / f"tee_capture_{stamp}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _focus_and_pulse(hwnd: int, key: str, duration_ms: float, wait_s: float = 0.05) -> None:
    if not aim_actuator.focus_gspro(hwnd, wait_s=wait_s):
        raise RuntimeError("Could not safely focus GSPro for heatmap toggle.")
    aim_actuator.pulse_key_windows(key, duration_ms)


def _toggle_heatmap_pair(
    initial_screen,
    monitor: int,
    key: str,
    pulse_ms: float,
    settle_ms: float,
    debug_dir: Path,
):
    """Toggle Y once, capture, toggle back, capture restored state.

    Restoration is attempted in finally whenever the first toggle was successfully
    sent. This preserves the user's original heatmap state whether it began ON or OFF.
    """
    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find a visible GSPro window for heatmap toggle.")
    hwnd, title = found

    user32 = ctypes.windll.user32 if os.name == "nt" else None
    previous_hwnd = int(user32.GetForegroundWindow()) if user32 is not None else 0
    first_sent = False
    restored = False
    toggled_screen = None
    restored_screen = None

    cv2.imwrite(str(debug_dir / "tee_initial_screen.png"), initial_screen)

    try:
        _focus_and_pulse(hwnd, key, pulse_ms)
        first_sent = True
        time.sleep(max(0.0, settle_ms) / 1000.0)
        toggled_screen = base.capture_monitor(monitor)
        cv2.imwrite(str(debug_dir / "tee_toggled_screen.png"), toggled_screen)

        _focus_and_pulse(hwnd, key, pulse_ms)
        time.sleep(max(0.0, settle_ms) / 1000.0)
        restored_screen = base.capture_monitor(monitor)
        restored = True
        cv2.imwrite(str(debug_dir / "tee_restored_screen.png"), restored_screen)
        return toggled_screen, restored_screen, title
    finally:
        if first_sent and not restored:
            try:
                _focus_and_pulse(hwnd, key, pulse_ms, wait_s=0.04)
                time.sleep(max(0.0, settle_ms) / 1000.0)
            except Exception:
                pass
        if previous_hwnd and user32 is not None and previous_hwnd != hwnd:
            try:
                user32.SetForegroundWindow(previous_hwnd)
            except Exception:
                pass


def _read_cards(screen, args: argparse.Namespace, debug_dir: Path):
    return target_cards_v6.read_cards(
        screen,
        tesseract_path=args.tesseract,
        debug_dir=debug_dir,
    )


def _state_dict(state):
    if state is None:
        return None
    return {
        "distance_yds": state.distance_yds,
        "elevation_raw": state.elevation_raw,
        "elevation_direction": state.elevation_direction,
        "elevation_delta_ft": state.elevation_delta_ft,
        "elevation_delta_yds": state.elevation_delta_yds,
        "source": state.source,
    }


def _acquire_aim(restored_screen, args: argparse.Namespace, debug_dir: Path):
    cards_error = None
    try:
        cards = _read_cards(restored_screen, args, debug_dir)
    except Exception as exc:
        cards = {}
        cards_error = str(exc)

    if cards.get("aim") is not None:
        return cards.get("aim"), {
            "status": "already-visible",
            "attempted": False,
            "verified_return": None,
            "warning": cards_error,
        }

    if args.no_aim_summon:
        return None, {
            "status": "not-attempted",
            "attempted": False,
            "verified_return": None,
            "warning": "AIM summon disabled by --no-aim-summon.",
        }

    summon = aim_actuator.summon_aim_card(
        initial_screen=restored_screen,
        capture_fn=lambda: base.capture_monitor(args.monitor),
        pulse_ms=args.aim_pulse_ms,
        settle_ms=args.aim_settle_ms,
        return_tolerance_px=args.aim_return_tolerance_px,
        max_correction_ms=args.aim_max_correction_ms,
        max_corrections=args.aim_max_corrections,
        debug_dir=debug_dir,
    )

    aim = None
    parse_warning = None
    if summon.final_screen is not None:
        try:
            final_cards = _read_cards(summon.final_screen, args, debug_dir)
            aim = final_cards.get("aim")
        except Exception as exc:
            parse_warning = str(exc)

    warning_parts = [x for x in (summon.warning, cards_error, parse_warning) if x]
    return aim, {
        "status": "auto-summoned" if aim is not None else "summon-attempted-no-aim-read",
        "attempted": summon.attempted,
        "pulse_ms": summon.pulse_ms,
        "left_dx_px": summon.left_dx_px,
        "residual_dx_px": summon.residual_dx_px,
        "response_left": summon.response_left,
        "response_return": summon.response_return,
        "verified_return": summon.verified,
        "corrections": [asdict(c) for c in summon.corrections],
        "warning": " ".join(warning_parts) if warning_parts else None,
    }


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    args = parse_args()
    out = _capture_dir(args.output_root)

    try:
        # TEE RULE: capture GSPro exactly as presented. No W, no zoom recovery.
        initial_screen = base.capture_monitor(args.monitor)

        cards = _read_cards(initial_screen, args, out)
        pin_state = cards.get("pin")
        if pin_state is None:
            raise RuntimeError("Could not read the white PIN card; tee capture cannot calibrate map scale.")

        lie = None
        lie_error = None
        try:
            lie = lie_state.read_lie_state(
                initial_screen,
                tesseract_path=args.tesseract,
                roi_override=args.lie_roi,
                debug_dir=out,
            )
        except Exception as exc:
            lie_error = str(exc)

        toggled_screen, restored_screen, gspro_title = _toggle_heatmap_pair(
            initial_screen=initial_screen,
            monitor=args.monitor,
            key=args.heatmap_key,
            pulse_ms=args.heatmap_pulse_ms,
            settle_ms=args.heatmap_settle_ms,
            debug_dir=out,
        )

        green = green_heatmap.classify_and_extract(
            initial_screen=initial_screen,
            toggled_screen=toggled_screen,
            roi_override=args.roi,
            debug_dir=out,
        )

        heatmap_roi = green.heatmap_roi
        ball = v2.detect_ball_marker(heatmap_roi)
        pin = v2.detect_pin_marker(heatmap_roi)
        pin_pixels = float(((pin.x - ball.x) ** 2 + (pin.y - ball.y) ** 2) ** 0.5)
        if pin_pixels < 10:
            raise RuntimeError("Ball/pin separation too small for tee minimap calibration.")
        scale = float(pin_state.distance_yds) / pin_pixels
        if not (0.03 <= scale <= 3.0):
            raise RuntimeError(f"Implausible tee minimap scale {scale:.4f} yd/px.")

        hazard_roi = green_heatmap.hazard_safe_roi(green)
        cv2.imwrite(str(out / "tee_hazard_safe_minimap.png"), hazard_roi)
        hazards, _pin_pixels2, _scale2 = v2.build_penalty_objects(
            roi=hazard_roi,
            ball=ball,
            pin=pin,
            distance_to_pin_yds=float(pin_state.distance_yds),
            corridor_half_width_yds=args.corridor,
            centerline_band_yds=args.centerline_band,
            merge_gap_yds=args.merge_gap,
        )

        aim_state, aim_meta = _acquire_aim(restored_screen, args, out)

        hole_model = {
            "schema_version": "tee-hole-model-v0",
            "capture_mode": "tee",
            "canonical_minimap": "tee_heatmap_minimap.png",
            "minimap": {
                "ball_pixel": {"x": ball.x, "y": ball.y},
                "pin_pixel": {"x": pin.x, "y": pin.y},
                "ball_to_pin_pixels": pin_pixels,
                "yards_per_pixel": scale,
                "zoom_changed": False,
                "tee_rule": "never zoom at tee",
            },
            "hazards": {
                "penalty_objects": [asdict(h) for h in hazards],
                "source": "canonical heatmap geometry with all Y-changed green pixels restored transiently before red-boundary CV",
            },
            "green_surface": {
                "target_green_mask": "tee_target_green_mask.png",
                "debug_overlay": "tee_green_debug_overlay.png",
                "heatmap_confidence": green.confidence,
                "changed_pixel_ratio": green.changed_pixel_ratio,
                "target_green_area_px": green.target_green_area_px,
                "target_green_bbox": list(green.target_green_bbox),
                "pin_distance_to_mask_px": green.pin_distance_to_mask_px,
                "heatmap_was_initial_state": green.heatmap_is_initial,
                "source": "GSPro tee minimap Y heatmap",
            },
            "capture": {
                "gspro_window_title": gspro_title,
                "heatmap_key": args.heatmap_key,
                "heatmap_settle_ms": args.heatmap_settle_ms,
                "heatmap_restored": True,
                "created_local": datetime.now().isoformat(timespec="seconds"),
            },
        }

        shot_state = {
            "schema_version": "tee-shot-state-v0",
            "lie_surface": "tee",
            "pin": _state_dict(pin_state),
            "aim": _state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "lie_slope": asdict(lie) if lie is not None else None,
            "lie_warning": lie_error,
            # Wind intentionally remains owned by Looper's existing wind path; v8
            # proves the minimap/screen capture contract without duplicating it.
            "wind": None,
            "wind_note": "Use existing Looper wind source; not duplicated in tee minimap probe v8.",
        }

        _write_json(out / "hole_model.json", hole_model)
        _write_json(out / "shot_state.json", shot_state)
        _write_json(
            out / "tee_capture_meta.json",
            {
                "success": True,
                "output_dir": str(out),
                "heatmap_key": args.heatmap_key,
                "heatmap_restored": True,
                "no_zoom_at_tee": True,
                "green_confidence": green.confidence,
                "penalty_object_count": len(hazards),
                "aim_status": aim_meta.get("status"),
                "lie_read": lie is not None,
            },
        )

        if args.json:
            print(json.dumps({"hole_model": hole_model, "shot_state": shot_state}, indent=2))
            return 0

        print()
        print("GSPro TEE CAPTURE ORCHESTRATOR v8")
        print("=================================")
        print("Tee zoom:             untouched (W disabled by design)")
        print(f"Pin target:           {pin_state.distance_yds:.0f} yd")
        print(
            f"Pin elevation:        {pin_state.elevation_direction} "
            f"{pin_state.elevation_raw or '?'}"
        )
        print(f"Lie slope:            {lie_state.state_text(lie)}")
        if lie_error:
            print(f"Lie warning:          {lie_error}")
        print(f"Heatmap state:        {'already ON' if green.heatmap_is_initial else 'turned ON for capture'}")
        print(f"Heatmap restored:     YES")
        print(f"Green confidence:     {green.confidence:.2f}")
        print(f"Target green pixels:  {green.target_green_area_px}")
        print(f"Map scale:            {scale:.4f} yd/px")
        print(f"Penalty objects:      {len(hazards)}")
        print(
            f"GSPro aim target:     {aim_state.distance_yds:.0f} yd | "
            f"{aim_state.elevation_direction} {aim_state.elevation_raw or '?'}"
            if aim_state is not None else
            "GSPro aim target:     unavailable"
        )
        print(f"AIM acquisition:      {aim_meta.get('status')}")
        if aim_meta.get("verified_return") is not None:
            print(f"Aim return verified:  {aim_meta.get('verified_return')}")
        if aim_meta.get("warning"):
            print(f"Aim warning:          {aim_meta.get('warning')}")
        print()
        print(f"HoleModel:            {out / 'hole_model.json'}")
        print(f"ShotState:            {out / 'shot_state.json'}")
        print(f"Canonical minimap:    {out / 'tee_heatmap_minimap.png'}")
        print(f"Green debug:          {out / 'tee_green_debug_overlay.png'}")
        print(f"Capture folder:       {out}")
        return 0

    except Exception as exc:
        try:
            _write_json(out / "tee_capture_meta.json", {"success": False, "error": str(exc)})
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
