#!/usr/bin/env python3
"""GSPro tee-capture orchestrator v8.

At the tee GSPro always shows the full hole, so v8 never changes minimap zoom.
It reads PIN state, captures one canonical heatmap-on minimap, restores GSPro,
extracts green/hazards, acquires the player AIM card, and writes HoleModel +
ShotState.

Performance matters because recommendation logic still has to run afterward. v8
therefore records phase timings and reports the moment a complete state is ready.
Tee lie is a known GSPro invariant (0.0/0.0), so default tee capture does not spend
OCR time proving it every hole; --verify-tee-lie is available for diagnostics.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from contextlib import contextmanager
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
import target_card
import target_cards_v6


SW_RESTORE = 9


class PhaseTimer:
    def __init__(self) -> None:
        self.started = time.perf_counter()
        self.phase_ms: dict[str, float] = {}

    @contextmanager
    def phase(self, name: str):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.phase_ms[name] = round((time.perf_counter() - t0) * 1000.0, 1)

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self.started) * 1000.0, 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro tee HoleModel capture orchestrator v8")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--lie-roi", help="Override minimap lie footer as x,y,w,h in screen pixels.")
    p.add_argument("--tesseract", help="Explicit path to tesseract.exe if auto-discovery fails.")
    p.add_argument("--verify-tee-lie", action="store_true", help="OCR lie even though GSPro tee lie is invariant 0/0.")
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
    """Toggle heatmap once, capture, then restore the user's original Y state."""
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


def _read_card_type(
    screen,
    card_type: str,
    args: argparse.Namespace,
    debug_dir: Path,
    required: bool = False,
):
    """Detect all card geometry but OCR only the requested semantic card.

    This avoids repeatedly OCRing the permanent PIN card while we are merely
    checking whether an AIM card exists after heatmap restoration.
    """
    detected = target_cards_v6.detect_cards(screen)
    chosen = next((c for c in detected if c.card_type == card_type), None)
    if chosen is None:
        if required:
            raise RuntimeError(f"Could not locate the GSPro {card_type.upper()} card.")
        return None

    state = target_card.read_target_card(
        screen,
        tesseract_path=args.tesseract,
        bbox_override=chosen.bbox,
        debug_dir=None,
    )
    state.source = "gspro-screen-pin-card" if card_type == "pin" else "gspro-screen-aim-card"

    x, y, w, h = chosen.bbox
    crop = screen[y:y + h, x:x + w]
    if crop.size:
        cv2.imwrite(str(debug_dir / f"latest_{card_type}_card_v6.png"), crop)
    return state


def _tee_flat_lie() -> lie_state.LieState:
    return lie_state.LieState(
        up_down_deg=0.0,
        up_down_direction="up",
        left_right_deg=0.0,
        left_right_direction="right",
        signed_up_down_deg=0.0,
        signed_left_right_deg=0.0,
        up_down_ocr_raw="TEE_INVARIANT_0.0",
        left_right_ocr_raw="TEE_INVARIANT_0.0",
        footer_bbox=(0, 0, 0, 0),
        source="gspro-tee-invariant",
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
    # Cheap geometry check first; OCR only AIM if it is already present.
    try:
        existing = _read_card_type(restored_screen, "aim", args, debug_dir, required=False)
    except Exception as exc:
        existing = None
        existing_error = str(exc)
    else:
        existing_error = None

    if existing is not None:
        return existing, {
            "status": "already-visible",
            "attempted": False,
            "verified_return": None,
            "warning": existing_error,
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
            aim = _read_card_type(summon.final_screen, "aim", args, debug_dir, required=False)
        except Exception as exc:
            parse_warning = str(exc)

    warning_parts = [x for x in (summon.warning, existing_error, parse_warning) if x]
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


def _print_timings(phase_ms: dict[str, float], state_ready_ms: float, probe_total_ms: float) -> None:
    labels = [
        ("initial_capture", "Initial capture"),
        ("pin_card_read", "PIN card OCR"),
        ("tee_lie", "Tee lie"),
        ("heatmap_toggle_restore", "Heatmap toggle/restore"),
        ("green_extract", "Green extraction"),
        ("marker_scale", "Ball/pin + scale"),
        ("hazard_extract", "Hazard extraction"),
        ("aim_acquire", "AIM acquisition"),
        ("persist_models", "Persist models"),
    ]
    print()
    print("Performance timing")
    print("------------------")
    for key, label in labels:
        if key in phase_ms:
            print(f"{label + ':':24} {phase_ms[key]:7.1f} ms")
    print(f"{'STATE READY:':24} {state_ready_ms:7.1f} ms")
    print(f"{'Probe total:':24} {probe_total_ms:7.1f} ms")


def main() -> int:
    args = parse_args()
    out = _capture_dir(args.output_root)
    timer = PhaseTimer()

    try:
        # TEE RULE: capture GSPro exactly as presented. No W, no zoom recovery.
        with timer.phase("initial_capture"):
            initial_screen = base.capture_monitor(args.monitor)

        with timer.phase("pin_card_read"):
            pin_state = _read_card_type(initial_screen, "pin", args, out, required=True)

        lie_error = None
        with timer.phase("tee_lie"):
            if args.verify_tee_lie:
                try:
                    lie = lie_state.read_lie_state(
                        initial_screen,
                        tesseract_path=args.tesseract,
                        roi_override=args.lie_roi,
                        debug_dir=out,
                    )
                except Exception as exc:
                    lie_error = str(exc)
                    lie = _tee_flat_lie()
            else:
                lie = _tee_flat_lie()

        with timer.phase("heatmap_toggle_restore"):
            toggled_screen, restored_screen, gspro_title = _toggle_heatmap_pair(
                initial_screen=initial_screen,
                monitor=args.monitor,
                key=args.heatmap_key,
                pulse_ms=args.heatmap_pulse_ms,
                settle_ms=args.heatmap_settle_ms,
                debug_dir=out,
            )

        with timer.phase("green_extract"):
            green = green_heatmap.classify_and_extract(
                initial_screen=initial_screen,
                toggled_screen=toggled_screen,
                roi_override=args.roi,
                debug_dir=out,
            )

        with timer.phase("marker_scale"):
            heatmap_roi = green.heatmap_roi
            ball = v2.detect_ball_marker(heatmap_roi)
            pin = v2.detect_pin_marker(heatmap_roi)
            pin_pixels = float(((pin.x - ball.x) ** 2 + (pin.y - ball.y) ** 2) ** 0.5)
            if pin_pixels < 10:
                raise RuntimeError("Ball/pin separation too small for tee minimap calibration.")
            scale = float(pin_state.distance_yds) / pin_pixels
            if not (0.03 <= scale <= 3.0):
                raise RuntimeError(f"Implausible tee minimap scale {scale:.4f} yd/px.")

        with timer.phase("hazard_extract"):
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

        with timer.phase("aim_acquire"):
            aim_state, aim_meta = _acquire_aim(restored_screen, args, out)

        # This is the important product latency: recommendation can begin now.
        state_ready_ms = timer.elapsed_ms()
        performance = {
            "state_ready_ms": state_ready_ms,
            "phase_ms": dict(timer.phase_ms),
            "configured_ui_wait_floor_ms": round(
                2.0 * args.heatmap_settle_ms
                + (0.0 if aim_meta.get("status") == "already-visible" else 2.0 * args.aim_settle_ms)
                + len(aim_meta.get("corrections") or []) * args.aim_settle_ms,
                1,
            ),
            "tee_lie_mode": "verified-ocr" if args.verify_tee_lie else "invariant-zero",
        }

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
                "performance": performance,
            },
        }

        shot_state = {
            "schema_version": "tee-shot-state-v0",
            "lie_surface": "tee",
            "pin": _state_dict(pin_state),
            "aim": _state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "lie_slope": asdict(lie),
            "lie_warning": lie_error,
            "wind": None,
            "wind_note": "Use existing Looper wind source; not duplicated in tee minimap probe v8.",
            "capture_performance": performance,
        }

        with timer.phase("persist_models"):
            _write_json(out / "hole_model.json", hole_model)
            _write_json(out / "shot_state.json", shot_state)

        probe_total_ms = timer.elapsed_ms()
        performance["probe_total_ms"] = probe_total_ms
        performance["phase_ms"] = dict(timer.phase_ms)

        # Rewrite the models once with final persistence timing included.
        hole_model["capture"]["performance"] = performance
        shot_state["capture_performance"] = performance
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
                "lie_read": True,
                "performance": performance,
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
        print(f"Pin elevation:        {pin_state.elevation_direction} {pin_state.elevation_raw or '?'}")
        print(f"Lie slope:            {lie_state.state_text(lie)}")
        print(f"Lie source:           {lie.source}")
        if lie_error:
            print(f"Lie warning:          {lie_error}")
        print(f"Heatmap state:        {'already ON' if green.heatmap_is_initial else 'turned ON for capture'}")
        print("Heatmap restored:     YES")
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

        _print_timings(timer.phase_ms, state_ready_ms, probe_total_ms)

        print()
        print(f"HoleModel:            {out / 'hole_model.json'}")
        print(f"ShotState:            {out / 'shot_state.json'}")
        print(f"Canonical minimap:    {out / 'tee_heatmap_minimap.png'}")
        print(f"Green debug:          {out / 'tee_green_debug_overlay.png'}")
        print(f"Capture folder:       {out}")
        return 0

    except Exception as exc:
        try:
            _write_json(
                out / "tee_capture_meta.json",
                {
                    "success": False,
                    "error": str(exc),
                    "performance": {
                        "elapsed_ms": timer.elapsed_ms(),
                        "phase_ms": timer.phase_ms,
                    },
                },
            )
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
