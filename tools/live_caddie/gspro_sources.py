from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class OutputLogFact:
    kind: str
    values: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, **self.values}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def summarize_current_round_shot(item: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize one completed-shot object from currentRound.dat.

    GSPro's `Hole` and log `currentHole` values observed in field captures are zero-based.
    Keep both raw and display hole values so no source semantics are hidden.
    Unknown numeric surface/material codes are deliberately retained raw rather than guessed.
    """
    outer = dict(item)
    active = _as_dict(outer.get("activeShot"))
    shot_data = _as_dict(active.get("sd"))

    raw_hole = _int_or_none(outer.get("Hole"))
    display_hole = raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None

    return {
        "shot_id": outer.get("ShotID"),
        "round_id": outer.get("RoundID"),
        "player_name": outer.get("PlayerName"),
        "user_guid": outer.get("UserGuid"),
        "course_key": outer.get("CourseKey"),
        "hole_raw_zero_based": raw_hole,
        "hole_display": display_hole,
        "hole_shot": _int_or_none(outer.get("HoleShot")),
        "global_shot_number": _int_or_none(outer.get("GlobalShotNumber")),
        "hole_par": _int_or_none(outer.get("HolePar")),
        "shot_result": outer.get("ShotResult"),
        "hole_result": outer.get("HoleResult"),
        "distance_to_pin_raw": _float_or_none(outer.get("DistanceToPin")),
        "total_distance_raw": _float_or_none(outer.get("TotalDistance")),
        "starting_surface_raw": outer.get("StartingSurface"),
        "ending_surface_raw": outer.get("EndingSurface"),
        "club_index": outer.get("ClubIndex"),
        "ball_speed_raw": _float_or_none(outer.get("BallSpeed")),
        "is_putt": shot_data.get("isPutt"),
        "is_holed": shot_data.get("isHoled"),
        "is_gimme": shot_data.get("isGimme"),
        "water_hit": shot_data.get("waterhit"),
        "hazard_number_raw": shot_data.get("HazardNumber"),
        "hazard_last_point_of_entry": shot_data.get("HazardLastPointOfEntry"),
        "target_direction_raw": _float_or_none(shot_data.get("TargetDirection")),
        "td_material_raw": shot_data.get("TDmaterial"),
        "material_hit": active.get("materialHit"),
        "final_speed_raw": _float_or_none(shot_data.get("finalSpeed")),
        "final_spin_raw": _float_or_none(shot_data.get("finalSpin")),
        "ball_start_pos": shot_data.get("BallStartPos"),
        "td_point": shot_data.get("tdpoint"),
        "ending_pos": outer.get("EndingPOS"),
        "top_level_keys": sorted(str(k) for k in outer.keys()),
        "active_shot_keys": sorted(str(k) for k in active.keys()),
        "shot_data_keys": sorted(str(k) for k in shot_data.keys()),
    }


def summarize_current_round_payload(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []
    return [summarize_current_round_shot(item) for item in payload if isinstance(item, dict)]


def shot_ids_from_summaries(summaries: Iterable[Mapping[str, Any]]) -> set[str]:
    return {
        str(item["shot_id"])
        for item in summaries
        if item.get("shot_id") not in (None, "")
    }


_MATERIAL_RE = re.compile(r"\bmaterial\s+([A-Za-z0-9_]+)", re.IGNORECASE)
_ACTIVE_RE = re.compile(
    r"ActivePlayer:\s*(\d+)\s+currentHole:\s*(\d+)\s+strokes:\s*(\d+)\s+Previous Score:\s*(-?\d+)",
    re.IGNORECASE,
)
_TDIST_RE = re.compile(
    r"Logging tdist:\s*([-+]?\d+(?:\.\d+)?)\s+and ActiveGameGimmieDistance:\s*([-+]?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_SURF_ANGLE_RE = re.compile(r"\bSurfAngl\s+([-+]?\d+(?:\.\d+)?)", re.IGNORECASE)


def parse_output_log_line(line: str) -> list[OutputLogFact]:
    """Extract only semantic observations from one GSPro Unity log line.

    The passive probe separately preserves every raw appended byte from output_log.txt,
    so this parser can stay conservative. New material values are retained verbatim.
    """
    facts: list[OutputLogFact] = []
    text = line.strip()
    if not text:
        return facts

    material = _MATERIAL_RE.search(text)
    if material:
        facts.append(OutputLogFact("surface_material", {"material": material.group(1), "raw": text}))

    active = _ACTIVE_RE.search(text)
    if active:
        raw_hole = int(active.group(2))
        facts.append(OutputLogFact("active_game_state", {
            "active_player_index": int(active.group(1)),
            "hole_raw_zero_based": raw_hole,
            "hole_display": raw_hole + 1,
            "strokes": int(active.group(3)),
            "previous_score": int(active.group(4)),
            "raw": text,
        }))

    tdist = _TDIST_RE.search(text)
    if tdist:
        facts.append(OutputLogFact("distance_state", {
            "tdist_raw": float(tdist.group(1)),
            "gimmie_distance_raw": float(tdist.group(2)),
            "raw": text,
        }))

    surf = _SURF_ANGLE_RE.search(text)
    if surf:
        facts.append(OutputLogFact("surface_angle_physics", {
            "surf_angle_raw": float(surf.group(1)),
            "raw": text,
        }))

    lower = text.lower()
    if "allplayersholedout" in lower:
        facts.append(OutputLogFact("hole_terminal", {"raw": text}))
    if "within gimmie distance" in lower or "within gimme distance" in lower:
        facts.append(OutputLogFact("gimmie_selected", {"raw": text}))
    if "wind" in lower:
        facts.append(OutputLogFact("wind_log_line", {"raw": text}))
    if re.search(r"\b(penalty|hazard|waterhit|water hit|out of bounds|\bob\b|drop zone)\b", lower):
        facts.append(OutputLogFact("penalty_or_hazard_log_line", {"raw": text}))

    return facts


def normalize_round_db_row(row: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(row)
    raw_hole = _int_or_none(result.get("ActiveHole"))
    result["ActiveHoleRawZeroBased"] = raw_hole
    result["ActiveHoleDisplay"] = raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None
    return result
