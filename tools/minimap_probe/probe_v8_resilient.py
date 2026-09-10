#!/usr/bin/env python3
"""GSPro tee HoleModel probe v8.1: resilient base model + optional semantics.

The canonical tee minimap, ball/pin markers and scale form the base HoleModel.
Green heatmap and red-penalty extraction are independent semantic layers. A green
extractor failure therefore no longer discards the hole. The before/toggled/restored
minimap pair is persisted before semantic interpretation so failures are replayable.

When the heatmap classifier succeeds, the canonical registration image is the NORMAL
(non-heatmap) minimap, while the heatmap/mask remains a semantic layer. This makes
later post-shot registration compare like-for-like imagery.

Safety: never presses W. The existing Y toggle is restored by the proven helper.
AIM acquisition uses only the existing bounded LEFT/RIGHT return sequence; there are
no extra calibration pulses and no auto-aim recommendation actuation.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import time

import cv2

import green_heatmap
import lie_state
import probe as base
import probe_v2 as v2
import probe_v4  # noqa: F401; installs marker/hazard patches
import probe_v8
import target_card_v9  # noqa: F401; patches shared target-card reader


def parse_args():
    p = argparse.ArgumentParser(description="GSPro resilient tee HoleModel capture v8.1")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--lie-roi")
    p.add_argument("--tesseract")
    p.add_argument("--verify-tee-lie", action="store_true")
    p.add_argument("--deep-debug", action="store_true")
    p.add_argument("--heatmap-key", default="Y")
    p.add_argument("--heatmap-settle-ms", type=float, default=320.0)
    p.add_argument("--heatmap-pulse-ms", type=float, default=45.0)
    p.add_argument("--corridor", type=float, default=40.0)
    p.add_argument("--centerline-band", type=float, default=4.0)
    p.add_argument("--merge-gap", type=float, default=4.0)
    p.add_argument("--no-aim-summon", action="store_true")
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=60.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    p.add_argument("--pin-distance-fallback-yds", type=float)
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def _capture_dir(root):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    out = Path(root) / f"tee_capture_{stamp}"
    out.mkdir(parents=True, exist_ok=False)
    return out


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


def _write_json(path, payload):
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _pin_fallback(args):
    if args.pin_distance_fallback_yds is not None:
        return float(args.pin_distance_fallback_yds), "argument"
    raw = os.environ.get("LOOPER_TEE_PIN_FALLBACK_YDS")
    if raw:
        try:
            return float(raw), "watcher-readiness"
        except Exception:
            pass
    return None, None


def _safe_pin(initial, args, out):
    state = None
    error = None
    try:
        state = probe_v8._read_card_type(
            initial,
            "pin",
            args,
            out if args.deep_debug else None,
            False,
        )
    except Exception as exc:
        error = str(exc)

    fallback, fallback_source = _pin_fallback(args)
    if state is not None:
        screen = float(state.distance_yds)
        if fallback is not None and abs(screen - fallback) > max(3.0, fallback * 0.05):
            return state, fallback, "watcher-tee-distance-fallback", (
                f"screen PIN {screen:.1f} rejected vs watcher tee distance {fallback:.1f}"
            )
        return state, screen, "screen-consensus", error
    if fallback is not None:
        return None, fallback, f"{fallback_source}-tee-distance-fallback", error
    return None, None, None, error or "PIN distance unavailable"


def _save_minimap(path, screen, roi):
    try:
        crop, _ = base.crop_minimap(screen, roi)
        cv2.imwrite(str(path), crop)
        return crop
    except Exception:
        return None


def _safe_green(initial, toggled, args, out):
    try:
        return green_heatmap.classify_and_extract(
            initial_screen=initial,
            toggled_screen=toggled,
            roi_override=args.roi,
            debug_dir=out,
        ), None
    except Exception as exc:
        try:
            (out / "green_extraction_error.txt").write_text(str(exc), encoding="utf-8")
        except Exception:
            pass
        return None, str(exc)


def _normal_fallback(initial_roi, toggled_roi):
    """Choose the less heatmap-like frame when the full green extractor failed.

    The result contains a `trusted_for_red_penalty` flag. We still run red-boundary
    CV when uncertain so the corpus contains candidates, but those objects are marked
    diagnostic-only rather than safe for strategy.
    """
    if toggled_roi is None:
        return initial_roi, {
            "mode": "initial-only",
            "trusted_for_red_penalty": False,
            "score_initial": None,
            "score_toggled": None,
            "separation": None,
        }
    try:
        pin_i = v2.detect_pin_marker(initial_roi)
        pin_t = v2.detect_pin_marker(toggled_roi)
        score_i = float(green_heatmap._heatmap_color_score(initial_roi, pin_i))
        score_t = float(green_heatmap._heatmap_color_score(toggled_roi, pin_t))
        total = score_i + score_t
        separation = abs(score_i - score_t) / max(total, 1.0)
        if total <= 1.0:
            # Neither frame looks heatmap-like near the pin; either is suitable as
            # an as-presented canonical image and red heatmap contamination is low.
            return initial_roi, {
                "mode": "neither-frame-heatmap-like",
                "trusted_for_red_penalty": True,
                "score_initial": score_i,
                "score_toggled": score_t,
                "separation": separation,
            }
        chosen = initial_roi if score_i <= score_t else toggled_roi
        return chosen, {
            "mode": "lower-heatmap-score",
            "trusted_for_red_penalty": separation >= 0.12,
            "score_initial": score_i,
            "score_toggled": score_t,
            "separation": separation,
        }
    except Exception as exc:
        return initial_roi, {
            "mode": "fallback-scoring-failed",
            "trusted_for_red_penalty": False,
            "warning": str(exc),
            "score_initial": None,
            "score_toggled": None,
            "separation": None,
        }


def main():
    args = parse_args()
    out = _capture_dir(args.output_root)
    started = time.perf_counter()
    warnings = []

    try:
        initial = base.capture_monitor(args.monitor)
        initial_minimap, minimap_bbox = base.crop_minimap(initial, args.roi)

        if args.verify_tee_lie:
            try:
                lie = lie_state.read_lie_state(
                    initial,
                    args.tesseract,
                    args.lie_roi,
                    out if args.deep_debug else None,
                )
                lie_warning = None
            except Exception as exc:
                lie = probe_v8._tee_flat_lie()
                lie_warning = str(exc)
                warnings.append(f"tee lie verification: {exc}")
        else:
            lie = probe_v8._tee_flat_lie()
            lie_warning = None

        toggled = None
        restored = initial
        gspro_title = None
        toggle_warning = None
        green = None
        green_warning = None

        # Preserve the old fast shape: PIN OCR overlaps the Y toggle; green CV then
        # overlaps the existing AIM-card acquisition.
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="tee-resilient") as executor:
            pin_future = executor.submit(_safe_pin, initial, args, out)
            try:
                toggled, restored, gspro_title = probe_v8._toggle_heatmap_pair(
                    initial_screen=initial,
                    monitor=args.monitor,
                    key=args.heatmap_key,
                    pulse_ms=args.heatmap_pulse_ms,
                    settle_ms=args.heatmap_settle_ms,
                )
            except Exception as exc:
                toggle_warning = str(exc)
                warnings.append(f"heatmap toggle: {exc}")

            # Persist compact raw minimap evidence before any semantic extractor can
            # fail. This is intentionally cheap and gives us replayable Y evidence.
            cv2.imwrite(str(out / "tee_initial_minimap.png"), initial_minimap)
            toggled_minimap = None
            if toggled is not None:
                toggled_minimap = _save_minimap(out / "tee_toggled_minimap.png", toggled, args.roi)
            if restored is not None:
                _save_minimap(out / "tee_restored_minimap.png", restored, args.roi)

            green_future = (
                executor.submit(_safe_green, initial, toggled, args, out)
                if toggled is not None
                else None
            )

            aim_state = None
            aim_screen = restored
            if toggle_warning is not None:
                aim_meta = {
                    "status": "skipped-after-heatmap-toggle-error",
                    "attempted": False,
                    "verified_return": None,
                    "warning": "AIM actuation skipped because heatmap restore state was uncertain.",
                }
            else:
                try:
                    aim_state, aim_meta, aim_screen = probe_v8._acquire_aim(restored, args, out)
                except Exception as exc:
                    aim_meta = {
                        "status": "failed-soft",
                        "attempted": False,
                        "verified_return": None,
                        "warning": str(exc),
                    }
                    warnings.append(f"aim: {exc}")

            pin_state, pin_yds, pin_source, pin_warning = pin_future.result()
            if green_future is not None:
                green, green_warning = green_future.result()
            elif toggle_warning:
                green_warning = toggle_warning

        if pin_warning:
            warnings.append(f"pin: {pin_warning}")
        if green_warning:
            warnings.append(f"green semantic layer: {green_warning}")

        if green is not None:
            canonical = green.normal_roi
            canonical_mode = "normal-frame-from-heatmap-pair"
            normal_selection = {
                "mode": "green-classifier-resolved-normal-frame",
                "trusted_for_red_penalty": True,
                "score_initial": None,
                "score_toggled": None,
                "separation": None,
            }
            hazard_roi = green_heatmap.hazard_safe_roi(green)
        else:
            canonical, normal_selection = _normal_fallback(initial_minimap, toggled_minimap)
            canonical_mode = f"fallback-{normal_selection['mode']}"
            hazard_roi = canonical.copy()

        cv2.imwrite(str(out / "tee_canonical_minimap.png"), canonical)
        cv2.imwrite(str(out / "tee_hazard_safe_minimap.png"), hazard_roi)

        ball = pin = None
        scale = pin_pixels = None
        base_warning = None
        if pin_yds is None:
            base_warning = "base geometry unavailable: no trustworthy tee PIN distance"
        else:
            try:
                ball = v2.detect_ball_marker(canonical)
                pin = v2.detect_pin_marker(canonical)
                pin_pixels = float(((pin.x - ball.x) ** 2 + (pin.y - ball.y) ** 2) ** 0.5)
                if pin_pixels < 10:
                    raise RuntimeError("ball/pin separation too small for tee calibration")
                scale = float(pin_yds) / pin_pixels
                if not (0.03 <= scale <= 3.0):
                    raise RuntimeError(f"implausible tee minimap scale {scale:.4f} yd/px")
            except Exception as exc:
                base_warning = str(exc)
        base_available = bool(ball is not None and pin is not None and scale is not None)
        if base_warning:
            warnings.append(f"base geometry: {base_warning}")

        hazards = []
        hazard_error = None
        if base_available:
            try:
                hazards, _pin_pixels2, _scale2 = v2.build_penalty_objects(
                    roi=hazard_roi,
                    ball=ball,
                    pin=pin,
                    distance_to_pin_yds=float(pin_yds),
                    corridor_half_width_yds=args.corridor,
                    centerline_band_yds=args.centerline_band,
                    merge_gap_yds=args.merge_gap,
                )
            except Exception as exc:
                hazard_error = str(exc)
                warnings.append(f"penalty semantic layer: {exc}")
        else:
            hazard_error = "skipped because base geometry unavailable"

        hazard_available = hazard_error is None
        hazard_trusted = bool(
            hazard_available and normal_selection.get("trusted_for_red_penalty")
        )
        if hazard_available and not hazard_trusted:
            warnings.append(
                "penalty candidates retained as diagnostic-only because heatmap-off state was uncertain"
            )

        green_payload = {
            "available": green is not None,
            "warning": green_warning,
            "source": "GSPro tee minimap Y heatmap",
        }
        if green is not None:
            green_payload.update({
                "target_green_mask": "tee_target_green_mask.png",
                "debug_overlay": "tee_green_debug_overlay.png",
                "heatmap_minimap": "tee_heatmap_minimap.png",
                "heatmap_confidence": green.confidence,
                "changed_pixel_ratio": green.changed_pixel_ratio,
                "target_green_area_px": green.target_green_area_px,
                "target_green_bbox": list(green.target_green_bbox),
                "pin_distance_to_mask_px": green.pin_distance_to_mask_px,
                "heatmap_was_initial_state": green.heatmap_is_initial,
            })

        minimap_payload = {
            "bbox": list(minimap_bbox),
            "zoom_changed": False,
            "tee_rule": "never zoom at tee",
            "canonical_mode": canonical_mode,
        }
        if base_available:
            minimap_payload.update({
                "ball_pixel": {"x": ball.x, "y": ball.y},
                "pin_pixel": {"x": pin.x, "y": pin.y},
                "ball_to_pin_pixels": pin_pixels,
                "yards_per_pixel": scale,
            })

        hole_model = {
            "schema_version": "tee-hole-model-v0",
            "model_revision": "8.1-resilient-normal-canonical",
            "capture_mode": "tee",
            "canonical_minimap": "tee_canonical_minimap.png",
            "base_geometry": {
                "available": base_available,
                "warning": base_warning,
                "pin_distance_yds": pin_yds,
                "pin_distance_source": pin_source,
            },
            "minimap": minimap_payload,
            "hazards": {
                "penalty_objects": [asdict(item) for item in hazards],
                "available": hazard_available,
                "trusted_for_strategy": hazard_trusted,
                "diagnostic_only": bool(hazard_available and not hazard_trusted),
                "warning": hazard_error,
                "normal_frame_selection": normal_selection,
                "source": "red-boundary CV on heatmap-safe/as-presented canonical minimap",
            },
            "green_surface": green_payload,
            "semantic_layers": {
                "green": "ready" if green is not None else "unavailable",
                "penalty": (
                    "ready" if hazard_trusted else
                    "diagnostic" if hazard_available else
                    "unavailable"
                ),
                "bunker": "not-promoted-yet",
                "water": "not-promoted-yet",
            },
            "capture": {
                "gspro_window_title": gspro_title,
                "heatmap_key": args.heatmap_key,
                "heatmap_settle_ms": args.heatmap_settle_ms,
                "heatmap_pair_available": toggled is not None,
                "heatmap_toggle_warning": toggle_warning,
                "created_local": datetime.now().isoformat(timespec="seconds"),
                "warnings": warnings,
            },
        }
        shot_state = {
            "schema_version": "tee-shot-state-v0.1",
            "capture_mode": "tee",
            "pin": {
                "available": pin_yds is not None,
                "distance_yds": pin_yds,
                "source": pin_source,
                "screen": _state_dict(pin_state),
                "warning": pin_warning,
            },
            "aim": _state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "lie_surface": "tee",
            "lie_slope": asdict(lie),
            "lie_warning": lie_warning,
            "partial_state_allowed": True,
            "warnings": warnings,
        }

        _write_json(out / "hole_model.json", hole_model)
        _write_json(out / "shot_state.json", shot_state)

        # Keep full-screen diagnostics compact; the useful raw replay inputs above are
        # minimap crops. DeepDebug remains opt-in from the child probe perspective.
        if args.deep_debug:
            cv2.imwrite(
                str(out / "tee_initial_screen.jpg"),
                initial,
                [int(cv2.IMWRITE_JPEG_QUALITY), 88],
            )
            if toggled is not None:
                cv2.imwrite(
                    str(out / "tee_toggled_screen.jpg"),
                    toggled,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 88],
                )
            if restored is not None:
                cv2.imwrite(
                    str(out / "tee_restored_screen.jpg"),
                    restored,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 88],
                )
        try:
            probe_v8._write_card_crop(out / "latest_pin_card_v6.png", initial, pin_state)
            probe_v8._write_card_crop(out / "latest_aim_card_v6.png", aim_screen, aim_state)
        except Exception:
            pass

        elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
        meta = {
            "success": True,
            "partial": bool(warnings),
            "base_geometry_available": base_available,
            "green_available": green is not None,
            "penalty_available": hazard_available,
            "penalty_trusted_for_strategy": hazard_trusted,
            "penalty_object_count": len(hazards),
            "heatmap_pair_available": toggled is not None,
            "canonical_mode": canonical_mode,
            "warnings": warnings,
            "elapsed_ms": elapsed_ms,
        }
        _write_json(out / "tee_capture_meta.json", meta)

        if args.json:
            print(json.dumps({"hole_model": hole_model, "shot_state": shot_state, "meta": meta}, indent=2))
            return 0

        print()
        print("GSPro TEE CAPTURE ORCHESTRATOR v8.1 RESILIENT")
        print("=============================================")
        print(f"Base HoleModel:        {'READY' if base_available else 'UNAVAILABLE'}")
        if pin_yds is not None:
            print(f"Pin target:            {pin_yds:.1f} yd | {pin_source}")
        else:
            print("Pin target:            unavailable")
        print(f"Canonical map:         {canonical_mode}")
        print(f"Green semantic layer:  {'READY' if green is not None else 'UNAVAILABLE (base retained)'}")
        if hazard_available:
            mode = "TRUSTED" if hazard_trusted else "DIAGNOSTIC ONLY"
            print(f"Red penalty layer:     {mode} | {len(hazards)} objects")
        else:
            print("Red penalty layer:     UNAVAILABLE")
        print("Bunker/water layers:   NOT PROMOTED YET")
        print(f"AIM acquisition:       {aim_meta.get('status')}")
        if aim_meta.get("verified_return") is not None:
            print(f"Aim return verified:   {aim_meta.get('verified_return')}")
        for warning in warnings:
            print(f"Warning:               {warning}")
        print(f"HoleModel:             {out / 'hole_model.json'}")
        print(f"Canonical minimap:     {out / 'tee_canonical_minimap.png'}")
        print(f"Capture folder:        {out}")
        return 0

    except Exception as exc:
        try:
            _write_json(
                out / "tee_capture_meta.json",
                {
                    "success": False,
                    "error": str(exc),
                    "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 1),
                },
            )
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
