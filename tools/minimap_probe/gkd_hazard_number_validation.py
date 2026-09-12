#!/usr/bin/env python3
"""Test whether GSPro currentRound.HazardNumber maps directly to GKD.Hazards geometry.

FarmLinks H3 provides a rare strong observation: the tee shot ended safely on the
fairway but currentRound still recorded HazardNumber=9 and a non-zero
HazardLastPointOfEntry. Fresh GKD archaeology may expose the underlying Hazards[]
coordinate structures in the same field-established GSPro world X/Z frame.

This probe asks two separate questions without guessing:
1. Is the physical HazardLastPointOfEntry spatially on/near any GKD hazard geometry?
2. Does the matching geometry live under Hazards[8] or Hazards[9], indicating a
   one-based or zero-based relationship to HazardNumber=9?

A positive direct-index result would be especially valuable: it would connect a
structured runtime hazard identifier to source course geometry. Diagnostic only.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

HAZARD_SEMANTICS = {"hazard_unspecified", "penalty_area", "water", "out_of_bounds"}
HAZARD_INDEX_RE = re.compile(r"(?i)(?:^|\.)hazards?\[(\d+)\]")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def point_xz(value: Any) -> tuple[float, float] | None:
    if isinstance(value, dict):
        try:
            return float(value["x"]), float(value["z"])
        except Exception:
            return None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return float(value[0]), float(value[1])
        except Exception:
            return None
    return None


def point_segment_distance(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    vx, vz = b[0] - a[0], b[1] - a[1]
    wx, wz = p[0] - a[0], p[1] - a[1]
    vv = vx * vx + vz * vz
    if vv <= 1e-12:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, (wx * vx + wz * vz) / vv))
    qx, qz = a[0] + t * vx, a[1] + t * vz
    return math.hypot(p[0] - qx, p[1] - qz)


def point_in_polygon(p: tuple[float, float], pts: list[tuple[float, float]]) -> bool:
    if len(pts) < 3:
        return False
    x, z = p
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, zi = pts[i]
        xj, zj = pts[j]
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-30) + xi):
            inside = not inside
        j = i
    return inside


def distance_to_feature(p: tuple[float, float], feature: dict[str, Any]) -> tuple[float | None, bool]:
    pts = [q for q in (point_xz(v) for v in feature.get("points_xyz") or feature.get("points") or []) if q is not None]
    if not pts:
        return None, False
    polygon = bool(feature.get("polygon_candidate") and len(pts) >= 3)
    inside = point_in_polygon(p, pts) if polygon else False
    if len(pts) == 1:
        boundary = math.hypot(p[0] - pts[0][0], p[1] - pts[0][1])
    else:
        pairs = list(zip(pts, pts[1:]))
        if polygon:
            pairs.append((pts[-1], pts[0]))
        boundary = min(point_segment_distance(p, a, b) for a, b in pairs)
    return float(boundary), inside


def hazard_index(path: str) -> int | None:
    match = HAZARD_INDEX_RE.search(str(path or ""))
    return int(match.group(1)) if match else None


def physical_event(shot_state: dict[str, Any]) -> dict[str, Any]:
    structured = shot_state.get("structured_current_round") or {}
    number = structured.get("hazard_number_raw")
    entry = structured.get("hazard_last_point_of_entry") or {}
    try:
        number = int(number)
        p = (float(entry["x"]), float(entry["z"]))
    except Exception as exc:
        raise RuntimeError(f"shot state lacks HazardNumber/HazardLastPointOfEntry: {exc}")
    if number >= 1000 or math.hypot(*p) < 1e-6:
        raise RuntimeError(f"shot does not contain a usable physical hazard event: HazardNumber={number}, entry={p}")
    return {
        "hazard_number": number,
        "entry_xz": p,
        "shot_id": structured.get("shot_id"),
        "hole_display": structured.get("hole_display"),
        "water_hit": structured.get("water_hit"),
        "ending_surface": structured.get("ending_surface"),
    }


def analyze(features_path: Path, shot_state_path: Path, near_tolerance: float) -> dict[str, Any]:
    payload = read_json(features_path)
    shot_state = read_json(shot_state_path)
    event = physical_event(shot_state)
    entry = event["entry_xz"]

    candidates = []
    for feature in payload.get("features") or []:
        if not isinstance(feature, dict):
            continue
        semantics = set(feature.get("semantic_candidates") or [])
        path = str(feature.get("json_path") or "")
        idx = hazard_index(path)
        if not (semantics & HAZARD_SEMANTICS or idx is not None):
            continue
        distance, contains = distance_to_feature(entry, feature)
        if distance is None:
            continue
        candidates.append({
            "feature_id": feature.get("feature_id"),
            "json_path": path,
            "hazards_array_index": idx,
            "semantic_candidates": sorted(semantics),
            "point_count": feature.get("point_count"),
            "polygon_candidate": bool(feature.get("polygon_candidate")),
            "contains_entry": contains,
            "distance_to_boundary_world_units": distance,
            "near_entry": bool(distance <= near_tolerance),
            "supporting_fields": feature.get("supporting_fields") or {},
        })
    candidates.sort(key=lambda row: row["distance_to_boundary_world_units"])

    number = int(event["hazard_number"])
    by_index: dict[int, list[dict[str, Any]]] = {}
    for row in candidates:
        idx = row.get("hazards_array_index")
        if idx is not None:
            by_index.setdefault(int(idx), []).append(row)

    direct_tests = []
    for label, idx in (("one-based-runtime-to-zero-based-array", number - 1), ("zero-based-runtime-to-array", number)):
        rows = by_index.get(idx, [])
        best = min(rows, key=lambda row: row["distance_to_boundary_world_units"]) if rows else None
        direct_tests.append({
            "mapping": label,
            "runtime_hazard_number": number,
            "candidate_array_index": idx,
            "candidate_count": len(rows),
            "best": best,
            "spatially_validated": bool(best and best["distance_to_boundary_world_units"] <= near_tolerance),
        })

    validated_direct = [row for row in direct_tests if row["spatially_validated"]]
    if len(validated_direct) == 1:
        mapping_state = validated_direct[0]["mapping"]
    elif len(validated_direct) > 1:
        mapping_state = "ambiguous-both-index-conventions-near-entry"
    else:
        mapping_state = "no-direct-index-validation"

    nearest = candidates[0] if candidates else None
    return {
        "schema_version": "looper-gkd-hazard-number-validation-v0",
        "source_features": str(features_path),
        "source_shot_state": str(shot_state_path),
        "physical_event": {
            **event,
            "entry_xz": list(entry),
        },
        "near_tolerance_world_units": near_tolerance,
        "candidate_count": len(candidates),
        "nearest_gkd_hazard_candidate": nearest,
        "direct_index_tests": direct_tests,
        "hazard_number_mapping_state": mapping_state,
        "physical_entry_has_near_gkd_geometry": bool(nearest and nearest["distance_to_boundary_world_units"] <= near_tolerance),
        "top_candidates": candidates[:25],
        "strategy_authority": False,
        "promotion_decision": "none",
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate GSPro HazardNumber/entry against fresh GKD archaeology")
    p.add_argument("--features", required=True)
    p.add_argument("--shot-state", required=True)
    p.add_argument("--near-tolerance", type=float, default=3.0)
    p.add_argument("--output", required=True)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    result = analyze(
        Path(args.features).expanduser().resolve(),
        Path(args.shot_state).expanduser().resolve(),
        float(args.near_tolerance),
    )
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    nearest = result.get("nearest_gkd_hazard_candidate") or {}
    print(
        "GKD HazardNumber validation | "
        f"runtime={result['physical_event']['hazard_number']} | "
        f"mapping={result['hazard_number_mapping_state']} | "
        f"nearest={nearest.get('distance_to_boundary_world_units')} world units | "
        f"path={nearest.get('json_path')}"
    )
    print(f"Output: {output}")
    print("Read-only evidence. Strategy authority OFF. Promotion NONE.")
    # Absence of a direct mapping is evidence, not a runner failure.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
