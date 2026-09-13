#!/usr/bin/env python3
"""Normalize live GSPro ShotState into Strategy Field gameplay context.

This is an adapter, not a terrain model. For Looper v1, elevation is deliberately
simplified to one shot-level scalar. GSPro's displayed PIN/AIM elevation is trusted
as the best available elevation context for the shot, and nearby candidate aims are
assumed to share it.

Policy locked for v1:
- tee shots: prefer current GSPro AIM elevation; nearby candidate aims inherit it;
- approach-to-green shots: prefer PIN elevation;
- other post-tee / layup shots: prefer current GSPro AIM elevation, PIN as fallback;
- candidate-specific terrain elevation is deferred and is NOT a strategy blocker.

The adapter preserves the source measurements and provenance, makes the sign
convention explicit, and leaves the physical playing-distance adjustment itself to
the later gameplay model.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "looper-strategy-gameplay-context-v0"
SIGN_CONVENTION = "positive_uphill_negative_downhill"
ELEVATION_SCOPE = "single shot-level elevation scalar; nearby candidate aims assumed equivalent for v1"
ELEVATION_POLICY_VERSION = "looper-elevation-policy-v1"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def _optional_finite(value: Any, name: str) -> float | None:
    if value is None:
        return None
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite when supplied")
    return out


def normalize_target_measurement(state: Any, role: str) -> dict[str, Any] | None:
    if state is None:
        return None
    if not isinstance(state, dict):
        raise ValueError(f"{role} target state must be an object or null")

    distance = _optional_finite(state.get("distance_yds"), f"{role}.distance_yds")
    if distance is not None and distance <= 0:
        raise ValueError(f"{role}.distance_yds must be > 0 when supplied")

    elevation_ft = _optional_finite(state.get("elevation_delta_ft"), f"{role}.elevation_delta_ft")
    elevation_yds = _optional_finite(state.get("elevation_delta_yds"), f"{role}.elevation_delta_yds")
    consistency_error_yds = None
    consistency_ok = None
    if elevation_ft is not None and elevation_yds is not None:
        consistency_error_yds = abs(elevation_ft / 3.0 - elevation_yds)
        consistency_ok = consistency_error_yds <= 0.02

    direction = state.get("elevation_direction")
    sign_direction_ok = None
    if direction in {"up", "down"} and elevation_ft is not None:
        sign_direction_ok = (direction == "up" and elevation_ft >= 0) or (direction == "down" and elevation_ft <= 0)

    confidence = state.get("confidence", state.get("ocr_confidence"))
    if confidence is not None:
        confidence = _optional_finite(confidence, f"{role}.confidence")

    return {
        "role": role,
        "distance_yds": distance,
        "elevation": {
            "delta_ft": elevation_ft,
            "delta_yds": elevation_yds,
            "direction": direction,
            "raw_display": state.get("elevation_raw"),
            "sign_convention": SIGN_CONVENTION,
            "unit_consistency_ok": consistency_ok,
            "unit_consistency_error_yds": consistency_error_yds,
            "sign_direction_consistency_ok": sign_direction_ok,
        },
        "source": state.get("source"),
        "ocr": {
            "distance_raw": state.get("distance_ocr_raw"),
            "elevation_raw": state.get("elevation_ocr_raw", state.get("elevation_raw")),
            "confidence": confidence,
            "confidence_status": "reported" if confidence is not None else "not-calibrated-by-current-target-card-reader",
        },
    }


def elevation_policy() -> dict[str, Any]:
    return {
        "policy_version": ELEVATION_POLICY_VERSION,
        "scope": ELEVATION_SCOPE,
        "tee": {
            "preferred_source": "gspro_aim",
            "fallback_source": "pin",
            "candidate_handling": "reuse selected shot-level elevation for nearby aim candidates",
        },
        "approach_to_green": {
            "preferred_source": "pin",
            "fallback_source": "gspro_aim",
            "candidate_handling": "reuse pin elevation across the green; small intra-green elevation differences ignored",
        },
        "other_post_tee": {
            "preferred_source": "gspro_aim",
            "fallback_source": "pin",
            "candidate_handling": "reuse selected shot-level elevation for nearby layup/strategy candidates",
        },
        "candidate_specific_terrain_elevation_required": False,
        "candidate_specific_terrain_elevation_deferred": True,
        "strategy_blocker": False,
        "accepted_v1_limitations": [
            "A materially different layup target may sit at a somewhat different elevation.",
            "Small elevation differences across a green are intentionally ignored.",
        ],
    }


def build_gameplay_context(shot_state: dict[str, Any], *, supplemental: dict[str, Any] | None = None,
                           source_path: str | None = None) -> dict[str, Any]:
    if not isinstance(shot_state, dict):
        raise ValueError("shot_state must be an object")

    pin = normalize_target_measurement(shot_state.get("pin"), "pin")
    aim = normalize_target_measurement(shot_state.get("aim"), "gspro_aim")

    return {
        "schema_version": SCHEMA_VERSION,
        "capture_mode": shot_state.get("capture_mode"),
        "shot_state_schema_version": shot_state.get("schema_version"),
        "target_measurements": {
            "pin": pin,
            "gspro_aim": aim,
        },
        "lie": shot_state.get("lie_slope"),
        "lie_warning": shot_state.get("lie_warning"),
        "wind": shot_state.get("wind"),
        "wind_note": shot_state.get("wind_note"),
        "supplemental": dict(supplemental or {}),
        "provenance": {
            "source": "Looper GSPro ShotState",
            "source_path": source_path,
            "screen_truth": True,
            "target_card_source": "GSPro displayed PIN/AIM card",
        },
        "elevation_contract": elevation_policy(),
        "application": {
            "shot_level_elevation_policy_locked": True,
            "elevation_adjustment_model_applied": False,
            "applied_to_distribution": False,
            "applied_to_club_selection": False,
            "applied_to_aim_scoring": False,
            "note": "The v1 elevation source policy is locked; the numerical playing-distance/flight adjustment is still a separate gameplay model.",
        },
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Normalize Looper ShotState into Strategy Field gameplay context")
    p.add_argument("--shot-state-json", required=True)
    p.add_argument("--supplemental-context-json")
    p.add_argument("--output")
    args = p.parse_args()

    shot_path = Path(args.shot_state_json).expanduser().resolve()
    shot_state = read_json(shot_path)
    supplemental = (
        read_json(Path(args.supplemental_context_json).expanduser().resolve())
        if args.supplemental_context_json else {}
    )
    payload = build_gameplay_context(shot_state, supplemental=supplemental, source_path=str(shot_path))
    output = (
        Path(args.output).expanduser().resolve()
        if args.output else shot_path.with_name("strategy_gameplay_context_v0.json")
    )
    write_json(output, payload)
    print(f"Wrote {output}")
    print("Elevation policy v1 locked: one shot-level scalar; candidate-specific terrain elevation deferred")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
