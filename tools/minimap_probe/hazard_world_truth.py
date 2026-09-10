from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import traceback
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

import gspro_structured as gs

SCHEMA_VERSION = "looper-hazard-world-truth-v0"
STRATEGY_AUTHORITY = False
WORLD_SPACES = {"gspro_world_xz", "world_xz", "unity_world_xz"}
HAZARD_SEMANTICS = {
    "bunker_or_sand",
    "bunker",
    "water",
    "penalty_area",
    "penalty",
    "out_of_bounds",
    "hazard_unspecified",
}
SAND_SEMANTICS = {"bunker_or_sand", "bunker"}
WATER_SEMANTICS = {"water", "penalty_area", "penalty"}
SAFE_SURFACES = {"tee", "fairway", "rough", "green"}


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def nk(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return False


def number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def point_xz(value: Any) -> dict[str, float] | None:
    if isinstance(value, dict):
        lowered = {nk(k): v for k, v in value.items()}
        x = number(lowered.get("x"))
        z = number(lowered.get("z"))
        y = number(lowered.get("y"))
        if x is not None and z is not None:
            out = {"x": x, "z": z}
            if y is not None:
                out["y"] = y
            return out
    if isinstance(value, (list, tuple)):
        vals = [number(v) for v in value]
        if len(vals) == 2 and all(v is not None for v in vals):
            return {"x": float(vals[0]), "z": float(vals[1])}
        if len(vals) >= 3 and all(v is not None for v in vals[:3]):
            return {"x": float(vals[0]), "y": float(vals[1]), "z": float(vals[2])}
    return None


def is_zero_point(point: dict[str, float] | None, eps: float = 1e-7) -> bool:
    if point is None:
        return True
    return abs(point["x"]) <= eps and abs(point["z"]) <= eps and abs(point.get("y", 0.0)) <= eps


def dist(a: dict[str, float], b: dict[str, float]) -> float:
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def point_segment_distance(p: dict[str, float], a: dict[str, float], b: dict[str, float]) -> float:
    vx, vz = b["x"] - a["x"], b["z"] - a["z"]
    wx, wz = p["x"] - a["x"], p["z"] - a["z"]
    vv = vx * vx + vz * vz
    if vv <= 1e-12:
        return dist(p, a)
    t = max(0.0, min(1.0, (wx * vx + wz * vz) / vv))
    q = {"x": a["x"] + t * vx, "z": a["z"] + t * vz}
    return dist(p, q)


def point_in_polygon(point: dict[str, float], polygon: list[dict[str, float]]) -> bool:
    if len(polygon) < 3:
        return False
    x, z = point["x"], point["z"]
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, zi = polygon[i]["x"], polygon[i]["z"]
        xj, zj = polygon[j]["x"], polygon[j]["z"]
        if point_segment_distance(point, polygon[j], polygon[i]) <= 1e-8:
            return True
        crosses = ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-30) + xi)
        if crosses:
            inside = not inside
        j = i
    return inside


def geometry_metrics(point: dict[str, float], points: list[dict[str, float]], polygon_candidate: bool) -> dict[str, Any]:
    if not points:
        return {"contains": False, "distance_to_geometry": None, "distance_to_boundary": None}
    contains = point_in_polygon(point, points) if polygon_candidate and len(points) >= 3 else False
    if len(points) == 1:
        boundary = dist(point, points[0])
    else:
        pairs = list(zip(points, points[1:]))
        if polygon_candidate and len(points) >= 3:
            pairs.append((points[-1], points[0]))
        boundary = min(point_segment_distance(point, a, b) for a, b in pairs)
    return {
        "contains": contains,
        "distance_to_geometry": 0.0 if contains else boundary,
        "distance_to_boundary": boundary,
    }


def normalize_semantics(raw: Any) -> list[str]:
    values: list[str] = []
    if isinstance(raw, str):
        values = [raw]
    elif isinstance(raw, dict):
        values = [str(k) for k, v in raw.items() if v]
        values += [str(x) for v in raw.values() if isinstance(v, list) for x in v]
    elif isinstance(raw, (list, tuple, set)):
        values = [str(v) for v in raw]
    out: list[str] = []
    for value in values:
        token = nk(value)
        if "bunker" in token or "tvgsand" in token or token == "sand":
            out.append("bunker_or_sand")
        elif "water" in token or any(w in token for w in ("pond", "lake", "creek", "stream", "river", "ocean")):
            out.append("water")
        elif "penalty" in token or "redhazard" in token or "yellowhazard" in token:
            out.append("penalty_area")
        elif token in {"oob", "outofbounds"} or "outofbounds" in token:
            out.append("out_of_bounds")
        elif token == "hazard" or "hazardunspecified" in token:
            out.append("hazard_unspecified")
        elif "green" in token:
            out.append("green")
        elif "fairway" in token:
            out.append("fairway")
        elif "rough" in token:
            out.append("rough")
        elif "tee" in token:
            out.append("tee")
        elif "dropzone" in token:
            out.append("drop_zone")
    return list(dict.fromkeys(out)) or ["unknown"]


def bounds(points: list[dict[str, float]]) -> dict[str, float] | None:
    if not points:
        return None
    return {
        "min_x": min(p["x"] for p in points),
        "max_x": max(p["x"] for p in points),
        "min_z": min(p["z"] for p in points),
        "max_z": max(p["z"] for p in points),
    }


def candidate_id(source: str, payload: Any) -> str:
    return hashlib.sha1(json.dumps([source, payload], sort_keys=True, default=str).encode()).hexdigest()[:16]


def normalize_gkd_feature(item: dict[str, Any], source_file: str) -> dict[str, Any] | None:
    pts = [p for p in (point_xz(v) for v in item.get("points_xyz", [])) if p]
    if not pts:
        return None
    return {
        "candidate_id": str(item.get("feature_id") or candidate_id(source_file, [item.get("json_path"), pts])),
        "source": str(item.get("source") or source_file),
        "source_kind": "gkd",
        "semantics": normalize_semantics(item.get("semantic_candidates", [])),
        "points_xz": pts,
        "polygon_candidate": bool(item.get("polygon_candidate", len(pts) >= 3)),
        "coordinate_space": "gspro_world_xz",
        "coordinate_space_status": "field-aligned-gkd-world-space",
        "comparable_to_shots": True,
        "hole_hint": item.get("hole_hint"),
        "json_path": item.get("json_path"),
        "bounds_xz": item.get("bounds_xz") or bounds(pts),
        "strategy_authority": False,
    }


def normalize_asset_geometry(item: dict[str, Any], source_file: str) -> dict[str, Any] | None:
    pts = [p for p in (point_xz(v) for v in item.get("points", [])) if p]
    if not pts:
        return None
    declared_space = str(item.get("coordinate_space") or "unknown_asset_or_serialized_space")
    comparable = declared_space in WORLD_SPACES or bool(item.get("world_space_verified"))
    semantics_raw: list[Any] = []
    for key in ("semantic_candidates", "seed_semantic_hits", "semantic_hits", "class", "hazard_class"):
        if key in item:
            semantics_raw.append(item[key])
    return {
        "candidate_id": candidate_id(source_file, [item.get("asset_file"), item.get("path_id"), item.get("json_path"), pts]),
        "source": source_file,
        "source_kind": "unity_asset",
        "semantics": normalize_semantics(semantics_raw),
        "points_xz": pts,
        "polygon_candidate": bool(item.get("polygon_candidate", len(pts) >= 3)),
        "coordinate_space": declared_space,
        "coordinate_space_status": "explicit-world" if comparable else "unproven-local-or-serialized-space",
        "comparable_to_shots": comparable,
        "hole_hint": item.get("hole_hint"),
        "asset_file": item.get("asset_file"),
        "path_id": item.get("path_id"),
        "json_path": item.get("json_path"),
        "bounds_xz": item.get("bounds_xz") or bounds(pts),
        "strategy_authority": False,
    }


def normalize_unified_hazard(item: dict[str, Any], source_file: str) -> dict[str, Any] | None:
    raw_points = item.get("world_polygon") or item.get("points_xz") or item.get("polygon") or item.get("points") or []
    pts = [p for p in (point_xz(v) for v in raw_points) if p]
    if not pts:
        return None
    declared_space = str(item.get("coordinate_space") or ("gspro_world_xz" if item.get("world_polygon") else "unknown"))
    comparable = declared_space in WORLD_SPACES
    return {
        "candidate_id": str(item.get("id") or item.get("candidate_id") or candidate_id(source_file, pts)),
        "source": str(item.get("source") or source_file),
        "source_kind": str(item.get("source_kind") or "unified"),
        "semantics": normalize_semantics(item.get("class") or item.get("hazard_class") or item.get("semantics") or []),
        "points_xz": pts,
        "polygon_candidate": bool(item.get("polygon_candidate", len(pts) >= 3)),
        "coordinate_space": declared_space,
        "coordinate_space_status": str(item.get("coordinate_space_status") or ("explicit-world" if comparable else "unproven")),
        "comparable_to_shots": comparable,
        "hole_hint": item.get("hole_hint") or item.get("hole"),
        "bounds_xz": item.get("bounds_xz") or bounds(pts),
        "strategy_authority": False,
    }


def load_geometry_file(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    out: list[dict[str, Any]] = []
    if isinstance(data, dict) and isinstance(data.get("features"), list):
        for item in data["features"]:
            if isinstance(item, dict):
                value = normalize_gkd_feature(item, str(path))
                if value:
                    out.append(value)
    elif isinstance(data, dict) and isinstance(data.get("geometry"), list):
        for item in data["geometry"]:
            if isinstance(item, dict):
                value = normalize_asset_geometry(item, str(path))
                if value:
                    out.append(value)
    elif isinstance(data, dict) and isinstance(data.get("hazards"), list):
        for item in data["hazards"]:
            if isinstance(item, dict):
                value = normalize_unified_hazard(item, str(path))
                if value:
                    out.append(value)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                value = normalize_unified_hazard(item, str(path))
                if value:
                    out.append(value)
    return out


def shot_key(shot: dict[str, Any]) -> tuple[Any, ...]:
    return (
        shot.get("round_id"),
        shot.get("shot_id"),
        shot.get("hole_raw_zero_based"),
        shot.get("hole_shot"),
        shot.get("global_shot_number"),
    )


def physicality(shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    previous_global: dict[Any, int | None] = {}
    out = []
    for shot in shots:
        row = dict(shot)
        round_id = row.get("round_id")
        gsn = row.get("global_shot_number")
        repeated = round_id in previous_global and gsn is not None and previous_global[round_id] == gsn
        if row.get("is_gimme"):
            row["physical_shot"] = False
            row["synthetic_terminal_record"] = True
            row["physicality_reason"] = "gimme-terminal-repeated-global" if repeated else "gimme-terminal"
        else:
            row["physical_shot"] = True
            row["synthetic_terminal_record"] = False
            row["physicality_reason"] = "physical-candidate"
        previous_global[round_id] = gsn
        out.append(row)
    return out


def dedupe_shots(shots: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[tuple[Any, ...], dict[str, Any]] = {}
    for shot in shots:
        key = shot_key(shot)
        # Keep the later/richer copy when the same completed shot appears in many snapshots.
        existing = seen.get(key)
        if existing is None or len(json.dumps(shot, default=str)) >= len(json.dumps(existing, default=str)):
            seen[key] = shot
    return list(seen.values())


def load_current_round(path: Path) -> list[dict[str, Any]]:
    return gs.read_current_round_shots(path)


def surface_expectation(surface: str | None, materials: Iterable[Any] = (), water_hit: Any = False) -> dict[str, Any]:
    text = " ".join(str(v).lower() for v in materials if v is not None)
    if as_bool(water_hit) or "water" in text:
        return {"expectation": "water_event", "compatible_semantics": sorted(WATER_SEMANTICS), "truth_strength": "strong"}
    if surface == "sand" or "tvgsand" in text or re.search(r"\bsand\b", text):
        return {"expectation": "sand", "compatible_semantics": sorted(SAND_SEMANTICS), "truth_strength": "strong"}
    if surface in SAFE_SURFACES:
        return {"expectation": "safe_surface", "compatible_semantics": [], "truth_strength": "strong"}
    return {"expectation": "unknown", "compatible_semantics": [], "truth_strength": "none"}


def observation_id(shot: dict[str, Any], role: str) -> str:
    return "r{}-h{}-s{}-g{}-{}".format(
        shot.get("round_id", "x"),
        shot.get("hole_display", "x"),
        shot.get("hole_shot", "x"),
        shot.get("global_shot_number", "x"),
        role,
    )


def build_observations(shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for shot in physicality(dedupe_shots(shots)):
        base = {
            "round_id": shot.get("round_id"),
            "shot_id": shot.get("shot_id"),
            "course_key": shot.get("course_key"),
            "hole_raw_zero_based": shot.get("hole_raw_zero_based"),
            "hole_display": shot.get("hole_display"),
            "hole_shot": shot.get("hole_shot"),
            "global_shot_number": shot.get("global_shot_number"),
            "physical_shot": shot.get("physical_shot"),
            "synthetic_terminal_record": shot.get("synthetic_terminal_record"),
            "physicality_reason": shot.get("physicality_reason"),
            "strategy_authority": False,
        }
        if not shot.get("physical_shot"):
            out.append({**base, "observation_id": observation_id(shot, "terminal"), "role": "terminal_only", "point_xz": None, "expectation": "excluded_synthetic_terminal", "validation_eligible": False})
            continue

        start = point_xz(shot.get("starting_pos"))
        if start and not is_zero_point(start):
            exp = surface_expectation(shot.get("starting_surface"))
            out.append({**base, "observation_id": observation_id(shot, "start"), "role": "shot_start", "point_xz": start, "surface": shot.get("starting_surface"), **exp, "validation_eligible": exp["expectation"] != "unknown"})

        end = point_xz(shot.get("ending_pos"))
        if end and not is_zero_point(end):
            exp = surface_expectation(
                shot.get("ending_surface"),
                (shot.get("material_hit"), shot.get("ghost_material_hit"), shot.get("td_material_raw")),
                shot.get("water_hit"),
            )
            out.append({**base, "observation_id": observation_id(shot, "end"), "role": "shot_end", "point_xz": end, "surface": shot.get("ending_surface"), "water_hit": as_bool(shot.get("water_hit")), **exp, "validation_eligible": exp["expectation"] != "unknown"})

        entry = point_xz(shot.get("hazard_last_point_of_entry"))
        if as_bool(shot.get("water_hit")) and entry and not is_zero_point(entry):
            out.append({**base, "observation_id": observation_id(shot, "hazard-entry"), "role": "hazard_entry", "point_xz": entry, "surface": None, "expectation": "water_boundary", "compatible_semantics": sorted(WATER_SEMANTICS), "truth_strength": "strong", "validation_eligible": True})
    return out


def hole_compatibility(observation: dict[str, Any], candidate: dict[str, Any]) -> str:
    hint = candidate.get("hole_hint")
    if hint is None:
        return "unknown"
    if isinstance(hint, dict):
        value = hint.get("value")
        source = str(hint.get("source") or "")
        index_base = str(hint.get("index_base") or "")
    else:
        value, source, index_base = hint, "direct", ""
    try:
        value_i = int(value)
    except Exception:
        return "unknown"
    raw = observation.get("hole_raw_zero_based")
    display = observation.get("hole_display")
    if "array-index" in source or index_base == "unknown":
        return "compatible-uncertain-index" if value_i in {raw, display} else "unknown-index-base"
    if value_i in {raw, display}:
        return "compatible"
    return "mismatch"


def semantic_compatible(expectation: str, semantics: Iterable[str]) -> bool:
    sem = set(semantics)
    if expectation == "sand":
        return bool(sem & SAND_SEMANTICS)
    if expectation in {"water_event", "water_boundary"}:
        return bool(sem & WATER_SEMANTICS)
    if expectation == "safe_surface":
        return bool(sem & HAZARD_SEMANTICS)
    return False


def candidate_measure(observation: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    point = observation.get("point_xz")
    if not point or not candidate.get("points_xz"):
        return None
    metrics = geometry_metrics(point, candidate["points_xz"], bool(candidate.get("polygon_candidate")))
    return {
        "candidate_id": candidate["candidate_id"],
        "source": candidate["source"],
        "source_kind": candidate["source_kind"],
        "semantics": candidate["semantics"],
        "coordinate_space": candidate["coordinate_space"],
        "coordinate_space_status": candidate["coordinate_space_status"],
        "comparable_to_shots": candidate["comparable_to_shots"],
        "hole_compatibility": hole_compatibility(observation, candidate),
        "semantic_compatible": semantic_compatible(observation.get("expectation", "unknown"), candidate["semantics"]),
        **metrics,
    }


def verdict_for_source(observation: dict[str, Any], measures: list[dict[str, Any]], near_tolerance: float) -> dict[str, Any]:
    comparable = [m for m in measures if m["comparable_to_shots"] and m["hole_compatibility"] != "mismatch"]
    compatible = [m for m in comparable if m["semantic_compatible"]]
    compatible.sort(key=lambda m: float("inf") if m["distance_to_geometry"] is None else m["distance_to_geometry"])
    expectation = observation.get("expectation")

    if expectation in {"sand", "water_event"}:
        if not compatible:
            return {"verdict": "no-compatible-geometry", "evidence_strength": "negative", "nearest": None}
        best = compatible[0]
        hit = bool(best["contains"]) or (best["distance_to_geometry"] is not None and best["distance_to_geometry"] <= near_tolerance)
        return {"verdict": "matched" if hit else "missed", "evidence_strength": "strong" if hit else "contradiction", "nearest": best}

    if expectation == "water_boundary":
        if not compatible:
            return {"verdict": "no-compatible-geometry", "evidence_strength": "negative", "nearest": None}
        best = min(compatible, key=lambda m: float("inf") if m["distance_to_boundary"] is None else m["distance_to_boundary"])
        hit = best["distance_to_boundary"] is not None and best["distance_to_boundary"] <= near_tolerance
        return {"verdict": "boundary-matched" if hit else "boundary-missed", "evidence_strength": "strong" if hit else "contradiction", "nearest": best}

    if expectation == "safe_surface":
        intrusions = [m for m in compatible if m["contains"]]
        if intrusions:
            intrusions.sort(key=lambda m: m["distance_to_boundary"] if m["distance_to_boundary"] is not None else float("inf"))
            return {"verdict": "safe-point-inside-hazard", "evidence_strength": "contradiction", "nearest": intrusions[0]}
        # Absence of an intrusion does not prove source completeness.
        return {"verdict": "no-contradiction", "evidence_strength": "weak", "nearest": None}

    return {"verdict": "not-evaluable", "evidence_strength": "none", "nearest": None}


def validate(observations: list[dict[str, Any]], candidates: list[dict[str, Any]], near_tolerance: float = 3.0) -> dict[str, Any]:
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        by_source[candidate["source"]].append(candidate)

    results = []
    for obs in observations:
        if not obs.get("validation_eligible") or not obs.get("point_xz"):
            results.append({"observation": obs, "sources": {}, "overall": {"verdict": "excluded", "reason": obs.get("expectation")}})
            continue
        source_results = {}
        all_measures = []
        for source, source_candidates in by_source.items():
            measures = [m for m in (candidate_measure(obs, c) for c in source_candidates) if m]
            all_measures += measures
            source_results[source] = verdict_for_source(obs, measures, near_tolerance)
            source_results[source]["comparable_candidate_count"] = sum(1 for m in measures if m["comparable_to_shots"])
            source_results[source]["untrusted_coordinate_candidate_count"] = sum(1 for m in measures if not m["comparable_to_shots"])

        trusted_verdicts = [v["verdict"] for v in source_results.values() if v.get("comparable_candidate_count", 0) > 0]
        if any(v in {"matched", "boundary-matched"} for v in trusted_verdicts):
            overall = {"verdict": "corroborated", "reason": "at-least-one-world-space-source-matched"}
        elif any(v == "safe-point-inside-hazard" for v in trusted_verdicts):
            overall = {"verdict": "contradiction", "reason": "safe-point-inside-hazard-geometry"}
        elif any(v in {"missed", "boundary-missed"} for v in trusted_verdicts):
            overall = {"verdict": "contradiction", "reason": "known-hazard-truth-not-near-compatible-geometry"}
        elif trusted_verdicts:
            overall = {"verdict": "inconclusive", "reason": "trusted-geometry-present-but-no-positive-match"}
        else:
            overall = {"verdict": "inconclusive", "reason": "no-world-space-comparable-geometry"}

        diagnostic_untrusted = sorted(
            [m for m in all_measures if not m["comparable_to_shots"] and m["distance_to_geometry"] is not None],
            key=lambda m: m["distance_to_geometry"],
        )[:5]
        results.append({"observation": obs, "sources": source_results, "overall": overall, "nearest_untrusted_coordinate_candidates": diagnostic_untrusted})

    return {"schema_version": SCHEMA_VERSION, "near_tolerance_world_units": near_tolerance, "results": results, "strategy_authority": False}


def scorecard(validation: dict[str, Any]) -> dict[str, Any]:
    rows: dict[str, Counter] = defaultdict(Counter)
    for result in validation.get("results", []):
        obs = result.get("observation", {})
        exp = obs.get("expectation")
        for source, source_result in result.get("sources", {}).items():
            if source_result.get("comparable_candidate_count", 0) <= 0:
                rows[source]["untrusted_coordinate_only_observations"] += 1
                continue
            verdict = source_result.get("verdict")
            rows[source]["evaluated_observations"] += 1
            rows[source][f"verdict_{verdict}"] += 1
            if exp in {"sand", "water_event"}:
                rows[source]["positive_hazard_truth"] += 1
                if verdict == "matched": rows[source]["positive_hits"] += 1
                elif verdict in {"missed", "no-compatible-geometry"}: rows[source]["positive_misses"] += 1
            elif exp == "water_boundary":
                rows[source]["boundary_truth"] += 1
                if verdict == "boundary-matched": rows[source]["boundary_hits"] += 1
                elif verdict in {"boundary-missed", "no-compatible-geometry"}: rows[source]["boundary_misses"] += 1
            elif exp == "safe_surface":
                rows[source]["safe_truth"] += 1
                if verdict == "safe-point-inside-hazard": rows[source]["safe_contradictions"] += 1
                elif verdict == "no-contradiction": rows[source]["safe_no_contradiction"] += 1
    out = []
    for source, counter in sorted(rows.items()):
        row = {"source": source, **dict(counter)}
        pos = counter.get("positive_hazard_truth", 0)
        row["positive_hit_rate"] = counter.get("positive_hits", 0) / pos if pos else None
        boundary = counter.get("boundary_truth", 0)
        row["boundary_hit_rate"] = counter.get("boundary_hits", 0) / boundary if boundary else None
        row["strategy_authority"] = False
        out.append(row)
    return {
        "schema_version": SCHEMA_VERSION,
        "sources": out,
        "caution": "Safe no-contradiction does not prove geometry completeness; only positive hazard truth can directly confirm a candidate source.",
        "strategy_authority": False,
    }


def discover_latest(output_root: Path, pattern: str) -> Path | None:
    matches = [p for p in output_root.glob(pattern) if p.is_file()]
    return max(matches, key=lambda p: p.stat().st_mtime) if matches else None


def find_locallow(explicit: str | None) -> Path | None:
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.exists() else None
    user = os.getenv("USERPROFILE")
    if not user:
        return None
    for p in (Path(user)/"AppData/LocalLow/GSPro/GSPro", Path(user)/"AppData/LocalLow/GSPro"):
        if p.exists():
            return p
    return None


def collect_current_round_paths(explicit: list[str], capture_roots: list[str], locallow: Path | None) -> list[Path]:
    paths: list[Path] = []
    for raw in explicit:
        p = Path(raw).expanduser()
        if p.is_file(): paths.append(p)
        elif p.is_dir(): paths += sorted(p.rglob("*current*round*.dat"))
    for raw in capture_roots:
        root = Path(raw).expanduser()
        if root.is_dir(): paths += sorted(root.rglob("*current*round*.dat"))
    if not paths and locallow:
        direct = locallow / "currentRound.dat"
        if direct.exists(): paths.append(direct)
    seen = set(); out = []
    for p in paths:
        key = str(p.resolve()).lower()
        if key not in seen:
            seen.add(key); out.append(p)
    return out


def collect_geometry_paths(explicit: list[str], output_root: Path) -> list[Path]:
    paths = [Path(raw).expanduser() for raw in explicit if Path(raw).expanduser().is_file()]
    if not paths:
        gkd_latest = discover_latest(output_root, "gkd_archaeology_*/features.json")
        unity_latest = discover_latest(output_root, "course_asset_archaeology_*/geometry_candidates.json")
        paths = [p for p in (gkd_latest, unity_latest) if p]
    seen = set(); out = []
    for p in paths:
        key = str(p.resolve()).lower()
        if key not in seen:
            seen.add(key); out.append(p)
    return out


def make_zip(run_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(run_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(run_dir.parent))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate candidate GSPro hazard geometry against physical shot truth")
    p.add_argument("--current-round", action="append", default=[])
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--geometry-json", action="append", default=[])
    p.add_argument("--locallow")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--near-tolerance", type=float, default=3.0, help="Diagnostic threshold in GSPro world units; not assumed to be yards")
    p.add_argument("--no-zip", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path(args.output_root).expanduser().resolve()
    run_dir = output_root / f"hazard_world_truth_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "started_utc": iso_now(),
        "strategy_authority": False,
        "read_only_intent": True,
        "near_tolerance_world_units": args.near_tolerance,
        "warnings": [],
        "errors": [],
        "boundaries": [
            "Synthetic gimme terminal records are retained but excluded from physical geometry truth.",
            "GKD coordinates are treated as world-comparable based on prior field alignment.",
            "Unity/course-asset coordinates remain diagnostic-only until their world transform is proven.",
            "Safe points can reveal contradictions but cannot establish source completeness.",
        ],
    }
    try:
        locallow = find_locallow(args.locallow)
        round_paths = collect_current_round_paths(args.current_round, args.capture_root, locallow)
        geometry_paths = collect_geometry_paths(args.geometry_json, output_root)
        manifest["current_round_paths"] = [str(p) for p in round_paths]
        manifest["geometry_paths"] = [str(p) for p in geometry_paths]

        shots: list[dict[str, Any]] = []
        for path in round_paths:
            try:
                for shot in load_current_round(path):
                    shot["source_current_round"] = str(path)
                    shots.append(shot)
            except Exception as exc:
                manifest["errors"].append(f"currentRound:{path}:{type(exc).__name__}:{exc}")
        shots = dedupe_shots(shots)
        observations = build_observations(shots)

        candidates: list[dict[str, Any]] = []
        for path in geometry_paths:
            try:
                candidates += load_geometry_file(path)
            except Exception as exc:
                manifest["errors"].append(f"geometry:{path}:{type(exc).__name__}:{exc}")

        validation = validate(observations, candidates, args.near_tolerance)
        source_scores = scorecard(validation)

        (run_dir / "shots.json").write_text(json.dumps({"shot_count": len(shots), "shots": physicality(shots)}, indent=2, default=str), encoding="utf-8")
        (run_dir / "shot_observations.json").write_text(json.dumps({"observation_count": len(observations), "observations": observations}, indent=2, default=str), encoding="utf-8")
        (run_dir / "geometry_inventory.json").write_text(json.dumps({"candidate_count": len(candidates), "candidates": candidates, "strategy_authority": False}, indent=2, default=str), encoding="utf-8")
        (run_dir / "validation_results.json").write_text(json.dumps(validation, indent=2, default=str), encoding="utf-8")
        (run_dir / "source_scorecard.json").write_text(json.dumps(source_scores, indent=2, default=str), encoding="utf-8")

        counts = Counter(obs.get("expectation") for obs in observations)
        overall = Counter(result.get("overall", {}).get("verdict") for result in validation["results"])
        summary = {
            "schema_version": SCHEMA_VERSION,
            "physical_shot_count": sum(1 for s in physicality(shots) if s.get("physical_shot")),
            "synthetic_terminal_record_count": sum(1 for s in physicality(shots) if s.get("synthetic_terminal_record")),
            "observation_count": len(observations),
            "observation_expectations": dict(counts),
            "geometry_candidate_count": len(candidates),
            "world_comparable_candidate_count": sum(1 for c in candidates if c.get("comparable_to_shots")),
            "untrusted_coordinate_candidate_count": sum(1 for c in candidates if not c.get("comparable_to_shots")),
            "overall_validation_verdicts": dict(overall),
            "strategy_authority": False,
        }
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        manifest["summary"] = summary
        if not round_paths:
            manifest["warnings"].append("No currentRound corpus was found; validator produced no shot truth.")
        if not geometry_paths:
            manifest["warnings"].append("No GKD/Unity geometry file was found; shot truth was still normalized for later comparison.")
    except Exception as exc:
        manifest["errors"].append(f"fatal-but-packaged:{type(exc).__name__}:{exc}")
        (run_dir / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")

    manifest["finished_utc"] = iso_now()
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    zip_path = output_root / f"hazard_world_truth_review_{stamp}.zip"
    if not args.no_zip:
        try:
            make_zip(run_dir, zip_path)
        except Exception as exc:
            manifest["errors"].append(f"zip:{type(exc).__name__}:{exc}")

    summary = manifest.get("summary", {})
    print("GSPro Hazard World Truth v0")
    print(f"Output: {run_dir}")
    if not args.no_zip:
        print(f"Review ZIP: {zip_path}")
    print(f"Physical shots: {summary.get('physical_shot_count', 0)}")
    print(f"Synthetic terminal records excluded: {summary.get('synthetic_terminal_record_count', 0)}")
    print(f"Truth observations: {summary.get('observation_count', 0)}")
    print(f"World-comparable geometry: {summary.get('world_comparable_candidate_count', 0)}")
    if manifest["errors"]:
        print(f"Errors: {len(manifest['errors'])}")
    return 0 if not manifest["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
