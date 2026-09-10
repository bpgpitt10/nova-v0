#!/usr/bin/env python3
"""Shared GSPro structured-data helpers learned from live field captures.

Field evidence from the 2026-09-09 DPC Pebble watcher run established that
`DistanceToPin` and `TotalDistance` align with screen/coordinate values when treated
as meters. Preserve the raw values and expose converted yards rather than silently
changing GSPro source semantics.

Observed surface enums from the same corpus are intentionally a PARTIAL taxonomy:
18 tee, 2 fairway, 1 rough, 11 sand, 5 green. Unknown enum values are retained.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

M_TO_YARDS = 1.0936132983377078
SURFACE_ENUM_OBSERVED = {
    18: "tee",
    2: "fairway",
    1: "rough",
    11: "sand",
    5: "green",
}


def _mapping_get(mapping: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    lowered = {str(key).lower(): key for key in mapping}
    for name in names:
        key = lowered.get(name.lower())
        if key is not None:
            return mapping[key]
    return None


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except Exception:
        return None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except Exception:
        return None


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def meters_to_yards(value: Any) -> float | None:
    numeric = _float(value)
    return None if numeric is None else numeric * M_TO_YARDS


def surface_label(value: Any) -> str | None:
    numeric = _int(value)
    return SURFACE_ENUM_OBSERVED.get(numeric) if numeric is not None else None


def decode_current_round(raw: bytes) -> Any:
    last: Exception | None = None
    for encoding in ("utf-8-sig", "utf-16", "utf-8"):
        try:
            return json.loads(raw.decode(encoding))
        except Exception as exc:
            last = exc
    raise ValueError(f"could not decode currentRound.dat: {last}")


def shot_list(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    if not isinstance(payload, Mapping):
        return []
    for key in ("shots", "Shots", "currentRound", "CurrentRound", "roundShots", "RoundShots"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, Mapping)]
    return [payload] if _mapping_get(payload, "ShotID") is not None else []


def summarize_shot(item: Mapping[str, Any]) -> dict[str, Any]:
    active = _mapping_get(item, "activeShot")
    active = active if isinstance(active, Mapping) else {}
    sd = _mapping_get(active, "sd")
    sd = sd if isinstance(sd, Mapping) else {}
    ghost = _mapping_get(item, "GhostData")
    ghost = ghost if isinstance(ghost, Mapping) else {}

    raw_hole = _int(_mapping_get(item, "Hole"))
    dtp_m = _float(_mapping_get(item, "DistanceToPin"))
    total_m = _float(_mapping_get(item, "TotalDistance"))
    starting_surface = _mapping_get(item, "StartingSurface")
    ending_surface = _mapping_get(item, "EndingSurface")

    return {
        "shot_id": _mapping_get(item, "ShotID"),
        "round_id": _mapping_get(item, "RoundID"),
        "player_name": _mapping_get(item, "PlayerName"),
        "user_guid": _mapping_get(item, "UserGuid"),
        "course_key": _mapping_get(item, "CourseKey"),
        "hole_raw_zero_based": raw_hole,
        "hole_display": raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None,
        "hole_shot": _int(_mapping_get(item, "HoleShot")),
        "global_shot_number": _int(_mapping_get(item, "GlobalShotNumber")),
        "hole_par": _int(_mapping_get(item, "HolePar")),
        "distance_to_pin_raw": _mapping_get(item, "DistanceToPin"),
        "distance_to_pin_m": dtp_m,
        "distance_to_pin_yds": meters_to_yards(dtp_m),
        "total_distance_raw": _mapping_get(item, "TotalDistance"),
        "total_distance_m": total_m,
        "total_distance_yds": meters_to_yards(total_m),
        "distance_units_observed": "meters",
        "starting_surface_raw": starting_surface,
        "ending_surface_raw": ending_surface,
        "starting_surface": surface_label(starting_surface),
        "ending_surface": surface_label(ending_surface),
        "surface_enum_mapping_status": "partial-field-observed",
        "club_index": _mapping_get(item, "ClubIndex"),
        "shot_result": _mapping_get(item, "ShotResult"),
        "hole_result": _mapping_get(item, "HoleResult"),
        "is_putt": _bool(_mapping_get(sd, "isPutt")),
        "is_holed": _bool(_mapping_get(sd, "isHoled")),
        "is_gimme": _bool(_mapping_get(sd, "isGimme")),
        "local_shot": _mapping_get(sd, "localShot"),
        "water_hit": _mapping_get(sd, "waterhit"),
        "hazard_number_raw": _mapping_get(sd, "HazardNumber"),
        "hazard_last_point_of_entry": _mapping_get(sd, "HazardLastPointOfEntry"),
        "target_direction_raw": _mapping_get(sd, "TargetDirection"),
        "td_material_raw": _mapping_get(sd, "TDmaterial"),
        "material_hit": _mapping_get(active, "materialHit"),
        "ghost_material_hit": _mapping_get(ghost, "materialHit"),
        "starting_pos": _mapping_get(item, "StartingPOS"),
        "ending_pos": _mapping_get(item, "EndingPOS"),
        "ball_start_pos": _mapping_get(sd, "BallStartPos"),
        "ball_stop_pos": _mapping_get(sd, "BallStopPos"),
        "td_point": _mapping_get(sd, "tdpoint"),
    }


def read_current_round_shots(path: str | Path) -> list[dict[str, Any]]:
    p = Path(path)
    raw = p.read_bytes()
    return [summarize_shot(item) for item in shot_list(decode_current_round(raw))]


def read_latest_current_round(path_or_dir: str | Path) -> dict[str, Any] | None:
    p = Path(path_or_dir)
    if p.is_dir():
        p = p / "currentRound.dat"
    if not p.exists():
        return None
    shots = read_current_round_shots(p)
    return shots[-1] if shots else None
