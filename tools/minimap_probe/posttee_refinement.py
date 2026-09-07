#!/usr/bin/env python3
"""Post-tee green refinement orchestration.

This module owns the optional GSPro UI sequence used only when a better approach
GreenSurfaceModel is worthwhile:

1. analyze the as-presented minimap against the cached tee HoleModel;
2. run the pure shot-mode calculation before any W/Y input;
3. if the shot is an approach and the projected target green is cropped, press W one
   bounded pulse at a time;
4. never zoom back in;
5. once the green is usable, perform the field-proven fixed Y toggle pair;
6. isolate the target green using the cached/projected pin anchor;
7. register the refined green back into canonical tee coordinates;
8. confidence-gate the merge into canonical_hole_model.json.

The recommendation engine never contains these UI operations. Timing, bounds, mode
policy, and merge thresholds come from config/looper-live-caddie.json.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import time
from typing import Any

import cv2

import aim_actuator
import green_heatmap
import posttee_geometry
import probe as base
import zoom_recovery

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.assumptions import Assumptions  # noqa: E402
from tools.live_caddie.canonicalize_capture import build_canonical_hole  # noqa: E402
from tools.live_caddie.green_refinement import build_refinement, merge_refinement  # noqa: E402
from tools.live_caddie.shot_mode import (  # noqa: E402
    ShotModeInputs,
    infer_shot_mode,
    polygon_from_canonical_hole,
)


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _heatmap_pair(*, monitor: int, assumptions: Assumptions):
    """Capture one Y-on frame and restore exactly once.

    If the first pulse succeeds but an exception occurs before restore is sent, one
    best-effort restore pulse is attempted. If restore has already been sent, a third
    speculative Y is never issued.
    """
    config = assumptions.get("actuation")
    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find visible GSPro window for Y green refinement")
    hwnd, title = found
    if not aim_actuator.focus_gspro(hwnd, wait_s=0.02):
        raise RuntimeError("Could not safely focus GSPro for Y green refinement")

    pulse_ms = float(config["heatmap_pulse_ms"])
    settle_ms = float(config["heatmap_settle_ms"])
    key = str(config["heatmap_key"])
    first_sent = False
    restore_sent = False

    try:
        aim_actuator.pulse_key_windows(key, pulse_ms)
        first_sent = True
        time.sleep(max(0.0, settle_ms) / 1000.0)
        toggled = base.capture_monitor(monitor)

        if not aim_actuator.focus_gspro(hwnd, wait_s=0.015):
            raise RuntimeError("GSPro lost focus before Y heatmap restore")
        aim_actuator.pulse_key_windows(key, pulse_ms)
        restore_sent = True
        time.sleep(max(0.0, settle_ms) / 1000.0)
        restored = base.capture_monitor(monitor)
        return toggled, restored, title
    finally:
        if first_sent and not restore_sent:
            try:
                if aim_actuator.focus_gspro(hwnd, wait_s=0.015):
                    aim_actuator.pulse_key_windows(key, pulse_ms)
                    time.sleep(max(0.0, settle_ms) / 1000.0)
            except Exception:
                pass


def _geometry_payload(
    *,
    screen,
    roi: str | None,
    pin_distance_yds: float,
    aim_distance_yds: float | None,
    output_root: str | Path,
    round_identity: dict | None,
):
    minimap, bbox = base.crop_minimap(screen, roi)
    geometry = posttee_geometry.analyze(
        current_minimap=minimap,
        pin_distance_yds=float(pin_distance_yds),
        aim_distance_yds=(float(aim_distance_yds) if aim_distance_yds is not None else None),
        output_root=output_root,
        round_identity=round_identity,
    )
    return {
        "screen": screen,
        "minimap": minimap,
        "minimap_bbox": bbox,
        "geometry": geometry,
    }


def _canonical_for_geometry(geometry: dict) -> tuple[dict, Path, dict]:
    selected_hole_model = Path(geometry["hole_model_path"])
    tee_capture_dir = selected_hole_model.parent
    canonical_path = tee_capture_dir / "canonical_hole_model.json"
    if canonical_path.exists():
        canonical_hole = json.loads(canonical_path.read_text(encoding="utf-8"))
    else:
        canonical_hole = build_canonical_hole(tee_capture_dir)
    tee_hole_model = json.loads(selected_hole_model.read_text(encoding="utf-8"))
    return canonical_hole, canonical_path, tee_hole_model


def _resolve_mode(
    *,
    requested_mode: str,
    surface_label: str | None,
    pin_distance_yds: float,
    aim_distance_yds: float | None,
    geometry: dict,
    canonical_hole: dict,
    assumptions: Assumptions,
) -> tuple[str, dict]:
    aim_context = geometry.get("aim_context") or {}
    polygon = polygon_from_canonical_hole(canonical_hole)
    decision = infer_shot_mode(
        ShotModeInputs(
            surface_label=surface_label,
            pin_distance_yds=float(pin_distance_yds),
            aim_distance_yds=(float(aim_distance_yds) if aim_distance_yds is not None else None),
            aim_forward_tee_yds=(
                float(aim_context["tee_relative_forward_yds"])
                if aim_context.get("tee_relative_forward_yds") is not None else None
            ),
            aim_right_tee_yds=(
                float(aim_context["tee_relative_right_yds"])
                if aim_context.get("tee_relative_right_yds") is not None else None
            ),
            canonical_green_polygon=polygon,
            green_context_available=polygon is not None,
        ),
        assumptions=assumptions,
    )
    payload = decision.to_dict()
    requested = str(requested_mode).lower()
    if requested in ("approach", "strategic"):
        payload["diagnostic_override"] = requested
        payload["automatic_mode"] = decision.mode
        return requested, payload

    minimum = float(assumptions.get("shot_mode.minimum_actionable_confidence"))
    if decision.mode in ("approach", "strategic") and decision.confidence < minimum:
        payload["automatic_mode"] = decision.mode
        payload["blocked_by_minimum_actionable_confidence"] = True
        return "unknown", payload
    return decision.mode, payload


def _public_zoom_history(history: list[dict]) -> list[dict]:
    out = []
    for item in history:
        payload = item.get("payload") or {}
        geometry = payload.get("geometry") or {}
        out.append({
            "w_pulses": int(item.get("w_pulses") or 0),
            "visible": bool(item.get("visible")),
            "registration": geometry.get("registration"),
            "green_visibility": geometry.get("green_visibility"),
            "pin_distance_crosscheck": geometry.get("pin_distance_crosscheck"),
        })
    return out


def _no_refinement_result(
    *,
    reason: str,
    first: dict,
    resolved_mode: str,
    shot_mode_decision: dict,
) -> dict[str, Any]:
    return {
        "attempted": False,
        "reason": reason,
        "resolved_mode": resolved_mode,
        "shot_mode_decision": shot_mode_decision,
        "w_pulses": 0,
        "zoom_history": [],
        "heatmap_toggled": False,
        "merge": None,
        "final_geometry": first["geometry"],
        "final_screen": first["screen"],
        "final_minimap": first["minimap"],
    }


def refine_green_if_useful(
    *,
    initial_screen,
    monitor: int,
    roi: str | None,
    pin_distance_yds: float,
    aim_distance_yds: float | None,
    round_identity: dict | None,
    output_root: str | Path,
    capture_dir: str | Path,
    mode: str,
    surface_label: str | None = None,
    assumptions: Assumptions | None = None,
) -> dict[str, Any]:
    assumptions = assumptions or Assumptions.load()
    refinement_cfg = assumptions.get("green_refinement")
    out = Path(capture_dir)
    out.mkdir(parents=True, exist_ok=True)

    first = _geometry_payload(
        screen=initial_screen,
        roi=roi,
        pin_distance_yds=pin_distance_yds,
        aim_distance_yds=aim_distance_yds,
        output_root=output_root,
        round_identity=round_identity,
    )
    first_geometry = first["geometry"]
    canonical_hole, canonical_path, tee_hole_model = _canonical_for_geometry(first_geometry)
    resolved_mode, mode_decision = _resolve_mode(
        requested_mode=mode,
        surface_label=surface_label,
        pin_distance_yds=pin_distance_yds,
        aim_distance_yds=aim_distance_yds,
        geometry=first_geometry,
        canonical_hole=canonical_hole,
        assumptions=assumptions,
    )

    if resolved_mode == "no-full-shot":
        return _no_refinement_result(
            reason="GSPro state is not a full-shot caddie state; no W/Y or recommendation context is needed",
            first=first,
            resolved_mode=resolved_mode,
            shot_mode_decision=mode_decision,
        )
    if resolved_mode == "unknown":
        return _no_refinement_result(
            reason="shot mode is uncertain; skipped mode-dependent W/Y refinement",
            first=first,
            resolved_mode=resolved_mode,
            shot_mode_decision=mode_decision,
        )
    if resolved_mode != "approach":
        return _no_refinement_result(
            reason="strategic shot uses cached HoleModel without approach green refinement",
            first=first,
            resolved_mode=resolved_mode,
            shot_mode_decision=mode_decision,
        )

    maximum_distance = float(refinement_cfg["maximum_auto_refinement_distance_yds"])
    if not bool(refinement_cfg["capture_on_approach"]) or float(pin_distance_yds) > maximum_distance:
        return _no_refinement_result(
            reason="approach green refinement is disabled or beyond configured refinement distance",
            first=first,
            resolved_mode=resolved_mode,
            shot_mode_decision=mode_decision,
        )

    latest = first

    def capture_and_evaluate():
        nonlocal latest
        screen = base.capture_monitor(monitor)
        latest = _geometry_payload(
            screen=screen,
            roi=roi,
            pin_distance_yds=pin_distance_yds,
            aim_distance_yds=aim_distance_yds,
            output_root=output_root,
            round_identity=round_identity,
        )
        visible = bool((latest["geometry"].get("green_visibility") or {}).get("visible"))
        return visible, latest

    initially_visible = bool((first_geometry.get("green_visibility") or {}).get("visible"))
    if initially_visible:
        zoom_ok, w_pulses, zoom_history = True, 0, [
            {"w_pulses": 0, "visible": True, "payload": first}
        ]
    else:
        zoom_ok, w_pulses, _payload, zoom_history = zoom_recovery.recover_until_visible(
            capture_and_evaluate=capture_and_evaluate,
        )

    if not zoom_ok:
        return {
            "attempted": True,
            "reason": "bounded W recovery exhausted before target green became fully usable",
            "resolved_mode": resolved_mode,
            "shot_mode_decision": mode_decision,
            "w_pulses": w_pulses,
            "zoom_history": _public_zoom_history(zoom_history),
            "heatmap_toggled": False,
            "merge": None,
            "final_geometry": latest["geometry"],
            "final_screen": latest["screen"],
            "final_minimap": latest["minimap"],
        }

    normal_screen = latest["screen"]
    geometry = latest["geometry"]
    projected_pin = (geometry.get("current_markers") or {}).get("pin_pixel") or {}
    if "x" not in projected_pin or "y" not in projected_pin:
        raise RuntimeError("canonical pin projection unavailable for post-tee Y refinement")

    toggled_screen, restored_screen, gspro_title = _heatmap_pair(
        monitor=monitor,
        assumptions=assumptions,
    )
    heatmap = green_heatmap.classify_and_extract(
        initial_screen=normal_screen,
        toggled_screen=toggled_screen,
        roi_override=roi,
        debug_dir=(out if bool(refinement_cfg["persist_debug_artifacts"]) else None),
        pin_override_xy=(float(projected_pin["x"]), float(projected_pin["y"])),
    )

    # W may have changed the registration, so refresh the selected canonical objects
    # from the final pre-Y geometry rather than assuming the initial transform.
    canonical_hole, canonical_path, tee_hole_model = _canonical_for_geometry(geometry)
    registration = geometry.get("registration") or {}
    matrix = registration.get("matrix_2x3")
    if matrix is None:
        raise RuntimeError("post-tee registration matrix unavailable for green refinement")

    refinement = build_refinement(
        tee_hole_model=tee_hole_model,
        canonical_hole=canonical_hole,
        current_green_mask=heatmap.target_green_mask,
        current_heatmap=heatmap.heatmap_roi,
        current_pin_xy=(float(projected_pin["x"]), float(projected_pin["y"])),
        registration_matrix=matrix,
        registration_confidence=float(registration.get("confidence") or 0.0),
        heatmap_confidence=float(heatmap.confidence),
        assumptions=assumptions,
    )
    updated_hole, merge = merge_refinement(canonical_hole, refinement, assumptions=assumptions)
    if merge.get("accepted"):
        _write_json(canonical_path, updated_hole)

    if bool(refinement_cfg["persist_debug_artifacts"]):
        cv2.imwrite(str(out / "approach_refinement_normal.png"), latest["minimap"])
        cv2.imwrite(str(out / "approach_refinement_heatmap.png"), heatmap.heatmap_roi)
        cv2.imwrite(str(out / "approach_refinement_green_mask.png"), heatmap.target_green_mask)

    result = {
        "attempted": True,
        "reason": merge.get("reason") or "green refinement completed",
        "resolved_mode": resolved_mode,
        "shot_mode_decision": mode_decision,
        "w_pulses": w_pulses,
        "zoom_history": _public_zoom_history(zoom_history),
        "heatmap_toggled": True,
        "heatmap_confidence": heatmap.confidence,
        "gspro_window_title": gspro_title,
        "refinement": refinement.to_dict(),
        "merge": merge,
        "canonical_hole_model_path": str(canonical_path),
        "final_geometry": geometry,
        "final_screen": restored_screen,
        "final_minimap": heatmap.normal_roi,
    }
    _write_json(out / "green_refinement_meta.json", {
        key: value for key, value in result.items()
        if key not in ("final_screen", "final_minimap")
    })
    return result
