#!/usr/bin/env python3
"""Validate a tee red-boundary crossing against an independent GSPro hazard event.

The 2026-09-11 FarmLinks Hole 3 corpus contains a useful third-point validation:
- two post-tee screenshots give current-ball locations in canonical tee coordinates;
- the matching currentRound records give those same balls in GSPro world X/Z;
- those two paired points establish an observed world->hole-local similarity transform;
- GSPro independently recorded a non-zero HazardLastPointOfEntry for the first shot;
- the tee red-line extractor independently recorded centerline crossings.

Projecting the GSPro hazard-entry point through the observed transform lets us test
whether the red-line crossing lands at the same physical place. The transform is
fitted only from ball positions; the hazard entry is not used to fit it, so the
hazard check is independent evidence rather than circular calibration.

Saved evidence only. No GSPro input. No API calls. No strategy authority.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import posttee_geometry_v2

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE / "output"
DEFAULT_TEE = "tee_capture_20260911_211018_339043"
DEFAULT_A = "approach_capture_20260911_211118_485845"
DEFAULT_B = "approach_capture_20260911_211149_959082"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def current_world_xz(shot_state: dict[str, Any]) -> np.ndarray:
    structured = shot_state.get("structured_current_round") or {}
    # The screenshot is captured after the latest completed shot, so the live ball
    # is that shot's EndingPOS, not StartingPOS.
    position = structured.get("ending_pos") or {}
    return np.asarray([float(position["x"]), float(position["z"])], dtype=float)


def hazard_entry_xz(shot_state: dict[str, Any]) -> np.ndarray:
    structured = shot_state.get("structured_current_round") or {}
    entry = structured.get("hazard_last_point_of_entry") or {}
    point = np.asarray([float(entry.get("x", 0.0)), float(entry.get("z", 0.0))], dtype=float)
    if float(np.linalg.norm(point)) < 1e-6:
        raise RuntimeError("structured shot has no non-zero HazardLastPointOfEntry")
    return point


def resolved_pin_yds(shot_state: dict[str, Any]) -> float:
    pin = shot_state.get("pin") or {}
    value = pin.get("distance_yds")
    if value is None:
        structured = shot_state.get("structured_current_round") or {}
        value = structured.get("distance_to_pin_yds")
    if value is None:
        raise RuntimeError("approach ShotState has no resolved PIN distance")
    return float(value)


def replay_local(capture: Path, tee_model: Path) -> tuple[np.ndarray, dict[str, Any]]:
    state = read_json(capture / "shot_state.json")
    image = cv2.imread(str(capture / "approach_minimap.png"), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"approach_minimap.png unreadable in {capture}")
    geometry = posttee_geometry_v2.analyze(
        current_minimap=image,
        pin_distance_yds=resolved_pin_yds(state),
        hole_model_path=tee_model,
    )
    if not geometry.get("geometry_trusted"):
        raise RuntimeError(f"post-tee geometry not trusted for {capture.name}: {geometry.get('geometry_rejection_reason')}")
    pos = geometry.get("canonical_position") or {}
    # Local X = lateral right-positive, local Y = forward from tee toward canonical pin.
    local = np.asarray([
        float(pos["tee_relative_lateral_yds"]),
        float(pos["tee_relative_forward_yds"]),
    ], dtype=float)
    return local, geometry


def similarity_from_two(world_a: np.ndarray, world_b: np.ndarray, local_a: np.ndarray, local_b: np.ndarray):
    dw = world_b - world_a
    dl = local_b - local_a
    nw = float(np.linalg.norm(dw))
    nl = float(np.linalg.norm(dl))
    if nw < 10.0 or nl < 10.0:
        raise RuntimeError("paired ball observations are too close to establish a stable world/local transform")
    scale = nl / nw
    world_angle = math.atan2(float(dw[1]), float(dw[0]))
    local_angle = math.atan2(float(dl[1]), float(dl[0]))
    theta = local_angle - world_angle
    c, s = math.cos(theta), math.sin(theta)
    rotation = np.asarray([[c, -s], [s, c]], dtype=float)
    translation = local_a - scale * (rotation @ world_a)
    return scale, rotation, translation, math.degrees(theta)


def transform(scale: float, rotation: np.ndarray, translation: np.ndarray, point: np.ndarray) -> np.ndarray:
    return scale * (rotation @ point) + translation


def red_crossings(hole_model: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in ((hole_model.get("hazards") or {}).get("penalty_objects") or []):
        for crossing in item.get("centerline_crossings_yds") or []:
            rows.append({
                "object_id": item.get("object_id"),
                "forward_yds": float(crossing),
                "median_lateral_yds": item.get("median_lateral_yds"),
            })
    return rows


def validate(root: Path, tee_name: str, approach_a_name: str, approach_b_name: str, tolerance_forward: float, tolerance_lateral: float) -> dict[str, Any]:
    tee = root / tee_name
    approach_a = root / approach_a_name
    approach_b = root / approach_b_name
    tee_model_path = tee / "hole_model.json"
    hole_model = read_json(tee_model_path)
    state_a = read_json(approach_a / "shot_state.json")
    state_b = read_json(approach_b / "shot_state.json")

    local_a, geometry_a = replay_local(approach_a, tee_model_path)
    local_b, geometry_b = replay_local(approach_b, tee_model_path)
    world_a = current_world_xz(state_a)
    world_b = current_world_xz(state_b)
    scale, rotation, translation, rotation_deg = similarity_from_two(world_a, world_b, local_a, local_b)

    entry_world = hazard_entry_xz(state_a)
    entry_local = transform(scale, rotation, translation, entry_world)
    crossings = red_crossings(hole_model)
    if not crossings:
        raise RuntimeError("tee HoleModel contains no red centerline crossings")
    nearest = min(crossings, key=lambda row: abs(float(row["forward_yds"]) - float(entry_local[1])))
    forward_error = float(nearest["forward_yds"]) - float(entry_local[1])
    lateral_error = float(entry_local[0])

    # GSPro world units on this corpus behave approximately like meters; a fitted
    # yards/world-unit scale near meters->yards is a useful transform sanity check,
    # not an assumption used to compute the result.
    yards_per_meter = 1.0936132983377078
    scale_vs_meter_ratio = scale / yards_per_meter
    transform_sane = bool(0.85 <= scale_vs_meter_ratio <= 1.15)
    validated = bool(
        transform_sane
        and abs(forward_error) <= float(tolerance_forward)
        and abs(lateral_error) <= float(tolerance_lateral)
    )

    return {
        "schema_version": "looper-red-penalty-field-validation-v0",
        "course_key": "farmlinks_al_2_7_gsp",
        "hole_display": 3,
        "tee_capture": tee_name,
        "paired_approach_captures": [approach_a_name, approach_b_name],
        "paired_world_xz": [world_a.tolist(), world_b.tolist()],
        "paired_hole_local_yards": [local_a.tolist(), local_b.tolist()],
        "observed_world_to_local_similarity": {
            "yards_per_world_unit": scale,
            "rotation_deg": rotation_deg,
            "translation": translation.tolist(),
            "yards_per_world_unit_vs_meter_conversion_ratio": scale_vs_meter_ratio,
            "sanity_ok": transform_sane,
        },
        "independent_hazard_entry_world_xz": entry_world.tolist(),
        "projected_hazard_entry_hole_local_yards": {
            "lateral_right_positive": float(entry_local[0]),
            "forward_from_tee": float(entry_local[1]),
        },
        "tee_red_centerline_crossings": crossings,
        "nearest_red_crossing": nearest,
        "forward_error_yds": forward_error,
        "entry_lateral_from_centerline_yds": lateral_error,
        "tolerances": {
            "forward_abs_yds": float(tolerance_forward),
            "lateral_abs_yds": float(tolerance_lateral),
        },
        "validated": validated,
        "validation_interpretation": (
            "independent GSPro HazardLastPointOfEntry agrees with tee red-boundary CV"
            if validated else
            "field event does not validate the nearest tee red-boundary crossing under current tolerances"
        ),
        "registration_modes": [
            (geometry_a.get("registration") or {}).get("acceptance_mode"),
            (geometry_b.get("registration") or {}).get("acceptance_mode"),
        ],
        "strategy_authority": False,
        "promotion_decision": "none",
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate FarmLinks H3 red CV against GSPro physical hazard entry")
    p.add_argument("--output-root", default=str(DEFAULT_ROOT))
    p.add_argument("--tee", default=DEFAULT_TEE)
    p.add_argument("--approach-a", default=DEFAULT_A)
    p.add_argument("--approach-b", default=DEFAULT_B)
    p.add_argument("--forward-tolerance-yds", type=float, default=3.0)
    p.add_argument("--lateral-tolerance-yds", type=float, default=3.0)
    p.add_argument("--output")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    payload = validate(
        root,
        args.tee,
        args.approach_a,
        args.approach_b,
        args.forward_tolerance_yds,
        args.lateral_tolerance_yds,
    )
    output = Path(args.output).expanduser().resolve() if args.output else root / "red_penalty_field_validation_20260911.json"
    write_json(output, payload)
    status = "PASS" if payload["validated"] else "FAIL"
    entry = payload["projected_hazard_entry_hole_local_yards"]
    crossing = payload["nearest_red_crossing"]
    print(
        f"{status} red penalty field validation | entry={entry['forward_from_tee']:.2f} yd forward, "
        f"{entry['lateral_right_positive']:.2f} yd lateral | CV crossing={crossing['forward_yds']:.2f} yd | "
        f"forward_error={payload['forward_error_yds']:.2f} yd"
    )
    print(f"Observed world scale={payload['observed_world_to_local_similarity']['yards_per_world_unit']:.4f} yd/unit")
    print(f"Output: {output}")
    print("No GSPro input was sent. No API call was made. Strategy authority remains OFF.")
    return 0 if payload["validated"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
