#!/usr/bin/env python3
"""GSPro post-shot ShotState v1.4: structured world position + PIN + lie + wind.

Production live placement now comes from currentRound world coordinates projected
through hole_spatial_model_v1. Post-shot AIM and minimap registration are retired
from the live capture path. This probe keeps only the dynamic sensors still needed:
structured currentRound state, resolved PIN distance, lie slope, and screen wind.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import cv2

import gspro_structured
import lie_state
import probe as base
import probe_v8
import target_card_v9  # noqa: F401; patches shared target-card reader
import wind_state

DEFAULT_GSPRO_DIR = Path.home() / "AppData" / "LocalLow" / "GSPro" / "GSPro"


class Timer:
    def __init__(self):
        self.start = time.perf_counter()
        self.phase_ms = {}

    def call(self, name, fn, *args, **kwargs):
        t0 = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            self.phase_ms[name] = round((time.perf_counter() - t0) * 1000.0, 1)

    def elapsed_ms(self):
        return round((time.perf_counter() - self.start) * 1000.0, 1)


def parse_args():
    p = argparse.ArgumentParser(description="GSPro post-shot ShotState probe v1.4")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--lie-roi")
    p.add_argument("--wind-roi")
    p.add_argument("--tesseract")
    p.add_argument("--gspro-dir", default=str(DEFAULT_GSPRO_DIR))
    p.add_argument("--structured-pin-yards", type=float)
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    p.add_argument("--deep-debug", action="store_true")
    return p.parse_args()


def _out_dir(root):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    p = Path(root) / f"approach_capture_{stamp}"
    p.mkdir(parents=True, exist_ok=False)
    return p


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
        "distance_ocr_raw": getattr(state, "distance_ocr_raw", None),
    }


def _latest_structured(args):
    warning = None
    shot = None
    try:
        shot = gspro_structured.read_latest_current_round(Path(args.gspro_dir))
    except Exception as exc:
        warning = str(exc)
    env_value = os.environ.get("LOOPER_STRUCTURED_PIN_YDS")
    explicit = args.structured_pin_yards
    if explicit is None and env_value:
        try:
            explicit = float(env_value)
        except Exception:
            pass
    if explicit is not None:
        if shot is None:
            shot = {}
        shot = dict(shot)
        shot["distance_to_pin_yds"] = float(explicit)
        shot["distance_source"] = "watcher-structured-currentRound"
    return shot, warning


def _resolve_pin(screen_state, structured_shot, screen_error):
    screen_yds = float(screen_state.distance_yds) if screen_state is not None else None
    structured_yds = None
    if structured_shot:
        try:
            value = structured_shot.get("distance_to_pin_yds")
            structured_yds = float(value) if value is not None else None
        except Exception:
            pass
    warnings = [screen_error] if screen_error else []
    resolved = source = delta = None
    if screen_yds is not None and structured_yds is not None:
        delta = screen_yds - structured_yds
        tolerance = max(3.0, structured_yds * 0.05)
        if abs(delta) <= tolerance:
            resolved, source = screen_yds, "screen-consensus-validated-by-currentRound"
        else:
            resolved, source = structured_yds, "currentRound-meters-to-yards"
            warnings.append(f"screen PIN {screen_yds:.1f} yd rejected vs structured {structured_yds:.1f} yd")
    elif screen_yds is not None:
        resolved, source = screen_yds, "screen-consensus"
    elif structured_yds is not None:
        resolved, source = structured_yds, "currentRound-meters-to-yards"
        warnings.append("screen PIN unavailable; used structured DistanceToPin")
    return {
        "available": resolved is not None,
        "distance_yds": resolved,
        "source": source,
        "screen": _state_dict(screen_state),
        "structured": structured_shot,
        "screen_minus_structured_yds": delta,
        "warning": " | ".join(x for x in warnings if x) or None,
    }


def main():
    args = parse_args()
    out = _out_dir(args.output_root)
    timer = Timer()
    try:
        initial = timer.call("initial_capture", base.capture_monitor, args.monitor)
        structured, structured_warning = _latest_structured(args)

        def read_pin():
            try:
                return probe_v8._read_card_type(initial, "pin", args, out if args.deep_debug else None, False), None
            except Exception as exc:
                return None, str(exc)

        def read_lie():
            try:
                return lie_state.read_lie_state(initial, args.tesseract, args.lie_roi, out if args.deep_debug else None), None
            except Exception as exc:
                return None, str(exc)

        def read_wind():
            try:
                return wind_state.read_wind_state(initial, args.tesseract, args.wind_roi, out if args.deep_debug else None), None
            except Exception as exc:
                return None, str(exc)

        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="approach-v14") as ex:
            pin_future = ex.submit(timer.call, "pin_card_ocr", read_pin)
            lie_future = ex.submit(timer.call, "lie_ocr", read_lie)
            wind_future = ex.submit(timer.call, "wind_ocr", read_wind)
            pin_state, pin_error = pin_future.result()
            lie, lie_error = lie_future.result()
            wind, wind_error = wind_future.result()

        pin = _resolve_pin(pin_state, structured, pin_error or structured_warning)
        wind_payload = asdict(wind) if wind is not None else {
            "speed_mph": None,
            "direction_cardinal": None,
            "available": False,
            "confidence": 0.0,
            "source": "gspro-screen-wind-panel",
            "direction_semantics": "gspro-display",
        }
        payload = {
            "schema_version": "post-tee-shot-state-v1.4",
            "capture_mode": "post-tee",
            "partial_state_allowed": True,
            "position_authority": "structured_current_round_world_coordinates",
            "pin": pin,
            "lie_slope": asdict(lie) if lie is not None else None,
            "lie_sensor": {"available": lie is not None, "error": lie_error},
            "wind": wind_payload,
            "wind_sensor": {
                "available": bool(wind is not None and wind.available),
                "error": wind_error,
                "source": "gspro-screen-wind-panel",
            },
            "structured_current_round": structured,
            "structured_warning": structured_warning,
            "aim": None,
            "aim_sensor": {"available": False, "retired_from_live_path": True},
            "canonical_geometry": None,
            "canonical_geometry_trusted": False,
            "canonical_geometry_warning": "retired from live path; use hole_spatial_model_v1 + structured world position",
            "performance": {
                "state_ready_ms": timer.elapsed_ms(),
                "phase_ms": timer.phase_ms,
                "parallel_ocr": True,
            },
            "created_local": datetime.now().isoformat(timespec="seconds"),
        }
        (out / "shot_state.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        if args.deep_debug:
            cv2.imwrite(str(out / "approach_initial_screen.jpg"), initial, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if lie is not None:
            try:
                x, y, w, h = lie.footer_bbox
                if w > 0 and h > 0:
                    cv2.imwrite(str(out / "approach_lie_footer.png"), initial[y:y+h, x:x+w])
            except Exception:
                pass
        warnings = [x for x in (pin.get("warning"), lie_error, wind_error, structured_warning) if x]
        if wind is not None and not wind.available:
            warnings.append(
                f"wind OCR partial/unavailable: speed={wind.speed_ocr_raw!r}, direction={wind.direction_ocr_raw!r}"
            )
        (out / "approach_capture_meta.json").write_text(json.dumps({
            "success": True,
            "partial": bool(warnings),
            "warnings": warnings,
            "pin_available": pin["available"],
            "lie_available": lie is not None,
            "wind_available": bool(wind is not None and wind.available),
            "position_authority": "structured_current_round_world_coordinates",
            "aim_retired": True,
            "posttee_registration_retired": True,
        }, indent=2), encoding="utf-8")
        print("GSPro POST-SHOT STATE v1.4 | structured world position + PIN + lie + wind")
        print(f"ShotState: {out / 'shot_state.json'}")
        return 0
    except Exception as exc:
        try:
            (out / "approach_capture_meta.json").write_text(json.dumps({"success": False, "error": str(exc)}, indent=2), encoding="utf-8")
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
