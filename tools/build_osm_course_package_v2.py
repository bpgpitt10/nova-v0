#!/usr/bin/env python3
"""Build a course-wide OSM package using per-hole OSM route orientation.

V2 makes the OSM `golf=hole` route the canonical hole frame. The route start
is the tee-side anchor and route direction supplies the downrange axis; nearby
mapped tee surfaces are diagnostics rather than something that can silently
replace the hole origin.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_osm_course_package as base


def raw_context_source_counts(payload: dict[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        # Golf surface tags win in classify_element; do not describe a
        # landuse=grass golf surface as standalone context in provenance.
        if tags.get("golf") in base.SURFACE_GOLF:
            continue
        classified = base.classify_element(tags)
        if not classified:
            continue
        role, kind = classified
        if role == "context":
            counts[base.source_feature(tags, kind)] += 1
    return counts


def route_basis(
    route: list[tuple[float, float]],
) -> tuple[
    tuple[float, float],
    tuple[float, float],
    tuple[float, float],
    float,
]:
    if len(route) < 2:
        raise ValueError("OSM hole route has fewer than two points")
    origin = route[0]
    east, north = base.local_east_north_yards(route[-1], origin)
    magnitude = math.hypot(east, north)
    if magnitude <= 1e-9:
        raise ValueError("OSM hole route start/end are coincident")
    forward = (east / magnitude, north / magnitude)
    right = (forward[1], -forward[0])
    heading = (math.degrees(math.atan2(east, north)) + 360.0) % 360.0
    return origin, forward, right, heading


def tee_diagnostics(
    features: list[dict[str, Any]],
    route: list[tuple[float, float]],
    projection_origin: tuple[float, float],
    limit_yards: float,
) -> list[dict[str, Any]]:
    start_xy = base.course_xy(route[0], projection_origin)
    candidates: list[dict[str, Any]] = []
    for feature in features:
        if feature["role"] != "surface" or feature["kind"] != "tee":
            continue
        polygon_gap = base.feature_distance_to_route(
            [
                [base.course_xy(point, projection_origin) for point in geometry]
                for geometry in feature["geometries"]
            ],
            [start_xy],
        )
        centroid_gap = base.haversine_yards(feature["centroid"], route[0])
        if polygon_gap > limit_yards and centroid_gap > limit_yards:
            continue
        candidates.append(
            {
                "osmId": feature.get("osm_id"),
                "startPolygonGapYards": polygon_gap,
                "startCentroidGapYards": centroid_gap,
            }
        )
    candidates.sort(key=lambda item: (item["startPolygonGapYards"], item["startCentroidGapYards"]))
    return candidates


def feature_course_xy(
    feature: dict[str, Any],
    projection_origin: tuple[float, float],
) -> list[list[tuple[float, float]]]:
    return [
        [base.course_xy(point, projection_origin) for point in geometry]
        for geometry in feature["geometries"]
    ]


def green_for_route_endpoint(
    features: list[dict[str, Any]],
    route: list[tuple[float, float]],
    projection_origin: tuple[float, float],
) -> tuple[dict[str, Any] | None, float]:
    endpoint_xy = base.course_xy(route[-1], projection_origin)
    best: tuple[float, dict[str, Any]] | None = None
    for feature in features:
        if feature["role"] != "surface" or feature["kind"] != "green":
            continue
        distance = base.feature_distance_to_route(
            feature_course_xy(feature, projection_origin),
            [endpoint_xy],
        )
        if best is None or distance < best[0]:
            best = (distance, feature)
    if best is None:
        return None, float("inf")
    return best[1], best[0]


def feature_downrange_extent(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> tuple[float, float]:
    downranges = [
        base.to_hole_local(point, origin, forward, right)[1]
        for geometry in feature["geometries"]
        for point in geometry
    ]
    if not downranges:
        return float("inf"), float("-inf")
    return min(downranges), max(downranges)


def build_hole(
    hole_number: int,
    hole_config: dict[str, Any],
    course_config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    route_candidates: dict[int, list[tuple[float, dict[str, Any]]]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    route_record = hole_routes[hole_number]
    route = route_record["geometry"]
    route_yards = sum(base.haversine_yards(a, b) for a, b in zip(route, route[1:]))
    par = int(hole_config.get("par") or route_record.get("par") or 4)
    target_yards = float(hole_config.get("targetYards") or route_yards)
    origin, forward, right, heading = route_basis(route)
    projection_origin = base.course_projection_origin(hole_routes, features)

    start_radius = float((course_config.get("selection") or {}).get("teeStartRadiusYards", 220.0))
    route_distance_limit = float((course_config.get("selection") or {}).get("contextRouteDistanceYards", 110.0))
    behind_tolerance = float((course_config.get("selection") or {}).get("behindTeeToleranceYards", 35.0))
    past_green_tolerance = float((course_config.get("selection") or {}).get("pastGreenToleranceYards", 50.0))

    target_green, green_endpoint_gap = green_for_route_endpoint(
        features,
        route,
        projection_origin,
    )
    if target_green is None:
        raise ValueError(f"Hole {hole_number}: no mapped green available")

    tee_candidates = tee_diagnostics(features, route, projection_origin, start_radius)
    nearest_tee_gap = tee_candidates[0]["startPolygonGapYards"] if tee_candidates else float("inf")

    selected: dict[tuple[str, str, int], dict[str, Any]] = {}
    route_xy = [base.course_xy(point, projection_origin) for point in route]
    green_max_downrange = feature_downrange_extent(target_green, origin, forward, right)[1]

    for distance, feature in route_candidates.get(hole_number, []):
        min_downrange, max_downrange = feature_downrange_extent(feature, origin, forward, right)
        if max_downrange < -behind_tolerance:
            continue
        if min_downrange > green_max_downrange + past_green_tolerance:
            continue
        if distance > route_distance_limit:
            continue
        key = (feature["role"], feature["kind"], int(feature["osm_id"] or 0))
        selected[key] = feature

    for feature in (target_green,):
        key = (feature["role"], feature["kind"], int(feature["osm_id"] or 0))
        selected[key] = feature

    surfaces: dict[str, list[list[list[float]]]] = {
        "green": [],
        "fairway": [],
        "rough": [],
        "bunker": [],
        "water": [],
        "tee": [],
    }
    context: dict[str, list[list[list[float]]]] = {
        "woods": [],
        "scrub": [],
        "grass-context": [],
    }

    source_ids: set[str] = set()
    for feature in selected.values():
        source_ids.add(f"{feature['osm_type']}/{feature['osm_id']}")
        serialized = base.serialize_polygons(feature, origin, forward, right)
        if feature["role"] == "surface":
            surfaces[feature["kind"]].extend(serialized)
        else:
            context[feature["kind"]].extend(serialized)

    all_polygons = [polygon for values in surfaces.values() for polygon in values]
    all_polygons.extend(polygon for values in context.values() for polygon in values)
    flat_points = [tuple(point) for polygon in all_polygons for point in polygon]
    route_local = [base.to_hole_local(point, origin, forward, right) for point in route]
    flat_points.extend(route_local)
    if not flat_points:
        raise ValueError(f"Hole {hole_number}: no geometry after selection")

    min_x = min(point[0] for point in flat_points)
    max_x = max(point[0] for point in flat_points)
    min_y = min(point[1] for point in flat_points)
    max_y = max(point[1] for point in flat_points)
    pad = 25.0
    view_bounds = {
        "minX": round(min_x - pad, 1),
        "maxX": round(max_x + pad, 1),
        "minY": round(min_y - pad, 1),
        "maxY": round(max_y + pad, 1),
    }

    route_residual = route_yards - target_yards
    straight_to_green = base.haversine_yards(route[0], target_green["centroid"])
    warnings: list[str] = []
    if abs(route_residual) > 55:
        warnings.append(
            f"OSM hole route length differs from configured reference by {route_residual:+.0f} yd"
        )
    if green_endpoint_gap > 55:
        warnings.append(f"OSM route endpoint is {green_endpoint_gap:.0f} yd from selected green")
    if nearest_tee_gap > 80:
        warnings.append(
            "No mapped tee surface is close to the OSM hole start; route start remains the canonical anchor"
        )

    surface_counts = {kind: len(polygons) for kind, polygons in surfaces.items()}
    context_counts = {kind: len(polygons) for kind, polygons in context.items()}

    model = {
        "courseId": course_config["courseId"],
        "hole": hole_number,
        "par": par,
        "headingDegreesTrue": round(heading, 3),
        "referenceYards": target_yards,
        "coordinateFrame": {
            "origin": "osm-hole-route-start",
            "xAxis": "yards-right-of-osm-hole-route-heading",
            "yAxis": "yards-downrange-from-osm-hole-route-start",
        },
        "viewBounds": view_bounds,
        "terrain": {
            "available": False,
            "source": None,
            "reason": "No terrain source configured for this course package.",
        },
        "surfaces": surfaces,
        "context": context,
        "sourceElementIds": sorted(source_ids),
    }

    requires_fairway = par != 3
    ready = (
        surface_counts["green"] > 0
        and (not requires_fairway or surface_counts["fairway"] > 0)
    )

    diagnostics = {
        "hole": hole_number,
        "par": par,
        "referenceYards": target_yards,
        "anchorMethod": "osm-hole-route-start",
        "routeLengthYards": round(route_yards, 1),
        "routeLengthResidualYards": round(route_residual, 1),
        "straightTeeToGreenYards": round(straight_to_green, 1),
        "targetGreenOsmId": target_green.get("osm_id"),
        "greenEndpointGapYards": round(green_endpoint_gap, 1),
        "headingDegreesTrue": round(heading, 2),
        "nearestMappedTeeSurfaceYards": None if not math.isfinite(nearest_tee_gap) else round(nearest_tee_gap, 1),
        "nearbyTeeCandidates": [
            {
                "osmId": candidate["osmId"],
                "startPolygonGapYards": round(candidate["startPolygonGapYards"], 1),
                "startCentroidGapYards": round(candidate["startCentroidGapYards"], 1),
            }
            for candidate in tee_candidates[:6]
        ],
        "surfacePolygons": surface_counts,
        "contextPolygons": context_counts,
        "viewBounds": view_bounds,
        "fairwayRequired": requires_fairway,
        "ready": ready,
        "warnings": warnings,
    }
    return model, diagnostics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
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

    features, hole_routes = base.normalize_osm(payload)
    normalization_diagnostics = list(getattr(base, "NORMALIZATION_DIAGNOSTICS", []) or [])
    missing_routes = sorted(set(hole_configs) - set(hole_routes))
    if missing_routes:
        raise SystemExit(f"Missing OSM golf=hole routes: {missing_routes}")

    projection_origin = base.course_projection_origin(hole_routes, features)
    route_candidates = base.assign_nearest_holes(features, hole_routes, projection_origin)

    holes: dict[str, Any] = {}
    diagnostics: list[dict[str, Any]] = []
    for hole_number in range(1, 19):
        model, diagnostic = build_hole(
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
    source_counts = Counter(f"{feature['role']}:{feature['kind']}" for feature in features)
    source_context_counts = raw_context_source_counts(payload)
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
            "note": "Static geometry is generated ahead of play; no live OSM query is required during a round.",
        },
        "teeReference": config.get("teeReference"),
        "holes": holes,
    }

    context_source_status = "available" if source_context_counts else "unavailable-in-osm-snapshot"
    manifest = {
        "schemaVersion": "looper-course-package-validation-v1",
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "osmCourseWayId": config["osmCourseWayId"],
        "sourceBaseTimestamp": osm3s.get("timestamp_osm_base"),
        "generatedAt": generated_at,
        "compiler": "build_osm_course_package_v2",
        "osmHoleRoutes": len(hole_routes),
        "normalizedFeatureCounts": dict(sorted(source_counts.items())),
        "normalizationWarningCount": len(normalization_diagnostics),
        "normalizationWarnings": normalization_diagnostics,
        "contextSourceStatus": context_source_status,
        "contextSourceTagCounts": dict(sorted(source_context_counts.items())),
        "contextSourceNote": (
            "No standalone OSM wood/scrub/forest/meadow/grass context features were present in the preserved snapshot; "
            "landuse=grass objects tagged as golf surfaces are intentionally not duplicated as context."
            if not source_context_counts
            else "Standalone OSM context features were present and eligible for corridor filtering."
        ),
        "readyHoleCount": len(ready_holes),
        "readyHoles": ready_holes,
        "allHolesStaticGeometryReady": len(ready_holes) == 18,
        "registrationStatus": "approximate",
        "registrationNote": (
            "Static OSM geometry is packaged in an OSM-hole-start frame. GSPro registration remains unverified until live evidence."
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
        "normalization_warnings": len(normalization_diagnostics),
        "context_source_status": context_source_status,
        "ready_holes": ready_holes,
        "all_ready": len(ready_holes) == 18,
        "warnings": sum(len(item["warnings"]) for item in diagnostics),
        "output": str(args.output),
        "manifest": str(args.manifest),
    }, indent=2, sort_keys=True))

    if len(ready_holes) != 18:
        raise SystemExit(f"Static geometry incomplete; ready holes: {ready_holes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
