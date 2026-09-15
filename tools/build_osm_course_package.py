#!/usr/bin/env python3
"""Build a cached Looper static course package from an Overpass JSON snapshot.

This compiler is intentionally offline at runtime: the browser consumes the
generated package; OpenStreetMap is queried only by a build/refresh workflow.

Semantics:
- golf=rough remains regular rough.
- no "deep rough" is invented.
- woods/scrub/grass are context layers, not playable-surface substitutions.
- dynamic GSPro concepts (live pin, lie, penalty state) are not inferred here.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

EARTH_RADIUS_M = 6_371_008.8
M_TO_YD = 1.0936133

SURFACE_GOLF = {
    "fairway": "fairway",
    "rough": "rough",
    "green": "green",
    "bunker": "bunker",
    "tee": "tee",
    "water_hazard": "water",
    "lateral_water_hazard": "water",
}
CONTEXT_NATURAL = {"wood": "woods", "scrub": "scrub"}
CONTEXT_LANDUSE = {"forest": "woods", "grass": "grass-context", "meadow": "grass-context"}


def as_latlon(points: Iterable[dict[str, Any]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for point in points:
        lat = point.get("lat")
        lon = point.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            out.append((float(lat), float(lon)))
    return out


def same_point(a: tuple[float, float], b: tuple[float, float], tolerance: float = 1e-8) -> bool:
    return abs(a[0] - b[0]) <= tolerance and abs(a[1] - b[1]) <= tolerance


def join_chains(chains: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    pending = [chain[:] for chain in chains if len(chain) >= 2]
    joined: list[list[tuple[float, float]]] = []
    while pending:
        chain = pending.pop(0)
        changed = True
        while changed and pending:
            changed = False
            for index, other in enumerate(pending):
                if same_point(chain[-1], other[0]):
                    chain.extend(other[1:])
                elif same_point(chain[-1], other[-1]):
                    chain.extend(reversed(other[:-1]))
                elif same_point(chain[0], other[-1]):
                    chain = other[:-1] + chain
                elif same_point(chain[0], other[0]):
                    chain = list(reversed(other[1:])) + chain
                else:
                    continue
                pending.pop(index)
                changed = True
                break
        joined.append(chain)
    return joined


def element_geometries(element: dict[str, Any]) -> list[list[tuple[float, float]]]:
    direct = as_latlon(element.get("geometry") or [])
    if direct:
        return [direct]

    members = element.get("members") or []
    outer_chains: list[list[tuple[float, float]]] = []
    fallback_chains: list[list[tuple[float, float]]] = []
    for member in members:
        geometry = as_latlon(member.get("geometry") or [])
        if not geometry:
            continue
        fallback_chains.append(geometry)
        if member.get("role") in ("outer", ""):
            outer_chains.append(geometry)

    chains = outer_chains or fallback_chains
    return join_chains(chains)


def centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    if not points:
        raise ValueError("Cannot compute centroid of empty geometry")
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def haversine_yards(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h)) * M_TO_YD


def local_east_north_yards(
    latlon: tuple[float, float],
    origin: tuple[float, float],
) -> tuple[float, float]:
    lat, lon = latlon
    lat0, lon0 = origin
    north_m = EARTH_RADIUS_M * math.radians(lat - lat0)
    east_m = EARTH_RADIUS_M * math.radians(lon - lon0) * math.cos(math.radians(lat0))
    return east_m * M_TO_YD, north_m * M_TO_YD


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    if len(polygon) < 3:
        return False
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def point_segment_distance(
    point: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> float:
    px, py = point
    ax, ay = a
    bx, by = b
    dx = bx - ax
    dy = by - ay
    denom = dx * dx + dy * dy
    if denom <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    qx = ax + t * dx
    qy = ay + t * dy
    return math.hypot(px - qx, py - qy)


def point_polyline_distance(
    point: tuple[float, float],
    line: list[tuple[float, float]],
) -> float:
    if not line:
        return float("inf")
    if len(line) == 1:
        return math.hypot(point[0] - line[0][0], point[1] - line[0][1])
    return min(point_segment_distance(point, a, b) for a, b in zip(line, line[1:]))


def polyline_polygon_distance(
    line: list[tuple[float, float]],
    polygon: list[tuple[float, float]],
) -> float:
    if not line or not polygon:
        return float("inf")
    if any(point_in_polygon(point, polygon) for point in line):
        return 0.0
    return min(point_polyline_distance(point, line) for point in polygon)


def feature_distance_to_route(
    geometries_xy: list[list[tuple[float, float]]],
    route_xy: list[tuple[float, float]],
) -> float:
    distances = [
        polyline_polygon_distance(route_xy, geometry)
        for geometry in geometries_xy
        if len(geometry) >= 3
    ]
    return min(distances, default=float("inf"))


def classify_element(tags: dict[str, Any]) -> tuple[str, str] | None:
    golf = tags.get("golf")
    if golf in SURFACE_GOLF:
        return "surface", SURFACE_GOLF[golf]
    if tags.get("natural") == "water" or tags.get("landuse") == "reservoir":
        return "surface", "water"
    natural = tags.get("natural")
    if natural in CONTEXT_NATURAL:
        return "context", CONTEXT_NATURAL[natural]
    landuse = tags.get("landuse")
    if landuse in CONTEXT_LANDUSE:
        return "context", CONTEXT_LANDUSE[landuse]
    return None


def source_feature(tags: dict[str, Any], kind: str) -> str:
    if tags.get("golf"):
        return f"golf={tags['golf']}"
    if tags.get("natural"):
        return f"natural={tags['natural']}"
    if tags.get("landuse"):
        return f"landuse={tags['landuse']}"
    return f"osm={kind}"


def normalize_osm(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    features: list[dict[str, Any]] = []
    hole_routes: dict[int, dict[str, Any]] = {}

    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        geometries = element_geometries(element)
        points = [point for geometry in geometries for point in geometry]
        if not points:
            continue

        if tags.get("golf") == "hole" and str(tags.get("ref", "")).isdigit():
            hole = int(tags["ref"])
            route = max(geometries, key=len)
            hole_routes[hole] = {
                "hole": hole,
                "osm_type": element.get("type"),
                "osm_id": element.get("id"),
                "par": tags.get("par"),
                "geometry": route,
            }
            continue

        classified = classify_element(tags)
        if not classified:
            continue
        role, kind = classified
        polygon_geometries = [geometry for geometry in geometries if len(geometry) >= 3]
        if not polygon_geometries:
            continue
        features.append(
            {
                "role": role,
                "kind": kind,
                "osm_type": element.get("type"),
                "osm_id": element.get("id"),
                "source_feature": source_feature(tags, kind),
                "geometries": polygon_geometries,
                "centroid": centroid([point for geometry in polygon_geometries for point in geometry]),
            }
        )

    return features, hole_routes


def course_projection_origin(
    hole_routes: dict[int, dict[str, Any]],
    features: list[dict[str, Any]],
) -> tuple[float, float]:
    route_points = [
        point
        for route in hole_routes.values()
        for point in route["geometry"]
    ]
    if route_points:
        return centroid(route_points)
    feature_points = [
        point
        for feature in features
        for geometry in feature["geometries"]
        for point in geometry
    ]
    return centroid(feature_points)


def course_xy(
    latlon: tuple[float, float],
    origin: tuple[float, float],
) -> tuple[float, float]:
    return local_east_north_yards(latlon, origin)


def assign_nearest_holes(
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    origin: tuple[float, float],
) -> dict[int, list[tuple[float, dict[str, Any]]]]:
    route_xy = {
        hole: [course_xy(point, origin) for point in route["geometry"]]
        for hole, route in hole_routes.items()
    }
    route_candidates: dict[int, list[tuple[float, dict[str, Any]]]] = {
        hole: [] for hole in hole_routes
    }

    for feature in features:
        geometries_xy = [
            [course_xy(point, origin) for point in geometry]
            for geometry in feature["geometries"]
        ]
        distances = {
            hole: feature_distance_to_route(geometries_xy, line)
            for hole, line in route_xy.items()
        }
        for hole, distance in distances.items():
            route_candidates[hole].append((distance, feature))
        if feature["kind"] not in {"tee", "green", "rough"} and distances:
            best_hole = min(distances, key=distances.get)
            feature["assigned_hole"] = best_hole
            feature["assigned_route_distance_yards"] = distances[best_hole]

    return route_candidates


def select_target_green(
    route: dict[str, Any],
    greens: list[dict[str, Any]],
) -> tuple[dict[str, Any], float]:
    endpoint = route["geometry"][-1]
    ranked = sorted(
        ((haversine_yards(green["centroid"], endpoint), green) for green in greens),
        key=lambda item: item[0],
    )
    if not ranked:
        raise ValueError("No mapped greens")
    return ranked[0][1], ranked[0][0]


def select_tee(
    route: dict[str, Any],
    target_green: dict[str, Any],
    tees: list[dict[str, Any]],
    target_yards: float,
    radius_yards: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    start = route["geometry"][0]
    green = target_green["centroid"]
    candidates: list[dict[str, Any]] = []
    for tee in tees:
        tee_center = tee["centroid"]
        start_gap = haversine_yards(tee_center, start)
        if start_gap > radius_yards:
            continue
        green_distance = haversine_yards(tee_center, green)
        candidates.append(
            {
                "feature": tee,
                "tee_id": tee["osm_id"],
                "start_gap_yards": start_gap,
                "green_distance_yards": green_distance,
                "target_residual_yards": green_distance - target_yards,
            }
        )

    if not candidates:
        raise ValueError("No tee polygon candidates near nominal hole start")
    candidates.sort(key=lambda candidate: (
        abs(candidate["target_residual_yards"]),
        candidate["start_gap_yards"],
    ))
    return candidates[0]["feature"], candidates


def basis_for_anchors(
    tee: dict[str, Any],
    green: dict[str, Any],
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float], float]:
    origin = tee["centroid"]
    gx, gy = local_east_north_yards(green["centroid"], origin)
    length = math.hypot(gx, gy)
    if length <= 1e-9:
        raise ValueError("Tee and green anchors collapse to the same point")
    forward = (gx / length, gy / length)
    right = (forward[1], -forward[0])
    heading = (math.degrees(math.atan2(gx, gy)) + 360.0) % 360.0
    return origin, forward, right, heading


def to_hole_local(
    latlon: tuple[float, float],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> tuple[float, float]:
    east, north = local_east_north_yards(latlon, origin)
    return (
        east * right[0] + north * right[1],
        east * forward[0] + north * forward[1],
    )


def serialize_polygons(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    for geometry in feature["geometries"]:
        polygon = [
            to_hole_local(point, origin, forward, right)
            for point in geometry
        ]
        if len(polygon) >= 3:
            polygons.append([[round(x, 3), round(y, 3)] for x, y in polygon])
    return polygons


def forward_range(polygons: list[list[list[float]]]) -> tuple[float, float]:
    values = [point[1] for polygon in polygons for point in polygon]
    if not values:
        return 0.0, 0.0
    return min(values), max(values)


def in_play_window(
    polygons: list[list[list[float]]],
    max_forward: float,
    behind_tolerance: float,
    past_tolerance: float,
) -> bool:
    min_forward, max_feature_forward = forward_range(polygons)
    return (
        max_feature_forward >= -behind_tolerance
        and min_forward <= max_forward + past_tolerance
    )


def grouped_layer(
    hole_number: int,
    role: str,
    kind: str,
    features: list[dict[str, Any]],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    max_forward: float,
    behind_tolerance: float,
    past_tolerance: float,
) -> dict[str, Any] | None:
    all_polygons: list[list[list[float]]] = []
    source_ids: list[int | str] = []
    source_features: set[str] = set()

    for feature in features:
        polygons = serialize_polygons(feature, origin, forward, right)
        if not polygons or not in_play_window(
            polygons,
            max_forward,
            behind_tolerance,
            past_tolerance,
        ):
            continue
        all_polygons.extend(polygons)
        if feature.get("osm_id") is not None:
            source_ids.append(feature["osm_id"])
        source_features.add(feature["source_feature"])

    if not all_polygons:
        return None

    return {
        "id": f"h{hole_number:02d}-{role}-{kind}",
        "kind": kind,
        "polygons": all_polygons,
        "sourceFeature": " / ".join(sorted(source_features)),
        "sourceIds": source_ids,
        "confidence": "high",
        "note": (
            "Cached OSM playable geometry."
            if role == "surface"
            else "Cached OSM context/obstruction geometry; not promoted to a playable lie."
        ),
    }


def model_for_hole(
    hole_number: int,
    hole_config: dict[str, Any],
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    route_candidates: dict[int, list[tuple[float, dict[str, Any]]]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    route = hole_routes[hole_number]
    target_yards = float(hole_config["targetYards"])
    selection = config.get("selection") or {}
    tee_radius = float(selection.get("teeStartRadiusYards", 220))
    context_distance = float(selection.get("contextRouteDistanceYards", 110))
    behind_tolerance = float(selection.get("behindTeeToleranceYards", 35))
    past_tolerance = float(selection.get("pastGreenToleranceYards", 50))

    greens = [feature for feature in features if feature["kind"] == "green"]
    tees = [feature for feature in features if feature["kind"] == "tee"]
    target_green, green_endpoint_gap = select_target_green(route, greens)
    selected_tee, tee_candidates = select_tee(
        route,
        target_green,
        tees,
        target_yards,
        tee_radius,
    )
    origin, forward, right, heading = basis_for_anchors(selected_tee, target_green)
    tee_to_green = haversine_yards(selected_tee["centroid"], target_green["centroid"])

    surface_features: dict[str, list[dict[str, Any]]] = {
        "tee": [selected_tee],
        "green": [target_green],
        "fairway": [],
        "rough": [],
        "bunker": [],
        "water": [],
    }

    for feature in features:
        if feature["role"] != "surface" or feature["kind"] in {"tee", "green"}:
            continue
        if feature["kind"] == "rough":
            near_this_hole = any(
                candidate is feature and distance <= context_distance
                for distance, candidate in route_candidates[hole_number]
            )
            if near_this_hole:
                surface_features["rough"].append(feature)
        elif feature.get("assigned_hole") == hole_number:
            surface_features.setdefault(feature["kind"], []).append(feature)

    surfaces: list[dict[str, Any]] = []
    for kind in ("rough", "water", "fairway", "green", "bunker", "tee"):
        layer = grouped_layer(
            hole_number,
            "surface",
            kind,
            surface_features.get(kind, []),
            origin,
            forward,
            right,
            tee_to_green,
            behind_tolerance,
            past_tolerance,
        )
        if layer:
            surfaces.append(layer)

    context_features: dict[str, list[dict[str, Any]]] = {
        "woods": [],
        "scrub": [],
        "grass-context": [],
    }
    for distance, feature in route_candidates[hole_number]:
        if (
            feature["role"] == "context"
            and feature["kind"] in context_features
            and distance <= context_distance
        ):
            context_features[feature["kind"]].append(feature)

    context_layers: list[dict[str, Any]] = []
    for kind in ("grass-context", "woods", "scrub"):
        layer = grouped_layer(
            hole_number,
            "context",
            kind,
            context_features[kind],
            origin,
            forward,
            right,
            tee_to_green,
            behind_tolerance,
            past_tolerance,
        )
        if layer:
            context_layers.append(layer)

    route_local = [
        to_hole_local(point, origin, forward, right)
        for point in route["geometry"]
    ]
    bounds_points = route_local[:]
    for layer in surfaces:
        for polygon in layer["polygons"]:
            bounds_points.extend((point[0], point[1]) for point in polygon)
    if not bounds_points:
        raise ValueError(f"Hole {hole_number} produced no geometry bounds")

    pin = to_hole_local(target_green["centroid"], origin, forward, right)
    selected_tee_local = to_hole_local(selected_tee["centroid"], origin, forward, right)

    model = {
        "holeNumber": hole_number,
        "par": int(hole_config.get("par") or route.get("par") or 0) or None,
        "statedYardageYds": target_yards,
        "bounds": {
            "minX": round(min(point[0] for point in bounds_points), 1),
            "maxX": round(max(point[0] for point in bounds_points), 1),
            "minY": round(min(point[1] for point in bounds_points), 1),
            "maxY": round(max(point[1] for point in bounds_points), 1),
        },
        "markers": {
            "tee": [round(selected_tee_local[0], 3), round(selected_tee_local[1], 3)],
            "pin": [round(pin[0], 3), round(pin[1], 3)],
        },
        "surfaces": surfaces,
        "contextLayers": context_layers,
        "registration": {
            "status": "approximate",
            "method": "hole-local",
            "sourceCoordinateSystem": "OSM WGS84 -> selected mapped tee / target green local yards",
            "note": (
                f"Static package uses the provisional {config.get('teeReference', {}).get('name', 'reference')} "
                "scorecard yardages to choose a consistent mapped tee. GSPro course-wide registration is not yet proven."
            ),
        },
    }

    surface_counts = {
        kind: sum(len(layer["polygons"]) for layer in surfaces if layer["kind"] == kind)
        for kind in ("tee", "fairway", "rough", "green", "bunker", "water")
    }
    context_counts = {
        kind: sum(len(layer["polygons"]) for layer in context_layers if layer["kind"] == kind)
        for kind in ("woods", "scrub", "grass-context")
    }
    diagnostics = {
        "hole": hole_number,
        "par": model["par"],
        "referenceYards": target_yards,
        "selectedTeeOsmId": selected_tee["osm_id"],
        "targetGreenOsmId": target_green["osm_id"],
        "greenEndpointGapYards": round(green_endpoint_gap, 1),
        "teeToGreenCentroidYards": round(tee_to_green, 1),
        "straightLineResidualYards": round(tee_to_green - target_yards, 1),
        "headingDegreesTrue": round(heading, 2),
        "surfacePolygons": surface_counts,
        "contextPolygons": context_counts,
        "teeCandidates": [
            {
                "osmId": candidate["tee_id"],
                "startGapYards": round(candidate["start_gap_yards"], 1),
                "teeToGreenCentroidYards": round(candidate["green_distance_yards"], 1),
                "straightLineResidualYards": round(candidate["target_residual_yards"], 1),
            }
            for candidate in tee_candidates[:6]
        ],
        "ready": (
            surface_counts["tee"] > 0
            and surface_counts["green"] > 0
            and surface_counts["fairway"] > 0
        ),
    }
    return model, diagnostics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", required=True, type=Path, help="Preserved Overpass JSON snapshot")
    parser.add_argument("--config", required=True, type=Path, help="Course build config JSON")
    parser.add_argument("--output", required=True, type=Path, help="Browser package JSON")
    parser.add_argument("--manifest", required=True, type=Path, help="Validation manifest JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = json.loads(args.osm.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != "looper-course-build-config-v1":
        raise SystemExit("Unsupported course build config schema")

    hole_configs = {
        int(key): value
        for key, value in (config.get("holes") or {}).items()
        if str(key).isdigit()
    }
    if sorted(hole_configs) != list(range(1, 19)):
        raise SystemExit(f"Expected config for holes 1-18; got {sorted(hole_configs)}")

    features, hole_routes = normalize_osm(payload)
    missing_routes = sorted(set(hole_configs) - set(hole_routes))
    if missing_routes:
        raise SystemExit(f"Missing OSM golf=hole routes: {missing_routes}")

    origin = course_projection_origin(hole_routes, features)
    route_candidates = assign_nearest_holes(features, hole_routes, origin)

    holes: dict[str, Any] = {}
    diagnostics: list[dict[str, Any]] = []
    for hole_number in range(1, 19):
        model, diagnostic = model_for_hole(
            hole_number,
            hole_configs[hole_number],
            config,
            features,
            hole_routes,
            route_candidates,
        )
        holes[str(hole_number)] = model
        diagnostics.append(diagnostic)

    ready_holes = [item["hole"] for item in diagnostics if item["ready"]]
    source_counts = Counter(
        f"{feature['role']}:{feature['kind']}"
        for feature in features
    )
    osm3s = payload.get("osm3s") or {}
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    package = {
        "schemaVersion": "looper-static-course-package-v1",
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "location": config["location"],
        "generatedAt": generated_at,
        "provenance": {
            "geometrySource": "Cached OpenStreetMap/Overpass static course geometry",
            "attribution": "© OpenStreetMap contributors",
            "sourceUrl": f"https://www.openstreetmap.org/way/{config['osmCourseWayId']}",
            "copyrightUrl": "https://www.openstreetmap.org/copyright",
            "license": "Open Database License (ODbL)",
            "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
            "fetchedAt": generated_at,
            "sourceBaseTimestamp": osm3s.get("timestamp_osm_base"),
            "sourceElementIdsComplete": True,
            "note": (
                "Static geometry is generated ahead of play and cached with Looper. "
                "No live OSM query is required during a round."
            ),
        },
        "teeReference": config.get("teeReference"),
        "holes": holes,
    }

    manifest = {
        "schemaVersion": "looper-course-package-validation-v1",
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "osmCourseWayId": config["osmCourseWayId"],
        "sourceBaseTimestamp": osm3s.get("timestamp_osm_base"),
        "generatedAt": generated_at,
        "osmHoleRoutes": len(hole_routes),
        "normalizedFeatureCounts": dict(sorted(source_counts.items())),
        "readyHoleCount": len(ready_holes),
        "readyHoles": ready_holes,
        "allHolesStaticGeometryReady": len(ready_holes) == 18,
        "registrationStatus": "approximate",
        "registrationNote": (
            "OSM static geometry is packaged, but GSPro registration is intentionally not called verified. "
            "The first Tobacco Road league round should validate the course identity, tee mapping and live coordinates."
        ),
        "holes": diagnostics,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(package, indent=2, sort_keys=True), encoding="utf-8")
    args.manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    print(json.dumps({
        "course": config["courseName"],
        "hole_routes": len(hole_routes),
        "features": dict(sorted(source_counts.items())),
        "ready_holes": ready_holes,
        "all_ready": len(ready_holes) == 18,
        "output": str(args.output),
        "manifest": str(args.manifest),
    }, indent=2, sort_keys=True))

    if len(ready_holes) != 18:
        raise SystemExit(f"Static geometry incomplete; ready holes: {ready_holes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
