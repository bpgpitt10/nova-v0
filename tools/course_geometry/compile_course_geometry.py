#!/usr/bin/env python3
"""Compile preserved OSM evidence into Looper CourseGeometryPackage v1.

The compiler is offline and deterministic. It preserves all supported course-wide
features in one fixed east/north coordinate space, builds a coarse spatial index,
and emits per-hole views that reference (rather than duplicate) those features.

Dynamic GSPro state is intentionally not embedded. In particular, wind remains an
independent GSPro screen-OCR sensor and is only declared as an integration contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence


EARTH_RADIUS_M = 6_371_008.8
METERS_TO_YARDS = 1.0936133
SCHEMA_VERSION = "looper.course_geometry_package.v1"
GENERATOR_VERSION = "course-geometry-compiler-v1"

GOLF_SURFACES = {
    "fairway": "fairway",
    "green": "green",
    "bunker": "bunker",
    "rough": "rough",
    "tee": "tee",
    "lateral_water_hazard": "water",
    "water_hazard": "water",
}

Point = tuple[float, float]
BBox = tuple[float, float, float, float]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def source_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalized_elements(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("elements"), list):
        return [row for row in payload["elements"] if isinstance(row, dict)]
    raise ValueError("OSM snapshot must be an element array or an Overpass object")


def latlon(point: dict[str, Any]) -> Point:
    return float(point["lat"]), float(point["lon"])


def same_point(a: Point, b: Point, tolerance: float = 1e-10) -> bool:
    return abs(a[0] - b[0]) <= tolerance and abs(a[1] - b[1]) <= tolerance


def close_ring(points: Sequence[Point]) -> list[Point]:
    out = list(points)
    if out and not same_point(out[0], out[-1]):
        out.append(out[0])
    return out


def stitch_rings(segments: Sequence[Sequence[Point]]) -> list[list[Point]]:
    """Join arbitrarily ordered/reversed OSM relation-member way segments."""
    remaining = [list(segment) for segment in segments if len(segment) >= 2]
    rings: list[list[Point]] = []
    while remaining:
        ring = remaining.pop(0)
        while not same_point(ring[0], ring[-1]):
            match_index = None
            reverse = False
            prepend = False
            for index, segment in enumerate(remaining):
                if same_point(ring[-1], segment[0]):
                    match_index = index
                    break
                if same_point(ring[-1], segment[-1]):
                    match_index = index
                    reverse = True
                    break
                if same_point(ring[0], segment[-1]):
                    match_index = index
                    prepend = True
                    break
                if same_point(ring[0], segment[0]):
                    match_index = index
                    reverse = True
                    prepend = True
                    break
            if match_index is None:
                raise ValueError("multipolygon member ways do not form closed rings")
            segment = remaining.pop(match_index)
            if reverse:
                segment.reverse()
            if prepend:
                ring = segment[:-1] + ring
            else:
                ring.extend(segment[1:])
        if len(ring) < 4:
            raise ValueError("multipolygon ring has fewer than four coordinates")
        rings.append(close_ring(ring))
    return rings


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    lat, lon = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        yi, xi = ring[i]
        yj, xj = ring[j]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-15) + xi
        ):
            inside = not inside
        j = i
    return inside


def signed_ring_area(ring: Sequence[Point]) -> float:
    return 0.5 * sum(
        a[1] * b[0] - b[1] * a[0]
        for a, b in zip(ring, ring[1:])
    )


def relation_polygon_parts(element: dict[str, Any]) -> list[list[list[Point]]]:
    by_role: dict[str, list[list[Point]]] = defaultdict(list)
    for member in element.get("members") or []:
        geometry = member.get("geometry") or []
        if len(geometry) < 2:
            continue
        role = str(member.get("role") or "outer").lower()
        by_role["inner" if role == "inner" else "outer"].append(
            [latlon(point) for point in geometry]
        )
    outers = stitch_rings(by_role.get("outer", []))
    inners = stitch_rings(by_role.get("inner", [])) if by_role.get("inner") else []
    if not outers:
        raise ValueError("multipolygon relation has no complete outer ring")

    parts: list[list[list[Point]]] = [[outer] for outer in outers]
    for inner in inners:
        containing = [
            (abs(signed_ring_area(part[0])), part)
            for part in parts
            if point_in_ring(inner[0], part[0])
        ]
        if not containing:
            raise ValueError("multipolygon inner ring is not contained by an outer ring")
        min(containing, key=lambda item: item[0])[1].append(inner)
    return parts


def project_latlon(point: Point, origin: Point) -> Point:
    latitude, longitude = point
    origin_latitude, origin_longitude = origin
    north_m = EARTH_RADIUS_M * math.radians(latitude - origin_latitude)
    east_m = (
        EARTH_RADIUS_M
        * math.radians(longitude - origin_longitude)
        * math.cos(math.radians(origin_latitude))
    )
    return east_m * METERS_TO_YARDS, north_m * METERS_TO_YARDS


def rounded_point(point: Point) -> list[float]:
    return [round(point[0], 4), round(point[1], 4)]


def way_points(element: dict[str, Any]) -> list[Point]:
    return [latlon(point) for point in (element.get("geometry") or [])]


def polygon_geometry(element: dict[str, Any], origin: Point) -> dict[str, Any] | None:
    tags = element.get("tags") or {}
    if element.get("type") == "relation" and tags.get("type") == "multipolygon":
        parts = relation_polygon_parts(element)
        projected = [
            [[rounded_point(project_latlon(point, origin)) for point in ring] for ring in part]
            for part in parts
        ]
        if len(projected) == 1:
            return {"type": "Polygon", "coordinates": projected[0]}
        return {"type": "MultiPolygon", "coordinates": projected}

    points = way_points(element)
    if len(points) < 4 or not same_point(points[0], points[-1]):
        return None
    ring = [rounded_point(project_latlon(point, origin)) for point in close_ring(points)]
    return {"type": "Polygon", "coordinates": [ring]}


def line_geometry(element: dict[str, Any], origin: Point) -> dict[str, Any] | None:
    points = way_points(element)
    if len(points) < 2:
        return None
    return {
        "type": "LineString",
        "coordinates": [rounded_point(project_latlon(point, origin)) for point in points],
    }


def geometry_points(geometry: dict[str, Any]) -> list[Point]:
    geometry_type = geometry["type"]
    coordinates = geometry["coordinates"]
    if geometry_type == "Point":
        return [(float(coordinates[0]), float(coordinates[1]))]
    if geometry_type == "LineString":
        return [(float(point[0]), float(point[1])) for point in coordinates]
    if geometry_type == "Polygon":
        return [
            (float(point[0]), float(point[1]))
            for ring in coordinates
            for point in ring
        ]
    if geometry_type == "MultiPolygon":
        return [
            (float(point[0]), float(point[1]))
            for polygon in coordinates
            for ring in polygon
            for point in ring
        ]
    raise ValueError(f"unsupported geometry type {geometry_type!r}")


def polygon_parts(geometry: dict[str, Any]) -> list[list[list[Point]]]:
    if geometry["type"] == "Polygon":
        return [[[(float(p[0]), float(p[1])) for p in ring] for ring in geometry["coordinates"]]]
    if geometry["type"] == "MultiPolygon":
        return [
            [[(float(p[0]), float(p[1])) for p in ring] for ring in polygon]
            for polygon in geometry["coordinates"]
        ]
    return []


def bbox_for_points(points: Sequence[Point]) -> BBox:
    if not points:
        raise ValueError("cannot compute bounds for empty geometry")
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_json(bounds: BBox) -> dict[str, float]:
    return {
        "minX": round(bounds[0], 3),
        "minY": round(bounds[1], 3),
        "maxX": round(bounds[2], 3),
        "maxY": round(bounds[3], 3),
    }


def feature_kind(tags: dict[str, Any]) -> tuple[str, str] | None:
    golf = str(tags.get("golf") or "")
    if golf in GOLF_SURFACES:
        return GOLF_SURFACES[golf], "surface"
    if tags.get("natural") == "water" or tags.get("water"):
        return "water_context", "context"
    if tags.get("leisure") == "golf_course":
        return "course_boundary", "context"
    if tags.get("waterway"):
        return "waterway", "context"
    if golf == "path" or tags.get("highway") in {"path", "footway"}:
        return "path", "context"
    return None


def compact_tags(tags: dict[str, Any]) -> dict[str, Any]:
    keep = ("golf", "natural", "water", "waterway", "leisure", "highway", "name", "ref", "par", "type")
    return {key: tags[key] for key in keep if tags.get(key) is not None}


def compile_features(
    elements: Sequence[dict[str, Any]], origin: Point
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]], list[dict[str, Any]]]:
    features: list[dict[str, Any]] = []
    routes: dict[int, dict[str, Any]] = {}
    warnings: list[dict[str, Any]] = []
    for element in elements:
        tags = element.get("tags") or {}
        osm_id = element.get("id")
        osm_type = str(element.get("type") or "unknown")
        if osm_id is None:
            continue

        if tags.get("golf") == "hole":
            geometry = line_geometry(element, origin)
            ref = str(tags.get("ref") or "")
            if geometry and ref.isdigit():
                routes[int(ref)] = {
                    "id": f"osm:{osm_type}:{osm_id}",
                    "osmId": int(osm_id),
                    "tags": compact_tags(tags),
                    "geometry": geometry,
                    "bbox": bbox_json(bbox_for_points(geometry_points(geometry))),
                }
            continue

        classified = feature_kind(tags)
        if not classified:
            continue
        kind, role = classified
        try:
            geometry = polygon_geometry(element, origin)
            if geometry is None and role == "context":
                geometry = line_geometry(element, origin)
            if geometry is None:
                warnings.append({
                    "osmType": osm_type,
                    "osmId": osm_id,
                    "reason": "supported tag has no closed polygon geometry",
                })
                continue
        except ValueError as exc:
            warnings.append({"osmType": osm_type, "osmId": osm_id, "reason": str(exc)})
            continue

        points = geometry_points(geometry)
        features.append({
            "id": f"osm:{osm_type}:{osm_id}",
            "osmType": osm_type,
            "osmId": int(osm_id),
            "kind": kind,
            "role": role,
            "sourceTags": compact_tags(tags),
            "geometry": geometry,
            "bbox": bbox_json(bbox_for_points(points)),
        })
    features.sort(key=lambda row: row["id"])
    return features, routes, warnings


def point_segment_distance(point: Point, start: Point, end: Point) -> float:
    px, py = point
    ax, ay = start
    bx, by = end
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    if denominator <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denominator))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def point_in_xy_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi
        ):
            inside = not inside
        j = i
    return inside


def point_in_polygon_parts(point: Point, parts: Sequence[Sequence[Sequence[Point]]]) -> bool:
    for part in parts:
        if not part or not point_in_xy_ring(point, part[0]):
            continue
        if not any(point_in_xy_ring(point, inner) for inner in part[1:]):
            return True
    return False


def line_polygon_distance(line: Sequence[Point], geometry: dict[str, Any]) -> float:
    parts = polygon_parts(geometry)
    if not line or not parts:
        return float("inf")
    if any(point_in_polygon_parts(point, parts) for point in line):
        return 0.0
    rings = [ring for part in parts for ring in part]
    distances = [
        point_segment_distance(point, start, end)
        for point in line
        for ring in rings
        for start, end in zip(ring, ring[1:])
    ]
    distances.extend(
        point_segment_distance(point, start, end)
        for ring in rings
        for point in ring
        for start, end in zip(line, line[1:])
    )
    return min(distances, default=float("inf"))


def line_line_distance(a: Sequence[Point], b: Sequence[Point]) -> float:
    distances = [
        point_segment_distance(point, start, end)
        for point in a
        for start, end in zip(b, b[1:])
    ]
    distances.extend(
        point_segment_distance(point, start, end)
        for point in b
        for start, end in zip(a, a[1:])
    )
    return min(distances, default=float("inf"))


def assign_nearest_holes(
    features: list[dict[str, Any]], routes: dict[int, dict[str, Any]]
) -> None:
    route_lines = {
        number: geometry_points(route["geometry"])
        for number, route in routes.items()
    }
    for feature in features:
        if feature["role"] != "surface":
            continue
        distances: list[tuple[float, int]] = []
        for number, line in route_lines.items():
            if feature["geometry"]["type"] in {"Polygon", "MultiPolygon"}:
                distance = line_polygon_distance(line, feature["geometry"])
            else:
                distance = line_line_distance(line, geometry_points(feature["geometry"]))
            distances.append((distance, number))
        if distances:
            distance, number = min(distances)
            feature["association"] = {
                "nearestHole": number,
                "routeDistanceYards": round(distance, 3),
            }


def cell_range(low: float, high: float, cell_size: float) -> range:
    return range(math.floor(low / cell_size), math.floor(high / cell_size) + 1)


def build_spatial_index(features: Sequence[dict[str, Any]], cell_size: float) -> dict[str, Any]:
    cells: dict[str, list[str]] = defaultdict(list)
    for feature in features:
        bounds = feature["bbox"]
        for x in cell_range(bounds["minX"], bounds["maxX"], cell_size):
            for y in cell_range(bounds["minY"], bounds["maxY"], cell_size):
                cells[f"{x}:{y}"].append(feature["id"])
    return {
        "type": "uniform-grid",
        "cellSizeYards": cell_size,
        "cells": {key: sorted(value) for key, value in sorted(cells.items())},
    }


def course_to_hole(point: Point, tee: Point, green: Point) -> Point:
    dx, dy = point[0] - tee[0], point[1] - tee[1]
    gx, gy = green[0] - tee[0], green[1] - tee[1]
    length = math.hypot(gx, gy)
    if length <= 1e-9:
        raise ValueError("selected tee and green anchors collapse")
    forward = (gx / length, gy / length)
    right = (forward[1], -forward[0])
    return dx * right[0] + dy * right[1], dx * forward[0] + dy * forward[1]


def local_bbox(feature: dict[str, Any], tee: Point, green: Point) -> BBox:
    return bbox_for_points([course_to_hole(point, tee, green) for point in geometry_points(feature["geometry"])])


def bounds_overlap(a: BBox, b: BBox) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def compile_holes(
    config: dict[str, Any],
    features: Sequence[dict[str, Any]],
    routes: dict[int, dict[str, Any]],
    origin: Point,
) -> list[dict[str, Any]]:
    feature_by_osm_id = {feature["osmId"]: feature for feature in features}
    policy = config["viewPolicy"]
    holes: list[dict[str, Any]] = []
    for source in config["holes"]:
        number = int(source["number"])
        route = routes.get(number)
        if route is None or route["osmId"] != int(source["routeOsmId"]):
            raise ValueError(f"Hole {number}: locked OSM route is missing or changed")
        tee_feature = feature_by_osm_id.get(int(source["selectedTee"]["osmId"]))
        green_feature = feature_by_osm_id.get(int(source["targetGreen"]["osmId"]))
        if tee_feature is None or tee_feature["kind"] != "tee":
            raise ValueError(f"Hole {number}: locked selected tee polygon is missing")
        if green_feature is None or green_feature["kind"] != "green":
            raise ValueError(f"Hole {number}: locked target green polygon is missing")

        tee = project_latlon(tuple(source["selectedTee"]["latLon"]), origin)
        green = project_latlon(tuple(source["targetGreen"]["latLon"]), origin)
        green_forward = course_to_hole(green, tee, green)[1]
        min_forward = -float(policy["behindSelectedTeeYards"])
        max_forward = green_forward + float(policy["pastTargetGreenYards"])

        selected: list[tuple[dict[str, Any], BBox]] = []
        for feature in features:
            include = False
            if feature["id"] in {tee_feature["id"], green_feature["id"]}:
                include = True
            elif feature["role"] == "surface" and feature.get("association", {}).get("nearestHole") == number:
                if feature["kind"] not in {"tee", "green"}:
                    include = True
            if not include:
                continue
            bounds = local_bbox(feature, tee, green)
            if bounds[3] < min_forward or bounds[1] > max_forward:
                continue
            selected.append((feature, bounds))

        right_values = [value for _, bounds in selected for value in (bounds[0], bounds[2])]
        minimum_half = float(policy["minimumHalfWidthYards"])
        maximum_half = float(policy["maximumHalfWidthYards"])
        padding = float(policy["sidePaddingYards"])
        min_right = max(-maximum_half, min(right_values, default=-minimum_half) - padding)
        max_right = min(maximum_half, max(right_values, default=minimum_half) + padding)
        min_right = min(min_right, -minimum_half)
        max_right = max(max_right, minimum_half)
        clip_bounds = (min_right, min_forward, max_right, max_forward)
        selected = [item for item in selected if bounds_overlap(item[1], clip_bounds)]

        raw_par = route["tags"].get("par")
        try:
            parsed_par = int(raw_par)
        except (TypeError, ValueError):
            parsed_par = None
        display_par = parsed_par if parsed_par in {3, 4, 5} else None
        locked = source["lockedEvidence"]
        computed_residual = green_forward - float(source["gsproYards"])
        evidence_delta = computed_residual - float(locked["residualYards"])
        holes.append({
            "number": number,
            "par": {
                "value": display_par,
                "source": "osm-hole-route-tag" if display_par is not None else "unverified",
                "rawOsmValue": raw_par,
            },
            "yardage": {
                "gsproTeeToPinYards": float(source["gsproYards"]),
                "osmTeeToGreenCentroidYards": round(green_forward, 3),
                "residualYards": round(computed_residual, 3),
                "lockedEvidenceResidualYards": float(locked["residualYards"]),
                "lockedEvidenceDeltaYards": round(evidence_delta, 3),
            },
            "route": route,
            "anchors": {
                "selectedTee": {
                    "featureId": tee_feature["id"],
                    "osmId": tee_feature["osmId"],
                    "latLon": source["selectedTee"]["latLon"],
                    "coursePoint": rounded_point(tee),
                },
                "targetGreen": {
                    "featureId": green_feature["id"],
                    "osmId": green_feature["osmId"],
                    "latLon": source["targetGreen"]["latLon"],
                    "coursePoint": rounded_point(green),
                },
                "headingDegreesTrue": round(float(locked["headingDegreesTrue"]), 2),
            },
            "view": {
                "coordinateSystem": "selected tee origin; +forward to target green; +right golfer-right; yards",
                "clipBounds": bbox_json(clip_bounds),
                "featureIds": [feature["id"] for feature, _ in selected],
                "renderPolicy": "spatially associated OSM surfaces; only the locked tee and target green; clipped at render time",
            },
            "quality": {
                "selectedTeePresent": True,
                "targetGreenPresent": True,
                "staticGeometryReady": any(feature["kind"] == "fairway" for feature, _ in selected),
                "anchorEvidenceWithinQuarterYard": abs(evidence_delta) <= 0.25,
                "featureCount": len(selected),
            },
        })
    return holes


def fit_registration(tie_payload: dict[str, Any], origin: Point) -> dict[str, Any]:
    observations = tie_payload.get("observations") or []
    pairs: list[tuple[Point, Point]] = []
    for observation in observations:
        position = observation.get("ending_pos") or {}
        if position.get("x") is None or position.get("z") is None:
            continue
        if observation.get("lat") is None or observation.get("lon") is None:
            continue
        pairs.append((
            (float(position["x"]), float(position["z"])),
            project_latlon((float(observation["lat"]), float(observation["lon"])), origin),
        ))
    if len(pairs) < 2:
        raise ValueError("course registration requires at least two GSPro/OSM tie points")

    source_mean = (
        sum(source[0] for source, _ in pairs) / len(pairs),
        sum(source[1] for source, _ in pairs) / len(pairs),
    )
    target_mean = (
        sum(target[0] for _, target in pairs) / len(pairs),
        sum(target[1] for _, target in pairs) / len(pairs),
    )
    denominator = sum(
        (source[0] - source_mean[0]) ** 2 + (source[1] - source_mean[1]) ** 2
        for source, _ in pairs
    )
    if denominator <= 1e-12:
        raise ValueError("course registration tie points collapse")
    a = sum(
        (source[0] - source_mean[0]) * (target[0] - target_mean[0])
        + (source[1] - source_mean[1]) * (target[1] - target_mean[1])
        for source, target in pairs
    ) / denominator
    b = sum(
        (source[0] - source_mean[0]) * (target[1] - target_mean[1])
        - (source[1] - source_mean[1]) * (target[0] - target_mean[0])
        for source, target in pairs
    ) / denominator
    translate_x = target_mean[0] - a * source_mean[0] + b * source_mean[1]
    translate_y = target_mean[1] - b * source_mean[0] - a * source_mean[1]

    residuals: list[float] = []
    for source, target in pairs:
        predicted = (
            a * source[0] - b * source[1] + translate_x,
            b * source[0] + a * source[1] + translate_y,
        )
        residuals.append(math.hypot(predicted[0] - target[0], predicted[1] - target[1]))
    return {
        "source": "GSPro world X/Z",
        "target": "CourseGeometryPackage course coordinates",
        "formula": {
            "x": "a * gsproX - b * gsproZ + translateX",
            "y": "b * gsproX + a * gsproZ + translateY",
        },
        "parameters": {
            "a": round(a, 12),
            "b": round(b, 12),
            "translateX": round(translate_x, 9),
            "translateY": round(translate_y, 9),
            "scaleYardsPerGsproUnit": round(math.hypot(a, b), 12),
            "rotationDegreesCounterClockwise": round(math.degrees(math.atan2(b, a)), 9),
        },
        "validation": {
            "tiePointCount": len(pairs),
            "meanResidualYards": round(sum(residuals) / len(residuals), 6),
            "medianResidualYards": round(statistics.median(residuals), 6),
            "maxResidualYards": round(max(residuals), 6),
            "activationGatePassed": max(residuals) <= 0.25,
        },
    }


def compile_package(config_path: Path) -> dict[str, Any]:
    repo_root = config_path.resolve().parents[2]
    config = read_json(config_path)
    sources = {
        key: repo_root / value
        for key, value in config["sources"].items()
    }
    elements = normalized_elements(read_json(sources["osmSnapshot"]))
    metadata_payload = read_json(sources["osmMetadata"])
    origin = tuple(float(value) for value in config["coordinateSystem"]["originLatLon"])
    features, routes, warnings = compile_features(elements, origin)
    assign_nearest_holes(features, routes)
    indexed_features = [feature for feature in features if feature["role"] == "surface"]
    spatial_index = build_spatial_index(
        indexed_features, float(config["viewPolicy"]["spatialIndexCellYards"])
    )
    holes = compile_holes(config, features, routes, origin)
    registration_proof = read_json(sources["registrationProof"])
    registration = fit_registration(read_json(sources["registrationTiePoints"]), origin)

    all_points = [
        point
        for feature in indexed_features
        for point in geometry_points(feature["geometry"])
    ]
    source_hashes = {key: source_digest(path) for key, path in sorted(sources.items())}
    fingerprint = hashlib.sha256(
        json.dumps({"config": config, "sourceHashes": source_hashes}, sort_keys=True).encode("utf-8")
    ).hexdigest()
    osm_metadata = metadata_payload.get("osm3s") or {}
    proof_transform = registration_proof.get("transform") or {}
    proof_tee = registration_proof.get("tee_registration") or {}
    proof_start = registration_proof.get("surface_validation_start_positions") or {}
    proof_end = registration_proof.get("surface_validation_end_positions") or {}

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "buildFingerprint": fingerprint,
        "course": config["course"],
        "coordinateSystem": config["coordinateSystem"],
        "bounds": bbox_json(bbox_for_points(all_points)),
        "attribution": {
            "geometry": "© OpenStreetMap contributors, ODbL 1.0",
            "snapshotTimestamp": osm_metadata.get("timestamp_osm_base"),
            "role": "static course geometry",
        },
        "sourceArtifacts": {
            key: {"path": str(path.relative_to(repo_root)), "sha256": source_hashes[key]}
            for key, path in sorted(sources.items())
        },
        "registration": {
            **registration,
            "preservedProof": {
                "result": registration_proof.get("result"),
                "scaleInterpretation": proof_transform.get("scale_interpretation"),
                "teeMeanResidualYards": proof_tee.get("mean_residual_yards"),
                "teeMaxResidualYards": proof_tee.get("max_residual_yards"),
                "surfaceStartInside": proof_start.get("inside_expected_osm_surface"),
                "surfaceStartTested": proof_start.get("tested"),
                "surfaceEndInside": proof_end.get("inside_expected_osm_surface"),
                "surfaceEndTested": proof_end.get("tested"),
            },
        },
        "features": features,
        "spatialIndex": spatial_index,
        "holes": holes,
        "compilerDiagnostics": {
            "elementCount": len(elements),
            "featureCount": len(features),
            "spatiallyIndexedSurfaceFeatureCount": len(indexed_features),
            "routeCount": len(routes),
            "unsupportedGeometry": warnings,
            "allHolesStaticGeometryReady": all(hole["quality"]["staticGeometryReady"] for hole in holes),
            "allAnchorEvidenceWithinQuarterYard": all(hole["quality"]["anchorEvidenceWithinQuarterYard"] for hole in holes),
        },
        "integrationContract": {
            "activation": "render-and-strategy-shadow-only",
            "strategyAuthority": False,
            "dynamicStateStorage": "outside-course-geometry-package",
            "liveBallPosition": {
                "source": "GSPro currentRound world X/Z",
                "transform": "registration parameters above",
                "teeCaveat": "currentRound may be stale before the first shot; bind the cached selected tee using trusted hole identity",
            },
            "wind": {
                "requiredForLiveDecisionSnapshot": True,
                "source": "gspro-screen-wind-panel",
                "method": "GSPro top-center HUD OCR",
                "fields": ["speed_mph", "direction_cardinal"],
                "directionSemantics": "gspro-display-until-wind-from-vs-wind-toward-is-validated",
                "failurePolicy": "unavailable-never-assume-calm",
                "embeddedInStaticGeometry": False,
            },
            "simulatorSpecificOverlays": {
                "source": "GSPro minimap/screen sensors",
                "retainedFor": ["red penalty boundaries", "out of bounds", "green heatmap", "visual overrides", "fallback validation"],
                "embeddedInStaticGeometry": False,
            },
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Looper CourseGeometryPackage v1")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config/course-geometry/greywolf-v1.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/course-geometry/greywolf-v1.json"),
    )
    parser.add_argument("--check", action="store_true", help="Fail if committed output is stale")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = compile_package(args.config)
    encoded = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != encoded:
            raise SystemExit(f"Course geometry package is stale: {args.output}")
        print(f"Course geometry package is current: {args.output}")
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "schemaVersion": payload["schemaVersion"],
        "features": len(payload["features"]),
        "holes": len(payload["holes"]),
        "registrationMaxResidualYards": payload["registration"]["validation"]["maxResidualYards"],
        "fingerprint": payload["buildFingerprint"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
