#!/usr/bin/env python3
"""Field-calibrate GSPro world X/Z -> canonical tee hole-local yards.

FarmLinks Hole 3 gives a clean way to bridge two previously separate evidence spaces:
- currentRound supplies physical ball positions in GSPro world X/Z;
- post-tee minimap registration supplies the same balls in the tee HoleModel frame.

A similarity transform is fit from only TWO physical locations:
1. tee position: first shot StartingPOS -> hole local (0 lateral, 0 forward)
2. first-shot finish: first shot EndingPOS -> registered post-tee local position

The second approach finish is held out completely and used as validation. A transform
that predicts that third ball location within a few yards is strong field evidence
that GKD world geometry can be projected into the same canonical hole-local frame as
red CV and minimap-derived hazards.

Saved evidence only. No GSPro input, no API calls, no strategy authority.
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
YARDS_PER_METER = 1.0936132983377078


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def xz(value: Any) -> np.ndarray:
    if not isinstance(value, dict):
        raise RuntimeError(f"world position is not an object: {value!r}")
    return np.asarray([float(value["x"]), float(value["z"])], dtype=float)


def pin_yds(state: dict[str, Any]) -> float:
    pin = (state.get("pin") or {}).get("distance_yds")
    if pin is None:
        structured = state.get("structured_current_round") or {}
        pin = structured.get("distance_to_pin_yds")
    if pin is None:
        raise RuntimeError("approach state lacks resolved PIN distance")
    return float(pin)


def registered_local(capture: Path, tee_model: Path) -> tuple[np.ndarray, dict[str, Any]]:
    state = read_json(capture / "shot_state.json")
    image = cv2.imread(str(capture / "approach_minimap.png"), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"approach_minimap.png unreadable in {capture}")
    geometry = posttee_geometry_v2.analyze(
        current_minimap=image,
        pin_distance_yds=pin_yds(state),
        hole_model_path=tee_model,
    )
    if not geometry.get("geometry_trusted"):
        raise RuntimeError(f"post-tee geometry not trusted for {capture.name}: {geometry.get('geometry_rejection_reason')}")
    pos = geometry.get("canonical_position") or {}
    local = np.asarray([
        float(pos["tee_relative_lateral_yds"]),
        float(pos["tee_relative_forward_yds"]),
    ], dtype=float)
    return local, geometry


def fit_similarity(world_origin: np.ndarray, world_a: np.ndarray, local_a: np.ndarray):
    dw = world_a - world_origin
    dl = local_a
    world_norm = float(np.linalg.norm(dw))
    local_norm = float(np.linalg.norm(dl))
    if world_norm < 20.0 or local_norm < 20.0:
        raise RuntimeError("tee and first-shot finish are too close for stable transform calibration")
    scale = local_norm / world_norm
    world_angle = math.atan2(float(dw[1]), float(dw[0]))
    local_angle = math.atan2(float(dl[1]), float(dl[0]))
    rotation_rad = local_angle - world_angle
    c, s = math.cos(rotation_rad), math.sin(rotation_rad)
    rotation = np.asarray([[c, -s], [s, c]], dtype=float)
    translation = -scale * (rotation @ world_origin)
    return scale, rotation, translation, math.degrees(rotation_rad)


def apply_transform(scale: float, rotation: np.ndarray, translation: np.ndarray, point_xz: np.ndarray) -> np.ndarray:
    return scale * (rotation @ point_xz) + translation


def matrix_2x3(scale: float, rotation: np.ndarray, translation: np.ndarray) -> list[list[float]]:
    linear = scale * rotation
    return [
        [float(linear[0, 0]), float(linear[0, 1]), float(translation[0])],
        [float(linear[1, 0]), float(linear[1, 1]), float(translation[1])],
    ]


def validate(root: Path, tee_name: str, approach_a_name: str, approach_b_name: str, max_validation_error_yds: float) -> dict[str, Any]:
    tee = root / tee_name
    a = root / approach_a_name
    b = root / approach_b_name
    tee_model = tee / "hole_model.json"
    state_a = read_json(a / "shot_state.json")
    state_b = read_json(b / "shot_state.json")
    structured_a = state_a.get("structured_current_round") or {}
    structured_b = state_b.get("structured_current_round") or {}

    world_tee = xz(structured_a.get("starting_pos"))
    world_a = xz(structured_a.get("ending_pos"))
    world_b = xz(structured_b.get("ending_pos"))
    local_a, geometry_a = registered_local(a, tee_model)
    local_b, geometry_b = registered_local(b, tee_model)

    scale, rotation, translation, rotation_deg = fit_similarity(world_tee, world_a, local_a)
    predicted_tee = apply_transform(scale, rotation, translation, world_tee)
    predicted_a = apply_transform(scale, rotation, translation, world_a)
    predicted_b = apply_transform(scale, rotation, translation, world_b)
    validation_error = float(np.linalg.norm(predicted_b - local_b))
    calibration_error = float(np.linalg.norm(predicted_a - local_a))
    tee_error = float(np.linalg.norm(predicted_tee))
    scale_ratio = scale / YARDS_PER_METER
    scale_sane = bool(0.85 <= scale_ratio <= 1.15)
    validated = bool(
        scale_sane
        and tee_error <= 0.25
        and calibration_error <= 0.25
        and validation_error <= float(max_validation_error_yds)
    )

    return {
        "schema_version": "looper-gspro-world-hole-transform-v0",
        "course_key": "farmlinks_al_2_7_gsp",
        "hole_display": 3,
        "tee_capture": tee_name,
        "calibration_approach_capture": approach_a_name,
        "held_out_validation_capture": approach_b_name,
        "coordinate_contract": {
            "input": "gspro_world_xz",
            "output": "hole_local_yards",
            "output_axes": ["lateral_right_positive", "forward_from_tee"],
            "equation": "local = matrix_2x3 * [world_x, world_z, 1]",
        },
        "matrix_2x3": matrix_2x3(scale, rotation, translation),
        "scale_yards_per_world_unit": float(scale),
        "rotation_deg": float(rotation_deg),
        "translation_hole_local_yards": [float(x) for x in translation],
        "scale_vs_meter_to_yard_ratio": float(scale_ratio),
        "scale_sanity_ok": scale_sane,
        "calibration": {
            "tee_world_xz": world_tee.tolist(),
            "tee_expected_local_yards": [0.0, 0.0],
            "tee_predicted_local_yards": predicted_tee.tolist(),
            "tee_error_yds": tee_error,
            "first_finish_world_xz": world_a.tolist(),
            "first_finish_registered_local_yards": local_a.tolist(),
            "first_finish_predicted_local_yards": predicted_a.tolist(),
            "first_finish_error_yds": calibration_error,
            "registration_mode": (geometry_a.get("registration") or {}).get("acceptance_mode"),
        },
        "held_out_validation": {
            "world_xz": world_b.tolist(),
            "registered_local_yards": local_b.tolist(),
            "predicted_local_yards": predicted_b.tolist(),
            "error_yds": validation_error,
            "max_allowed_error_yds": float(max_validation_error_yds),
            "registration_mode": (geometry_b.get("registration") or {}).get("acceptance_mode"),
        },
        "validated": validated,
        "validation_interpretation": (
            "world->hole transform independently predicts held-out post-tee ball position"
            if validated else
            "world->hole transform failed scale or held-out-position validation"
        ),
        "field_use": "validated transform may project GKD world geometry into this hole's canonical comparison frame; does not grant strategy authority",
        "strategy_authority": False,
        "promotion_decision": "none",
    }


def transform_point(payload: dict[str, Any], point_xz: Any) -> list[float]:
    if payload.get("validated") is not True:
        raise ValueError("world/hole transform is not validated")
    point = xz(point_xz)
    matrix = np.asarray(payload["matrix_2x3"], dtype=float).reshape(2, 3)
    out = matrix @ np.asarray([point[0], point[1], 1.0], dtype=float)
    return [float(out[0]), float(out[1])]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Field-calibrate GSPro world X/Z to canonical hole-local yards")
    p.add_argument("--output-root", default=str(DEFAULT_ROOT))
    p.add_argument("--tee", default=DEFAULT_TEE)
    p.add_argument("--approach-a", default=DEFAULT_A)
    p.add_argument("--approach-b", default=DEFAULT_B)
    p.add_argument("--max-validation-error-yds", type=float, default=3.0)
    p.add_argument("--output")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    payload = validate(root, args.tee, args.approach_a, args.approach_b, args.max_validation_error_yds)
    output = Path(args.output).expanduser().resolve() if args.output else root / "world_hole_transform_h3_20260911.json"
    write_json(output, payload)
    held = payload["held_out_validation"]
    status = "PASS" if payload["validated"] else "FAIL"
    print(
        f"{status} GSPro world->hole transform | scale={payload['scale_yards_per_world_unit']:.5f} yd/unit "
        f"rotation={payload['rotation_deg']:.2f}deg | held-out error={held['error_yds']:.2f} yd"
    )
    print(f"Output: {output}")
    print("Saved evidence only. Strategy authority OFF. Promotion NONE.")
    return 0 if payload["validated"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
