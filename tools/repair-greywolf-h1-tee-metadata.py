#!/usr/bin/env python3
"""Repair Greywolf H1 tee retention from the preserved OSM snapshot.

The historical Greywolf generator selected one tee to define the local frame and
then serialized only that tee polygon.  The source snapshot contains the sibling
tee polygons too.  This tool restores those concrete OSM tee features while
preserving the existing selected-tee coordinate frame.

It intentionally does NOT infer tee colors/names from yardage or ordering.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path
from typing import Any, Iterable

EARTH_RADIUS_M = 6_371_008.8
M_TO_YD = 1.0936133
SOURCE_REF = "origin/hazard-field-lab-v0"
SOURCE_PATH = "artifacts/osm-proof/context/greywolf-osm-context-raw.json"
TARGET_PATH = Path("public/course-geometry/greywolf/local-geometry/greywolf-hole-01.json")


def git_show_json(ref: str, path: str) -> dict[str, Any]:
    payload = subprocess.check_output(["git", "show", f"{ref}:{path}"], text=True)
    return json.loads(payload)


def local_east_north_yards(
    latlon: tuple[float, float], origin: tuple[float, float]
) -> tuple[float, float]:
    lat, lon = latlon
    lat0, lon0 = origin
    north_m = EARTH_RADIUS_M * math.radians(lat - lat0)
    east_m = EARTH_RADIUS_M * math.radians(lon - lon0) * math.cos(math.radians(lat0))
    return east_m * M_TO_YD, north_m * M_TO_YD


def centroid_latlon(points: list[dict[str, float]]) -> tuple[float, float]:
    return (
        sum(float(point["lat"]) for point in points) / len(points),
        sum(float(point["lon"]) for point in points) / len(points),
    )


def basis_from_artifact(artifact: dict[str, Any]):
    anchors = artifact["anchors"]
    origin = tuple(float(value) for value in anchors["selected_tee_latlon"])
    green = tuple(float(value) for value in anchors["target_green_latlon"])
    east, north = local_east_north_yards(green, origin)
    length = math.hypot(east, north)
    if length <= 1e-9:
        raise ValueError("Greywolf H1 selected tee and green anchors are degenerate")
    forward = (east / length, north / length)
    right = (forward[1], -forward[0])
    return origin, forward, right


def to_golfer_xy(
    latlon: Iterable[float],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[float]:
    lat, lon = latlon
    east, north = local_east_north_yards((float(lat), float(lon)), origin)
    return [
        east * right[0] + north * right[1],
        east * forward[0] + north * forward[1],
    ]


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    if len(polygon) < 3:
        return False
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and x < ((xj - xi) * (y - yi)) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def point_segment_distance(
    point: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    px, py = point
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    if denominator <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denominator))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def point_polyline_distance(point: tuple[float, float], line: list[tuple[float, float]]) -> float:
    if len(line) == 1:
        return math.hypot(point[0] - line[0][0], point[1] - line[0][1])
    return min(point_segment_distance(point, a, b) for a, b in zip(line, line[1:]))


def polyline_polygon_distance(line: list[tuple[float, float]], polygon: list[tuple[float, float]]) -> float:
    if any(point_in_polygon(point, polygon) for point in line):
        return 0.0
    return min(point_polyline_distance(point, line) for point in polygon)


def geometry_points(element: dict[str, Any]) -> list[dict[str, float]]:
    return [
        point
        for point in element.get("geometry", [])
        if point.get("lat") is not None and point.get("lon") is not None
    ]


def source_element_by_id(payload: dict[str, Any], osm_id: int) -> dict[str, Any]:
    for element in payload.get("elements", []):
        if int(element.get("id", -1)) == osm_id:
            return element
    raise ValueError(f"OSM source did not contain tee {osm_id}")


def source_hole_one_route(payload: dict[str, Any]) -> dict[str, Any]:
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf") == "hole" and str(tags.get("ref", "")).strip() == "1":
            return element
    raise ValueError("OSM source did not contain Greywolf Hole 1 route")


def serialize_tee(
    element: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    route_local: list[tuple[float, float]],
) -> dict[str, Any]:
    tags = element.get("tags") or {}
    geometry = geometry_points(element)
    if len(geometry) < 3:
        raise ValueError(f"OSM tee {element.get('id')} has fewer than three geometry points")
    centroid = centroid_latlon(geometry)
    polygon = [to_golfer_xy((point["lat"], point["lon"]), origin, forward, right) for point in geometry]
    center = to_golfer_xy(centroid, origin, forward, right)
    polygon_tuples = [(point[0], point[1]) for point in polygon]
    source_tags = {
        key: value
        for key, value in tags.items()
        if key in {"golf", "name", "ref", "source", "surface", "colour", "color", "tee", "tee:colour", "tee:color"}
    }
    return {
        "osm_id": int(element["id"]),
        "osm_type": element.get("type"),
        "golf": tags.get("golf"),
        "name": tags.get("name"),
        "ref": tags.get("ref"),
        "assigned_hole": None,
        "association_distance_yards": round(polyline_polygon_distance(route_local, polygon_tuples), 2),
        "centroid": {
            "right_yards": round(center[0], 3),
            "forward_yards": round(center[1], 3),
        },
        "polygon": [
            {"right_yards": round(point[0], 3), "forward_yards": round(point[1], 3)}
            for point in polygon
        ],
        "osm_tags": source_tags,
    }


def repair(artifact: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    anchors = artifact.get("anchors") or {}
    candidate_rows = anchors.get("tee_candidates") or []
    candidate_ids = [int(row["tee_id"]) for row in candidate_rows]
    if len(candidate_ids) != 6 or len(set(candidate_ids)) != 6:
        raise ValueError(f"Expected six distinct Greywolf H1 tee candidates; found {candidate_ids}")

    selected_id = int(anchors["selected_tee_osm_id"])
    if selected_id not in candidate_ids:
        raise ValueError("Selected Greywolf H1 tee is not present in tee_candidates")

    origin, forward, right = basis_from_artifact(artifact)
    route = source_hole_one_route(source)
    route_points = geometry_points(route)
    route_local = [
        tuple(to_golfer_xy((point["lat"], point["lon"]), origin, forward, right))
        for point in route_points
    ]
    if len(route_local) < 2:
        raise ValueError("Greywolf H1 route is incomplete")

    existing_teees = (artifact.get("features") or {}).get("tee") or []
    existing_by_id = {int(feature["osm_id"]): feature for feature in existing_teees if feature.get("osm_id") is not None}

    repaired: list[dict[str, Any]] = []
    for tee_id in candidate_ids:
        source_element = source_element_by_id(source, tee_id)
        tags = source_element.get("tags") or {}
        if tags.get("golf") != "tee":
            raise ValueError(f"OSM feature {tee_id} is not tagged golf=tee")
        generated = serialize_tee(source_element, origin, forward, right, route_local)

        # Preserve the proven selected-tee polygon exactly as currently packaged.
        # Only enrich its source metadata; sibling tees are restored from source.
        if tee_id == selected_id and tee_id in existing_by_id:
            proven = existing_by_id[tee_id]
            generated["centroid"] = proven.get("centroid", generated["centroid"])
            generated["polygon"] = proven.get("polygon", generated["polygon"])
            generated["association_distance_yards"] = proven.get(
                "association_distance_yards", generated["association_distance_yards"]
            )
        repaired.append(generated)

    ids = [feature["osm_id"] for feature in repaired]
    if ids != candidate_ids:
        raise ValueError(f"Tee output order drifted: {ids} != {candidate_ids}")

    selected = next(feature for feature in repaired if feature["osm_id"] == selected_id)
    center = selected["centroid"]
    if math.hypot(float(center["right_yards"]), float(center["forward_yards"])) > 0.05:
        raise ValueError(f"Selected tee origin moved away from [0,0]: {center}")

    for feature in repaired:
        tags = feature["osm_tags"]
        # The preserved source does not identify tee color/set.  Failing here
        # protects us from silently introducing a yardage-order guess.
        for forbidden in ("teeSet", "label"):
            if forbidden in feature:
                raise ValueError(f"Invented {forbidden} on OSM tee {feature['osm_id']}")
        if feature.get("name") is not None or feature.get("ref") is not None:
            raise ValueError(
                f"Greywolf H1 source unexpectedly gained a tee name/ref on {feature['osm_id']}; review before mapping tee sets"
            )
        if any(key in tags for key in ("colour", "color", "tee", "tee:colour", "tee:color")):
            raise ValueError(
                f"Greywolf H1 source now contains tee identity tags on {feature['osm_id']}; review rather than assuming old behavior"
            )

    artifact.setdefault("features", {})["tee"] = repaired
    artifact.setdefault("checks", {})["tee_candidate_feature_count"] = len(repaired)
    artifact["checks"]["tee_candidate_ids_complete"] = True
    artifact["checks"]["tee_identity_labels_available"] = False
    artifact.setdefault("cleanup", {})["tee_retention_policy"] = (
        "retain all six H1 OSM tee candidates in the selected-tee local frame; do not infer tee-set/color labels"
    )
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Fail if the checked-in artifact differs from the repaired output")
    args = parser.parse_args()

    artifact = json.loads(TARGET_PATH.read_text())
    source = git_show_json(SOURCE_REF, SOURCE_PATH)
    repaired = repair(artifact, source)
    rendered = json.dumps(repaired, indent=2, sort_keys=False) + "\n"

    if args.check:
        current = TARGET_PATH.read_text()
        if current != rendered:
            raise SystemExit("Greywolf H1 tee metadata artifact is stale; run repair-greywolf-h1-tee-metadata.py")
        print("Greywolf H1 tee metadata: checked and current")
        return

    TARGET_PATH.write_text(rendered)
    print("Greywolf H1 tee metadata: retained six concrete OSM tee candidates without tee-set guesses")


if __name__ == "__main__":
    main()
