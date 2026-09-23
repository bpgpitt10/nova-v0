#!/usr/bin/env python3
"""Fetch one course snapshot and resolve duplicate numbered hole routes as one family.

Some facilities map more than one course inside the configured course boundary.
Augusta National is a concrete example: the championship course and the Par 3
Course can both expose golf=hole refs 1-9. Selecting each ref independently can
therefore create a Frankenstein course.

This fetcher keeps the configured exact course boundary, then resolves one
coherent 1-18 hole family before the compiler sees the snapshot.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from shapely.geometry import Point

import fetch_osm_course_snapshot as fetcher
import fetch_osm_course_snapshot_core as core

EARTH_RADIUS_M = 6_371_008.8
M_TO_YD = 1.0936133
FOREIGN_COURSE_PENALTY_YARDS = 10_000.0
DEFAULT_MIN_FAMILY_MARGIN_YARDS = 50.0
DEFAULT_MAX_HANDOFF_YARDS = 700.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument(
        "--min-family-margin-yards",
        type=float,
        default=DEFAULT_MIN_FAMILY_MARGIN_YARDS,
    )
    parser.add_argument(
        "--max-handoff-yards",
        type=float,
        default=DEFAULT_MAX_HANDOFF_YARDS,
    )
    return parser.parse_args()


def _latlon_points(element: dict[str, Any]) -> list[tuple[float, float]]:
    direct = element.get("geometry") or []
    points = [
        (float(point["lat"]), float(point["lon"]))
        for point in direct
        if isinstance(point, dict)
        and isinstance(point.get("lat"), (int, float))
        and isinstance(point.get("lon"), (int, float))
    ]
    if len(points) >= 2:
        return points

    member_chains: list[list[tuple[float, float]]] = []
    for member in element.get("members") or []:
        geometry = member.get("geometry") or []
        chain = [
            (float(point["lat"]), float(point["lon"]))
            for point in geometry
            if isinstance(point, dict)
            and isinstance(point.get("lat"), (int, float))
            and isinstance(point.get("lon"), (int, float))
        ]
        if len(chain) >= 2:
            member_chains.append(chain)
    if not member_chains:
        return []

    # Golf-hole relations are uncommon, but when they occur the longest member
    # gives stable endpoints for family continuity without inventing geometry.
    return max(member_chains, key=len)


def _haversine_yards(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h)) * M_TO_YD


def _endpoint_gap_yards(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_points = _latlon_points(left)
    right_points = _latlon_points(right)
    if len(left_points) < 2 or len(right_points) < 2:
        return float("inf")
    return min(
        _haversine_yards(a, b)
        for a in (left_points[0], left_points[-1])
        for b in (right_points[0], right_points[-1])
    )


def _hole_candidates(payload: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    by_ref: dict[int, list[dict[str, Any]]] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf") != "hole":
            continue
        raw_ref = str(tags.get("ref", "")).strip()
        if not raw_ref.isdigit():
            continue
        hole = int(raw_ref)
        if 1 <= hole <= 18 and len(_latlon_points(element)) >= 2:
            by_ref.setdefault(hole, []).append(element)
    return by_ref


def _element_identity(element: dict[str, Any]) -> tuple[str, int]:
    return str(element.get("type")), int(element.get("id"))


def _foreign_course_shapes(
    payload: dict[str, Any],
    source_identity: tuple[str, int],
) -> list[tuple[tuple[str, int], Any]]:
    shapes: list[tuple[tuple[str, int], Any]] = []
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf") != "course":
            continue
        identity = _element_identity(element)
        if identity == source_identity:
            continue
        shape = fetcher.feature_shape(element)
        if shape.is_empty or getattr(shape, "area", 0.0) <= 0:
            continue
        shapes.append((identity, shape))
    return shapes


def _candidate_foreign_owner(
    element: dict[str, Any],
    foreign_courses: list[tuple[tuple[str, int], Any]],
) -> tuple[str, int] | None:
    points = _latlon_points(element)
    if not points:
        return None
    # Shapely uses lon/lat here, matching fetcher.feature_shape().
    lat = sum(point[0] for point in points) / len(points)
    lon = sum(point[1] for point in points) / len(points)
    probe = Point(lon, lat)
    containing = [
        (identity, shape.area)
        for identity, shape in foreign_courses
        if shape.buffer(fetcher.BOUNDARY_TOLERANCE_DEG / 4).contains(probe)
    ]
    if not containing:
        return None
    containing.sort(key=lambda item: item[1])
    return containing[0][0]


def resolve_hole_family(
    payload: dict[str, Any],
    *,
    source_identity: tuple[str, int],
    min_margin_yards: float = DEFAULT_MIN_FAMILY_MARGIN_YARDS,
    max_handoff_yards: float = DEFAULT_MAX_HANDOFF_YARDS,
) -> tuple[dict[int, dict[str, Any]], dict[str, Any]]:
    by_ref = _hole_candidates(payload)
    missing = [hole for hole in range(1, 19) if not by_ref.get(hole)]
    if missing:
        raise ValueError(f"Course snapshot is missing golf=hole refs: {missing}")

    duplicate_refs = [hole for hole in range(1, 19) if len(by_ref[hole]) > 1]
    foreign_courses = _foreign_course_shapes(payload, source_identity)
    foreign_owner: dict[tuple[str, int], tuple[str, int] | None] = {}
    for candidates in by_ref.values():
        for candidate in candidates:
            foreign_owner[_element_identity(candidate)] = _candidate_foreign_owner(
                candidate,
                foreign_courses,
            )

    # Only penalize nested-course membership for a ref when a non-foreign
    # alternative exists. That prevents legitimate courses inside larger resort
    # boundaries from becoming impossible to resolve.
    foreign_penalty: dict[tuple[str, int], float] = {}
    for hole, candidates in by_ref.items():
        has_non_foreign = any(foreign_owner[_element_identity(item)] is None for item in candidates)
        for candidate in candidates:
            identity = _element_identity(candidate)
            foreign_penalty[identity] = (
                FOREIGN_COURSE_PENALTY_YARDS
                if has_non_foreign and foreign_owner[identity] is not None
                else 0.0
            )

    # Dynamic programming keeps the two best paths ending at each candidate.
    # Cost is course-family continuity plus a strong nested-course penalty.
    states: dict[tuple[str, int], list[tuple[float, list[dict[str, Any]], list[float]]]] = {}
    for candidate in by_ref[1]:
        identity = _element_identity(candidate)
        states[identity] = [(foreign_penalty[identity], [candidate], [])]

    for hole in range(2, 19):
        next_states: dict[tuple[str, int], list[tuple[float, list[dict[str, Any]], list[float]]]] = {}
        previous_paths = [entry for entries in states.values() for entry in entries]
        for candidate in by_ref[hole]:
            identity = _element_identity(candidate)
            options: list[tuple[float, list[dict[str, Any]], list[float]]] = []
            for previous_cost, previous_path, previous_gaps in previous_paths:
                gap = _endpoint_gap_yards(previous_path[-1], candidate)
                if not math.isfinite(gap):
                    continue
                options.append((
                    previous_cost + gap + foreign_penalty[identity],
                    previous_path + [candidate],
                    previous_gaps + [gap],
                ))
            options.sort(key=lambda item: item[0])
            if options:
                next_states[identity] = options[:2]
        if not next_states:
            raise ValueError(f"No coherent hole-family path reaches Hole {hole}")
        states = next_states

    ranked = sorted(
        (entry for entries in states.values() for entry in entries),
        key=lambda item: item[0],
    )
    if not ranked:
        raise ValueError("No complete 1-18 hole family could be resolved")

    best_cost, best_path, best_gaps = ranked[0]
    second_cost = ranked[1][0] if len(ranked) > 1 else None
    margin = (second_cost - best_cost) if second_cost is not None else None
    max_gap = max(best_gaps, default=0.0)

    if duplicate_refs and margin is not None and margin < min_margin_yards:
        raise ValueError(
            "Duplicate hole families remain ambiguous: "
            f"best/second margin={margin:.1f} yd < {min_margin_yards:.1f} yd"
        )
    if duplicate_refs and max_gap > max_handoff_yards:
        raise ValueError(
            "Resolved hole family contains an implausible between-hole handoff: "
            f"max={max_gap:.1f} yd > {max_handoff_yards:.1f} yd"
        )

    selected = {hole: best_path[hole - 1] for hole in range(1, 19)}
    selected_foreign = [
        hole
        for hole, element in selected.items()
        if foreign_owner[_element_identity(element)] is not None
        and foreign_penalty[_element_identity(element)] > 0
    ]
    if selected_foreign:
        raise ValueError(f"Resolved family still selected nested-course holes: {selected_foreign}")

    diagnostics = {
        "method": "nested-course-exclusion+minimum-sequential-endpoint-gap-v1",
        "duplicateRefs": duplicate_refs,
        "foreignCoursePolygonCount": len(foreign_courses),
        "bestCostYards": round(best_cost, 1),
        "secondBestCostYards": round(second_cost, 1) if second_cost is not None else None,
        "marginYards": round(margin, 1) if margin is not None else None,
        "maxHandoffYards": round(max_gap, 1),
        "selected": {
            str(hole): {
                "type": _element_identity(element)[0],
                "id": _element_identity(element)[1],
                "par": (element.get("tags") or {}).get("par"),
                "foreignCourse": foreign_owner[_element_identity(element)] is not None,
            }
            for hole, element in selected.items()
        },
    }
    return selected, diagnostics


def filter_to_selected_holes(
    payload: dict[str, Any],
    selected: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    selected_ids = {
        _element_identity(element)
        for element in selected.values()
    }
    elements = []
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf") == "hole":
            raw_ref = str(tags.get("ref", "")).strip()
            if raw_ref.isdigit() and 1 <= int(raw_ref) <= 18:
                if _element_identity(element) not in selected_ids:
                    continue
        elements.append(element)
    return {
        "version": payload.get("version", 0.6),
        "generator": payload.get("generator", "OpenStreetMap core map API"),
        "osm3s": payload.get("osm3s") or {},
        "elements": elements,
    }


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    source_element, source_endpoint = fetcher.fetch_source_element(config, args.timeout)
    boundary = fetcher.boundary_shape(source_element)
    raw_payload, map_endpoint, raw_element_count = core.fetch_core_map_features(
        boundary.bounds,
        args.timeout,
    )
    bounded = fetcher.filter_to_boundary(raw_payload, boundary)

    _, source_type, source_id = fetcher.source_clause(config)
    source_identity = (source_type, source_id)
    selected, resolution = resolve_hole_family(
        bounded,
        source_identity=source_identity,
        min_margin_yards=args.min_family_margin_yards,
        max_handoff_yards=args.max_handoff_yards,
    )
    payload = filter_to_selected_holes(bounded, selected)
    holes = fetcher.validate_holes(payload)

    osm_clause, source_type, osm_id = fetcher.source_clause(config)
    payload["looperSnapshot"] = {
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "courseElement": {"type": source_type, "id": osm_id},
        "featureProvider": "openstreetmap-core-map",
        "sourceEndpoint": source_endpoint,
        "mapEndpoint": map_endpoint,
        "boundaryBoundsLonLat": [round(value, 8) for value in boundary.bounds],
        "rawFeatureElementCount": raw_element_count,
        "filteredFeatureElementCount": len(payload.get("elements", [])),
        "validatedHoleRoutes": {
            str(hole): {"type": element[0], "id": element[1]}
            for hole, element in sorted(holes.items())
        },
        "holeRouteResolution": resolution,
        "sourceClause": osm_clause,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "course": config.get("courseName"),
        "featureProvider": "openstreetmap-core-map",
        "duplicateRefs": resolution["duplicateRefs"],
        "familyMarginYards": resolution["marginYards"],
        "maxHandoffYards": resolution["maxHandoffYards"],
        "selectedHoleRoutes": resolution["selected"],
        "output": str(args.output),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
