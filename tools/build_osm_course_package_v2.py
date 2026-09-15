#!/usr/bin/env python3
"""Second-course validation compiler for Looper static course packages.

This deliberately reuses the OSM parsing/geometry primitives from the first
compiler while replacing the Greywolf-shaped assumptions Tobacco Road exposed:

- the OSM golf=hole start is the nominal static tee anchor;
- a mapped tee polygon is evidence/context, not required to define that anchor;
- physical fairways/hazards may be relevant to more than one hole;
- par-3 holes do not require a fairway;
- golf=rough remains regular rough and no deep rough is invented.

Once the second-course validation is closed, these rules can replace the first
compiler implementation rather than preserving two production pipelines.
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


def feature_distance_to_point_yards(
    feature: dict[str, Any],
    point_latlon: tuple[float, float],
) -> float:
    point_xy = (0.0, 0.0)
    best = float("inf")
    for geometry in feature["geometries"]:
        polygon_xy = [base.local_east_north_yards(point, point_latlon) for point in geometry]
        if len(polygon_xy) < 3:
            continue
        if base.point_in_polygon(point_xy, polygon_xy):
            return 0.0
        for a, b in zip(polygon_xy, polygon_xy[1:]):
            best = min(best, base.point_segment_distance(point_xy, a, b))
    return best


def route_length_yards(route: dict[str, Any]) -> float:
    points = route["geometry"]
    return sum(base.haversine_yards(a, b) for a, b in zip(points, points[1:]))


def basis_for_route_start(
    route: dict[str, Any],
    green: dict[str, Any],
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float], float]:
    origin = route["geometry"][0]
    gx, gy = base.local_east_north_yards(green["centroid"], origin)
    length = math.hypot(gx, gy)
    if length <= 1e-9:
        raise ValueError("Nominal tee and green anchors collapse to the same point")
    forward = (gx / length, gy / length)
    right = (forward[1], -forward[0])
    heading = (math.degrees(math.atan2(gx, gy)) + 360.0) % 360.0
    return origin, forward, right, heading


def nearby_features(
    route_candidates: list[tuple[float, dict[str, Any]]],
    *,
    role: str,
    kind: str,
    max_route_distance_yards: float,
) -> list[dict[str, Any]]:
    return [
        feature
        for distance, feature in route_candidates
        if feature["role"] == role
        and feature["kind"] == kind
        and distance <= max_route_distance_yards
    ]


def raw_context_source_counts(payload: dict[str, Any]) -> Counter[str]:
    """Count context tags that are not already explicit golf surfaces."""
    counts: Counter[str] = Counter()
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf"):
            continue
        natural = tags.get("natural")
        landuse = tags.get("landuse")
        if natural in {"wood", "scrub"}:
            counts[f"natural={natural}"] += 1
        if landuse in {"forest", "grass", "meadow"}:
            counts[f"landuse={landuse}"] += 1
    return counts


def build_hole(
    hole_number: int,
    hole_config: dict[str, Any],
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    route_candidates: dict[int, list[tuple[float, dict[str, Any]]]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    route = hole_routes[hole_number]
    par = int(hole_config.get("par") or route.get("par") or 0) or None
    target_yards = float(hole_config["targetYards"])
    selection = config.get("selection") or {}
    context_distance = float(selection.get("contextRouteDistanceYards", 110))
    fairway_distance = float(selection.get("fairwayRouteDistanceYards", 45))
    hazard_distance = float(selection.get("hazardRouteDistanceYards", context_distance))
    tee_surface_distance = float(selection.get("teeSurfaceStartDistanceYards", 60))
    behind_tolerance = float(selection.get("behindTeeToleranceYards", 35))
    past_tolerance = float(selection.get("pastGreenToleranceYards", 50))

    greens = [feature for feature in features if feature["kind"] == "green"]
    tees = [feature for feature in features if feature["kind"] == "tee"]
    target_green, green_endpoint_gap = base.select_target_green(route, greens)
    origin, forward, right, heading = basis_for_route_start(route, target_green)
    pin = base.to_hole_local(target_green["centroid"], origin, forward, right)
    straight_to_green = math.hypot(pin[0], pin[1])
    route_yards = route_length_yards(route)

    # The hole-line start is the nominal static origin. Tee polygons are kept
    # only when they are genuinely close to that start. This prevents published
    # yardage from selecting a neighboring tee complex on tightly packed courses.
    tee_candidates = sorted(
        (
            {
                "feature": tee,
                "osmId": tee.get("osm_id"),
                "startPolygonGapYards": feature_distance_to_point_yards(tee, origin),
                "startCentroidGapYards": base.haversine_yards(tee["centroid"], origin),
            }
            for tee in tees
        ),
        key=lambda candidate: (
            candidate["startPolygonGapYards"],
            candidate["startCentroidGapYards"],
        ),
    )
    tee_features = [
        candidate["feature"]
        for candidate in tee_candidates
        if candidate["startPolygonGapYards"] <= tee_surface_distance
    ]

    # Physical surfaces do not belong exclusively to one hole. Tobacco Road
    # proves this: Hole 16's route intersects a fairway polygon whose nearest
    # route is Hole 15. If the polygon is in the playable corridor, it matters
    # to strategy regardless of which hole is mathematically closest.
    fairway_limit = 8.0 if par == 3 else fairway_distance
    surface_features: dict[str, list[dict[str, Any]]] = {
        "tee": tee_features,
        "green": [target_green],
        "fairway": nearby_features(
            route_candidates[hole_number],
            role="surface",
            kind="fairway",
            max_route_distance_yards=fairway_limit,
        ),
        "rough": nearby_features(
            route_candidates[hole_number],
            role="surface",
            kind="rough",
            max_route_distance_yards=context_distance,
        ),
        "bunker": nearby_features(
            route_candidates[hole_number],
            role="surface",
            kind="bunker",
            max_route_distance_yards=hazard_distance,
        ),
        "water": nearby_features(
            route_candidates[hole_number],
            role="surface",
            kind="water",
            max_route_distance_yards=hazard_distance,
        ),
    }

    surfaces: list[dict[str, Any]] = []
    for kind in ("rough", "water", "fairway", "green", "bunker", "tee"):
        layer = base.grouped_layer(
            hole_number,
            "surface",
            kind,
            surface_features[kind],
            origin,
            forward,
            right,
            straight_to_green,
            behind_tolerance,
            past_tolerance,
        )
        if layer:
            surfaces.append(layer)

    context_layers: list[dict[str, Any]] = []
    for kind in ("grass-context", "woods", "scrub"):
        layer = base.grouped_layer(
            hole_number,
            "context",
            kind,
            nearby_features(
                route_candidates[hole_number],
                role="context",
                kind=kind,
                max_route_distance_yards=context_distance,
            ),
            origin,
            forward,
            right,
            straight_to_green,
            behind_tolerance,
            past_tolerance,
        )
        if layer:
            context_layers.append(layer)

    route_local = [base.to_hole_local(point, origin, forward, right) for point in route["geometry"]]
    bounds_points = route_local[:]
    for layer in surfaces:
        for polygon in layer["polygons"]:
            bounds_points.extend((point[0], point[1]) for point in polygon)
    if not bounds_points:
        raise ValueError(f"Hole {hole_number} produced no geometry bounds")

    model = {
        "holeNumber": hole_number,
        "par": par,
        "statedYardageYds": target_yards,
        "coordinateSystem": {
            "origin": "osm-hole-route-start",
            "units": "yards",
            "xAxis": "right",
            "yAxis": "forward",
        },
        "bounds": {
            "minX": round(min(point[0] for point in bounds_points), 1),
            "maxX": round(max(point[0] for point in bounds_points), 1),
            "minY": round(min(point[1] for point in bounds_points), 1),
            "maxY": round(max(point[1] for point in bounds_points), 1),
        },
        "markers": {
            "tee": [0.0, 0.0],
            "pin": [round(pin[0], 3), round(pin[1], 3)],
        },
        "surfaces": surfaces,
        "contextLayers": context_layers,
        "registration": {
            "status": "approximate",
            "method": "hole-local",
            "sourceCoordinateSystem": "OSM golf=hole start -> target green local yards",
            "note": (
                "The OSM hole-line start is the nominal static tee anchor. "
                "GSPro registration remains intentionally unverified until live round evidence is available."
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

    warnings: list[str] = []
    nearest_tee_gap = tee_candidates[0]["startPolygonGapYards"] if tee_candidates else float("inf")
    if not tee_features:
        warnings.append(
            f"No mapped tee polygon within {tee_surface_distance:.0f} yd of the OSM hole start; nominal route start retained."
        )
    if green_endpoint_gap > 30:
        warnings.append(f"Target green centroid is {green_endpoint_gap:.1f} yd from the OSM hole endpoint.")
    route_residual = route_yards - target_yards
    if abs(route_residual) > 80:
        warnings.append(
            f"OSM hole-line length differs from provisional reference yardage by {route_residual:+.1f} yd."
        )

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
