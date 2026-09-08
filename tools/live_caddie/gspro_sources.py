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


def _mapping_get(mapping: Mapping[str, Any], *names: str) -> Any:
    """Case-insensitive lookup used only at GSPro source boundaries.

    Archived GSPro payloads have been stable, but source adapters should preserve
    meaning if a future build changes only JSON key capitalization.
    """
    for name in names:
        if name in mapping:
            return mapping[name]
    lowered = {str(key).lower(): key for key in mapping.keys()}
    for name in names:
        actual = lowered.get(name.lower())
        if actual is not None:
            return mapping[actual]
    return None


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

    `Hole` has been observed as zero-based in real captures. Raw source values are
    always retained so a future GSPro version cannot silently change semantics.
    Unknown surface/material codes are intentionally not guessed.
    """
    outer = dict(item)
    active = _as_dict(_mapping_get(outer, "activeShot"))
    shot_data = _as_dict(_mapping_get(active, "sd"))
    ghost = _as_dict(_mapping_get(outer, "GhostData"))

    raw_hole = _int_or_none(_mapping_get(outer, "Hole"))
    display_hole = raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None

    return {
        "shot_id": _mapping_get(outer, "ShotID"),
        "round_id": _mapping_get(outer, "RoundID"),
        "player_name": _mapping_get(outer, "PlayerName"),
        "user_guid": _mapping_get(outer, "UserGuid"),
        "course_key": _mapping_get(outer, "CourseKey"),
        "hole_raw_zero_based": raw_hole,
        "hole_display": display_hole,
        "hole_shot": _int_or_none(_mapping_get(outer, "HoleShot")),
        "global_shot_number": _int_or_none(_mapping_get(outer, "GlobalShotNumber")),
        "hole_par": _int_or_none(_mapping_get(outer, "HolePar")),
        "shot_result": _mapping_get(outer, "ShotResult"),
        "hole_result": _mapping_get(outer, "HoleResult"),
        "has_synced_online": _mapping_get(outer, "HasSyncedOnline"),
        "distance_to_pin_raw": _float_or_none(_mapping_get(outer, "DistanceToPin")),
        "total_distance_raw": _float_or_none(_mapping_get(outer, "TotalDistance")),
        "starting_surface_raw": _mapping_get(outer, "StartingSurface"),
        "ending_surface_raw": _mapping_get(outer, "EndingSurface"),
        "club_index": _mapping_get(outer, "ClubIndex"),
        "ball_speed_raw": _float_or_none(_mapping_get(outer, "BallSpeed")),
        "starting_pos": _mapping_get(outer, "StartingPOS"),
        "ending_pos": _mapping_get(outer, "EndingPOS"),
        "is_putt": _mapping_get(shot_data, "isPutt"),
        "is_holed": _mapping_get(shot_data, "isHoled"),
        "is_gimme": _mapping_get(shot_data, "isGimme"),
        "local_shot": _mapping_get(shot_data, "localShot"),
        "water_hit": _mapping_get(shot_data, "waterhit"),
        "hazard_number_raw": _mapping_get(shot_data, "HazardNumber"),
        "hazard_last_point_of_entry": _mapping_get(shot_data, "HazardLastPointOfEntry"),
        "target_direction_raw": _float_or_none(_mapping_get(shot_data, "TargetDirection")),
        "td_material_raw": _mapping_get(shot_data, "TDmaterial"),
        "material_hit": _mapping_get(active, "materialHit"),
        "ghost_material_hit": _mapping_get(ghost, "materialHit"),
        "final_speed_raw": _float_or_none(_mapping_get(shot_data, "finalSpeed")),
        "final_spin_raw": _float_or_none(_mapping_get(shot_data, "finalSpin")),
        "ball_start_pos": _mapping_get(shot_data, "BallStartPos"),
        "ball_stop_pos": _mapping_get(shot_data, "BallStopPos"),
        "td_point": _mapping_get(shot_data, "tdpoint"),
        "position_sample_count": _int_or_none(_mapping_get(shot_data, "posListCount")),
        "top_level_keys": sorted(str(k) for k in outer.keys()),
        "active_shot_keys": sorted(str(k) for k in active.keys()),
        "shot_data_keys": sorted(str(k) for k in shot_data.keys()),
        "ghost_data_keys": sorted(str(k) for k in ghost.keys()),
    }


def _find_shot_list(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    if not isinstance(payload, Mapping):
        return []

    # Be tolerant of a future wrapper while avoiding an unconstrained recursive walk
    # over the very large per-shot path arrays.
    for key in ("shots", "Shots", "currentRound", "CurrentRound", "roundShots", "RoundShots"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, Mapping)]

    # Some builds may expose one latest shot object instead of an array.
    if _mapping_get(payload, "ShotID") is not None or _mapping_get(payload, "HoleShot") is not None:
        return [payload]
    return []


def summarize_current_round_payload(payload: Any) -> list[dict[str, Any]]:
    return [summarize_current_round_shot(item) for item in _find_shot_list(payload)]


def shot_ids_from_summaries(summaries: Iterable[Mapping[str, Any]]) -> set[str]:
    return {
        str(item["shot_id"])
        for item in summaries
        if item.get("shot_id") not in (None, "")
    }


def round_ids_from_summaries(summaries: Iterable[Mapping[str, Any]]) -> set[int]:
    out: set[int] = set()
    for item in summaries:
        value = _int_or_none(item.get("round_id"))
        if value is not None:
            out.add(value)
    return out


_MATERIAL_RE = re.compile(r"\bmaterial\s+([A-Za-z0-9_]+)", re.IGNORECASE)
_ACTIVE_RE = re.compile(
    r"ActivePlayer\s*:\s*(\d+).*?currentHole\s*:\s*(\d+).*?strokes\s*:\s*(\d+)"
    r"(?:.*?Previous\s+Score\s*:\s*(-?\d+))?",
    re.IGNORECASE,
)
_CURRENT_HOLE_RE = re.compile(r"\bcurrentHole\s*:\s*(\d+)", re.IGNORECASE)
_TDIST_RE = re.compile(r"\bLogging\s+tdist\s*:\s*([-+]?\d+(?:\.\d+)?)", re.IGNORECASE)
_GIMMIE_DISTANCE_RE = re.compile(r"\bActiveGameGimmieDistance\s*:\s*([-+]?\d+(?:\.\d+)?)", re.IGNORECASE)
_SURF_ANGLE_RE = re.compile(r"\bSurfAngl\s+([-+]?\d+(?:\.\d+)?)", re.IGNORECASE)
_RESEARCH_KEYWORDS = re.compile(
    r"\b(material|surface|lie|wind|currenthole|activeplayer|gimm|holed|hazard|penalty|water|drop zone|tdist)\b",
    re.IGNORECASE,
)


def parse_output_log_line(line: str) -> list[OutputLogFact]:
    """Extract semantic observations from one GSPro Unity log line.

    The passive probe preserves every raw appended byte separately, so this parser is
    intentionally conservative. Unknown `TVG*` materials and unclassified research
    lines are retained verbatim instead of being assigned invented semantics.
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
        previous_score = int(active.group(4)) if active.group(4) is not None else None
        facts.append(OutputLogFact("active_game_state", {
            "active_player_index": int(active.group(1)),
            "hole_raw_zero_based": raw_hole,
            "hole_display": raw_hole + 1,
            "strokes": int(active.group(3)),
            "previous_score": previous_score,
            "raw": text,
        }))
    else:
        current_hole = _CURRENT_HOLE_RE.search(text)
        if current_hole:
            raw_hole = int(current_hole.group(1))
            facts.append(OutputLogFact("current_hole_observation", {
                "hole_raw_zero_based": raw_hole,
                "hole_display": raw_hole + 1,
                "raw": text,
            }))

    tdist = _TDIST_RE.search(text)
    if tdist:
        gimmie = _GIMMIE_DISTANCE_RE.search(text)
        facts.append(OutputLogFact("distance_state", {
            "tdist_raw": float(tdist.group(1)),
            "gimmie_distance_raw": float(gimmie.group(1)) if gimmie else None,
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

    if not facts and _RESEARCH_KEYWORDS.search(text):
        facts.append(OutputLogFact("unclassified_research_signal", {"raw": text}))

    return facts


def normalize_round_db_row(row: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(row)
    raw_hole = _int_or_none(result.get("ActiveHole"))
    # Field captures show ActiveHole=0 on display Hole 1. Keep the old aliases for
    # downstream compatibility, but make the assumption explicit in research output.
    result["ActiveHoleRaw"] = raw_hole
    result["ActiveHoleDisplayAssumingZeroBased"] = (
        raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None
    )
    result["ActiveHoleSemantics"] = "zero-based observed on hole 1; transition timing still unproven"
    result["ActiveHoleRawZeroBased"] = raw_hole
    result["ActiveHoleDisplay"] = result["ActiveHoleDisplayAssumingZeroBased"]
    return result
