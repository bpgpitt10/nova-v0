#!/usr/bin/env python3
"""Post-tee green refinement orchestration.

This module owns the optional GSPro UI sequence used only when a better approach
GreenSurfaceModel is worthwhile:

1. analyze the as-presented minimap against the cached tee HoleModel;
2. if the projected target green is cropped, press W one bounded pulse at a time;
3. never zoom back in;
4. once the green is usable, perform the field-proven fixed Y toggle pair;
5. isolate the target green using the cached/projected pin anchor;
6. register the refined green back into canonical tee coordinates;
7. confidence-gate the merge into canonical_hole_model.json.

The recommendation engine never contains these UI operations. Timing, bounds, and
merge thresholds come from config/looper-live-caddie.json.
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


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _heatmap_pair(*, monitor: int, assumptions: Assumptions):
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

    aim_actuator.pulse_key_windows(key, pulse_ms)
    time.sleep(max(0.0, settle_ms) / 1000.0)
    toggled = base.capture_monitor(monitor)

    # Restore exactly once using the field-proven fixed timing. We intentionally do
    # not retry speculative third toggles because that can leave GSPro in the wrong state.
    aim_actuator.pulse_key_windows(key, pulse_ms)
    time.sleep(max(0.0, settle_ms) / 1000.0)
    restored = base.capture_monitor(monitor)
    return toggled, restored, title


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

    maximum_distance = float(refinement_cfg["maximum_auto_refinement_distance_yds"])
    should_refine = (
        str(mode).lower() == "approach"
        and bool(refinement_cfg["capture_on_approach"])
        and float(pin_distance_yds) <= maximum_distance
    )
    if not should_refine:
        return {
            "attempted": False,
            "reason": "green refinement not required for this shot mode/distance",
            "w_pulses": 0,
            "zoom_history": [],
            "heatmap_toggled": False,
            "merge": None,
            "final_geometry": first_geometry,
            "final_screen": initial_screen,
            "final_minimap": first["minimap"],
        }

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

    selected_hole_model = Path(geometry["hole_model_path"])
    tee_capture_dir = selected_hole_model.parent
    canonical_path = tee_capture_dir / "canonical_hole_model.json"
    if canonical_path.exists():
        canonical_hole = json.loads(canonical_path.read_text(encoding="utf-8"))
    else:
        canonical_hole = build_canonical_hole(tee_capture_dir)
    tee_hole_model = json.loads(selected_hole_model.read_text(encoding="utf-8"))

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
