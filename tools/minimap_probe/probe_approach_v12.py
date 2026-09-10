#!/usr/bin/env python3
"""GSPro post-tee ShotState probe v1.2: fail-soft live sensor capture.

Every sensor is independent. A failed PIN OCR, lie OCR, AIM read, or optional green
layer does not destroy the ShotState. currentRound.DistanceToPin is treated as meters
and is converted to yards for post-shot PIN sanity/fallback.

Safety: no W, no Y, no auto-aim recommendation. Existing bounded AIM-card summon may
briefly pulse LEFT/RIGHT and verifies return, exactly as before.
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
import posttee_geometry_v2
import probe as base
import probe_v8
import target_card_v9  # noqa: F401; patches shared target_card reader


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
    p = argparse.ArgumentParser(description="GSPro fail-soft post-tee ShotState probe v1.2")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--lie-roi")
    p.add_argument("--tesseract")
    p.add_argument("--no-aim-summon", action="store_true")
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=60.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    p.add_argument("--deep-debug", action="store_true")
    p.add_argument("--hole-model-path")
    p.add_argument("--no-canonical-geometry", action="store_true")
    p.add_argument("--gspro-dir", default=str(DEFAULT_GSPRO_DIR))
    p.add_argument("--structured-pin-yards", type=float)
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
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


def _save_card(path, screen, state):
    if state is None:
        return
    try:
        x, y, w, h = state.card_bbox
        crop = screen[y:y+h, x:x+w]
        if crop.size:
            cv2.imwrite(str(path), crop)
    except Exception:
        pass


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
            structured_yds = None

    warning_parts = [screen_error] if screen_error else []
    source = None
    resolved = None
    delta = None
    if screen_yds is not None and structured_yds is not None:
        delta = screen_yds - structured_yds
        tolerance = max(3.0, structured_yds * 0.05)
        if abs(delta) <= tolerance:
            resolved, source = screen_yds, "screen-consensus-validated-by-currentRound"
        else:
            resolved, source = structured_yds, "currentRound-meters-to-yards"
            warning_parts.append(
                f"screen PIN {screen_yds:.1f} yd rejected vs structured {structured_yds:.1f} yd"
            )
    elif screen_yds is not None:
        resolved, source = screen_yds, "screen-consensus"
    elif structured_yds is not None:
        resolved, source = structured_yds, "currentRound-meters-to-yards"
        warning_parts.append("screen PIN unavailable; used structured DistanceToPin")

    return {
        "available": resolved is not None,
        "distance_yds": resolved,
        "source": source,
        "screen": _state_dict(screen_state),
        "structured": structured_shot,
        "screen_minus_structured_yds": delta,
        "warning": " | ".join(x for x in warning_parts if x) or None,
    }


def main():
    args = parse_args()
    if args.hole_model_path and args.no_canonical_geometry:
        print("ERROR: choose either --hole-model-path or --no-canonical-geometry, not both.", file=sys.stderr)
        return 2

    out = _out_dir(args.output_root)
    timer = Timer()
    try:
        initial = timer.call("initial_capture", base.capture_monitor, args.monitor)
        minimap, minimap_bbox = base.crop_minimap(initial, args.roi)
        structured, structured_warning = _latest_structured(args)

        def read_pin():
            try:
                state = probe_v8._read_card_type(initial, "pin", args, out if args.deep_debug else None, False)
                return state, None
            except Exception as exc:
                return None, str(exc)

        def read_lie():
            try:
                state = lie_state.read_lie_state(initial, args.tesseract, args.lie_roi, out if args.deep_debug else None)
                return state, None
            except Exception as exc:
                return None, str(exc)

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="approach-v12") as ex:
            pin_future = ex.submit(timer.call, "pin_card_ocr", read_pin)
            lie_future = ex.submit(timer.call, "lie_ocr", read_lie)
            t0 = time.perf_counter()
            try:
                aim_state, aim_meta, aim_screen = probe_v8._acquire_aim(initial, args, out)
                aim_error = None
            except Exception as exc:
                aim_state, aim_screen = None, initial
                aim_meta = {"status": "failed-soft", "attempted": False, "verified_return": None, "warning": str(exc)}
                aim_error = str(exc)
            timer.phase_ms["aim_acquisition"] = round((time.perf_counter() - t0) * 1000.0, 1)
            (pin_state, pin_error) = pin_future.result()
            (lie, lie_error) = lie_future.result()

        pin = _resolve_pin(pin_state, structured, pin_error or structured_warning)
        geometry = None
        geometry_warning = None
        geometry_attempted = bool(args.hole_model_path and not args.no_canonical_geometry and pin["available"])
        if geometry_attempted:
            try:
                geometry = timer.call(
                    "canonical_geometry",
                    posttee_geometry_v2.analyze,
                    current_minimap=minimap,
                    pin_distance_yds=float(pin["distance_yds"]),
                    hole_model_path=args.hole_model_path,
                )
            except Exception as exc:
                geometry_warning = str(exc)
        elif args.no_canonical_geometry or not args.hole_model_path:
            geometry_warning = "canonical geometry intentionally unavailable: no valid tee HoleModel for this hole"
        elif not pin["available"]:
            geometry_warning = "canonical geometry skipped because no trustworthy PIN distance was available"

        state_ready_ms = timer.elapsed_ms()
        payload = {
            "schema_version": "post-tee-shot-state-v1.2",
            "capture_mode": "post-tee",
            "partial_state_allowed": True,
            "pin": pin,
            "aim": _state_dict(aim_state),
            "aim_sensor": {
                "available": aim_state is not None,
                "error": aim_error,
                "acquisition": aim_meta,
            },
            "aim_acquisition": aim_meta,
            "lie_slope": asdict(lie) if lie is not None else None,
            "lie_sensor": {"available": lie is not None, "error": lie_error},
            "structured_current_round": structured,
            "structured_warning": structured_warning,
            "minimap": {
                "available": True,
                "as_presented": "approach_minimap.png",
                "bbox": list(minimap_bbox),
                "zoom_changed": False,
                "heatmap_toggled": False,
            },
            "canonical_geometry_attempted": geometry_attempted,
            "requested_hole_model_path": args.hole_model_path,
            "canonical_geometry": geometry,
            "canonical_geometry_warning": geometry_warning,
            "canonical_geometry_trusted": bool(geometry and geometry.get("geometry_trusted")),
            "wind": None,
            "wind_note": "Use existing Looper wind source; not duplicated here.",
            "performance": {
                "state_ready_ms": state_ready_ms,
                "phase_ms": timer.phase_ms,
                "parallel_ocr": True,
            },
            "created_local": datetime.now().isoformat(timespec="seconds"),
        }
        (out / "shot_state.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        t0 = time.perf_counter()
        cv2.imwrite(str(out / "approach_minimap.png"), minimap)
        if args.deep_debug:
            cv2.imwrite(str(out / "approach_initial_screen.jpg"), initial, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if lie is not None:
            try:
                x, y, w, h = lie.footer_bbox
                if w > 0 and h > 0:
                    cv2.imwrite(str(out / "approach_lie_footer.png"), initial[y:y+h, x:x+w])
            except Exception:
                pass
        _save_card(out / "approach_pin_card.png", initial, pin_state)
        _save_card(out / "approach_aim_card.png", aim_screen, aim_state)
        persist_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        warnings = [x for x in (pin.get("warning"), lie_error, aim_error, geometry_warning) if x]
        meta = {
            "success": True,
            "partial": bool(warnings),
            "warnings": warnings,
            "pin_available": pin["available"],
            "lie_available": lie is not None,
            "aim_available": aim_state is not None,
            "geometry_trusted": bool(geometry and geometry.get("geometry_trusted")),
            "performance": {**payload["performance"], "persist_ms": persist_ms},
        }
        (out / "approach_capture_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        print()
        print("GSPro POST-TEE SHOT STATE PROBE v1.2")
        print("====================================")
        print("FAIL-SOFT: individual sensor failure does not discard ShotState")
        print("W zoom:                NOT USED")
        print("Y heatmap:             NOT USED")
        if pin["available"]:
            print(f"Pin target:            {pin['distance_yds']:.1f} yd | {pin['source']}")
        else:
            print("Pin target:            unavailable")
        print(f"Lie slope:             {lie_state.state_text(lie) if lie is not None else 'unavailable'}")
        print(f"AIM acquisition:       {aim_meta.get('status')}")
        if aim_meta.get("verified_return") is not None:
            print(f"Aim return verified:   {aim_meta.get('verified_return')}")
        if geometry is not None:
            chk = geometry["pin_distance_crosscheck"]
            print(f"Canonical geometry:    {'TRUSTED' if geometry.get('geometry_trusted') else 'REJECTED'}")
            print(f"Pin cross-check:       {chk['canonical_remaining_pin_yds']:.1f} vs {chk['screen_pin_distance_yds']:.1f} yd")
            gv = geometry.get("green_visibility") or {}
            print(f"Green layer:           {'available' if gv.get('available') else 'unavailable'}")
        else:
            print(f"Canonical geometry:    unavailable | {geometry_warning or 'n/a'}")
        for warning in warnings:
            print(f"Warning:               {warning}")
        print(f"ShotState:             {out / 'shot_state.json'}")
        print(f"Capture folder:        {out}")
        return 0

    except Exception as exc:
        # Only infrastructure-level failure (screen/minimap/output) should fail the probe.
        try:
            (out / "approach_capture_meta.json").write_text(
                json.dumps({"success": False, "error": str(exc), "elapsed_ms": timer.elapsed_ms(), "phase_ms": timer.phase_ms}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
