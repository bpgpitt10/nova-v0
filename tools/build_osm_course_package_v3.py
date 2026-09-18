#!/usr/bin/env python3
"""Topology-safe Looper static course package compiler.

V3 keeps the runtime CoursePackage contract intentionally simple: surfaces are
still arrays of ordinary polygons. OSM multipolygon relations may contain inner
rings, though, and flattening those rings makes grass islands look like bunker,
fairway holes look like fairway, etc.

This compiler preserves relation topology during normalization and, only at
serialization time, decomposes polygons-with-holes into ordinary hole-free
polygons using Shapely. The browser/runtime therefore needs no special negative
polygon semantics and every existing geometry consumer sees the correct shape.

Selection is deliberately component-granular. Each outer ring plus its owned
inner rings becomes one independently selectable feature component while the
original OSM element identity is preserved. Selected components are then
clipped to the configured corridor around the actual OSM hole route before
serialization. This handles both multipart relations and single connected
relations that legitimately span multiple holes without leaking distant course
geometry into the current hole package.

A malformed standalone surface/context multipolygon is allowed to be skipped
only for the specific orphan-inner-ring defect seen in real OSM extracts. Golf
hole routes remain strict, arbitrary topology errors remain fatal, and V2's
readiness checks are augmented with a geometry-plausibility gate. Every
tolerated skip or plausibility failure is recorded in the validation manifest.
"""

from __future__ import annotations

import math
from typing import Any

import build_osm_course_package as base
import build_osm_course_package_v2 as v2

try:
    from shapely import make_valid
    from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Polygon
    from shapely.ops import triangulate
except ImportError as exc:
    raise SystemExit(
        "build_osm_course_package_v3.py requires Shapely. "
        "Install tools/requirements-course-importer.txt before building course packages."
    ) from exc

MIN_AREA_YDS2 = 1e-6
TOLERATED_FEATURE_TOPOLOGY_ERROR = "inner ring not contained by an outer ring"
DEFAULT_MAX_LATERAL_OVERHANG_YARDS = 350.0
DEFAULT_MAX_TOTAL_LATERAL_OVERHANG_YARDS = 600.0
DEFAULT_MAX_LONGITUDINAL_OVERHANG_YARDS = 300.0
DEFAULT_MAX_TOTAL_LONGITUDINAL_OVERHANG_YARDS = 500.0


def polygon_parts(geometry: Any) -> list[Polygon]:
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    if isinstance(geometry, GeometryCollection):
        result: list[Polygon] = []
        for child in geometry.geoms:
            result.extend(polygon_parts(child))
        return result
    return []


def element_polygon_parts(element: dict[str, Any]) -> list[dict[str, Any]]:
    direct = base.as_latlon(element.get("geometry") or [])
    if direct:
        return [{"outer": direct, "holes": []}]

    members = element.get("members") or []
    outer_chains: list[list[tuple[float, float]]] = []
    inner_chains: list[list[tuple[float, float]]] = []
    fallback_chains: list[list[tuple[float, float]]] = []
    for member in members:
        geometry = base.as_latlon(member.get("geometry") or [])
        if not geometry:
            continue
        fallback_chains.append(geometry)
        role = member.get("role")
        if role in ("outer", ""):
            outer_chains.append(geometry)
        elif role == "inner":
            inner_chains.append(geometry)

    outers = base.join_chains(outer_chains or fallback_chains)
    parts = [{"outer": outer, "holes": []} for outer in outers if len(outer) >= 3]
    for inner in base.join_chains(inner_chains):
        if len(inner) < 3:
            continue
        owner = next((part for part in parts if base.point_in_polygon(inner[0], part["outer"])), None)
        if owner is None:
            raise ValueError(
                f"OSM relation {element.get('id')} has an inner ring not contained by an outer ring"
            )
        owner["holes"].append(inner)
    return parts


def normalize_osm_with_topology(
    payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    features: list[dict[str, Any]] = []
    hole_routes: dict[int, dict[str, Any]] = {}
    diagnostics: list[dict[str, Any]] = []
    # V2 reads this after normalization and persists it into validation proof.
    base.NORMALIZATION_DIAGNOSTICS = diagnostics

    for element in payload.get("elements", []):
        tags = element.get("tags") or {}

        # Hole routes are decision-critical and stay strict. A malformed hole
        # relation must fail the course rather than be silently omitted.
        if tags.get("golf") == "hole" and str(tags.get("ref", "")).isdigit():
            parts = element_polygon_parts(element)
            geometries = [part["outer"] for part in parts]
            points = [point for geometry in geometries for point in geometry]
            if not points:
                continue
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

        # Ignore unrelated OSM objects before attempting polygon assembly. This
        # prevents a malformed building/administrative/etc multipolygon inside
        # the bounded snapshot from poisoning the whole golf package.
        classified = base.classify_element(tags)
        if not classified:
            continue
        role, kind = classified

        try:
            parts = element_polygon_parts(element)
        except ValueError as exc:
            message = str(exc)
            if TOLERATED_FEATURE_TOPOLOGY_ERROR not in message:
                raise
            diagnostics.append(
                {
                    "severity": "warning",
                    "action": "skipped-feature",
                    "reason": "orphan-multipolygon-inner-ring",
                    "osmType": element.get("type"),
                    "osmId": element.get("id"),
                    "role": role,
                    "kind": kind,
                    "sourceFeature": base.source_feature(tags, kind),
                    "name": tags.get("name"),
                    "error": message,
                }
            )
            continue

        # Keep each polygon component independently selectable. The original OSM
        # type/id remains untouched for provenance; component_index only
        # distinguishes separate outers from the same relation during selection.
        for component_index, part in enumerate(parts):
            outer = part["outer"]
            if len(outer) < 3:
                continue
            features.append(
                {
                    "role": role,
                    "kind": kind,
                    "osm_type": element.get("type"),
                    "osm_id": element.get("id"),
                    "component_index": component_index,
                    "source_feature": base.source_feature(tags, kind),
                    "geometries": [outer],
                    "holes_by_geometry": [part["holes"]],
                    "centroid": base.centroid(outer),
                }
            )

    return features, hole_routes


def local_ring(
    ring: list[tuple[float, float]],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[tuple[float, float]]:
    return [base.to_hole_local(point, origin, forward, right) for point in ring]


def decompose_hole_free(polygon: Polygon, depth: int = 0) -> list[Polygon]:
    if polygon.is_empty or polygon.area <= MIN_AREA_YDS2:
        return []
    if not polygon.interiors:
        return [polygon]
    if depth >= 4:
        raise ValueError("Could not decompose OSM polygon inner rings into simple polygons")

    pieces: list[Polygon] = []
    for triangle in triangulate(polygon):
        clipped = triangle.intersection(polygon)
        for candidate in polygon_parts(clipped):
            if candidate.area <= MIN_AREA_YDS2:
                continue
            pieces.extend(decompose_hole_free(candidate, depth + 1))
    return pieces


def serialize_shape_hole_free(shape: Any) -> list[list[list[float]]]:
    source_parts = polygon_parts(make_valid(shape))
    source_area = sum(part.area for part in source_parts)
    serialized_area = 0.0
    simple_parts: list[Polygon] = []
    for valid_part in source_parts:
        simple_parts.extend(decompose_hole_free(valid_part))

    polygons: list[list[list[float]]] = []
    for part in simple_parts:
        coords = list(part.exterior.coords)
        if len(coords) < 4:
            continue
        serialized_area += part.area
        polygons.append([[round(float(x), 3), round(float(y), 3)] for x, y in coords])

    tolerance = max(0.05, source_area * 1e-7)
    if abs(serialized_area - source_area) > tolerance:
        raise ValueError(
            f"Topology decomposition changed area: source={source_area:.3f}, pieces={serialized_area:.3f}"
        )
    return polygons


def serialize_polygons_topology_safe(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    holes_by_geometry = feature.get("holes_by_geometry") or []
    clip_geometry = feature.get("_clip_geometry")

    for index, geometry in enumerate(feature["geometries"]):
        outer = local_ring(geometry, origin, forward, right)
        source_holes = holes_by_geometry[index] if index < len(holes_by_geometry) else []
        holes = [local_ring(hole, origin, forward, right) for hole in source_holes if len(hole) >= 3]
        if len(outer) < 3:
            continue

        shape = make_valid(Polygon(outer, holes))
        if clip_geometry is not None:
            shape = make_valid(shape.intersection(clip_geometry))
        if shape.is_empty:
            continue

        try:
            polygons.extend(serialize_shape_hole_free(shape))
        except ValueError as exc:
            raise ValueError(
                f"OSM {feature.get('osm_type')} {feature.get('osm_id')} component "
                f"{feature.get('component_index', 0)}: {exc}"
            ) from exc

    return polygons


def selection_key(feature: dict[str, Any]) -> tuple[str, str, int, int]:
    return (
        feature["role"],
        feature["kind"],
        int(feature["osm_id"] or 0),
        int(feature.get("component_index") or 0),
    )


def geometry_plausibility(
    geometry_points: list[tuple[float, float]],
    route_local: list[tuple[float, float]],
    course_config: dict[str, Any],
) -> dict[str, Any]:
    if not geometry_points or not route_local:
        return {
            "passed": False,
            "reason": "missing-geometry-or-route",
        }

    selection = course_config.get("selection") or {}
    max_lateral = float(
        selection.get("maxGeometryLateralOverhangYards", DEFAULT_MAX_LATERAL_OVERHANG_YARDS)
    )
    max_total_lateral = float(
        selection.get(
            "maxGeometryTotalLateralOverhangYards",
            DEFAULT_MAX_TOTAL_LATERAL_OVERHANG_YARDS,
        )
    )
    max_longitudinal = float(
        selection.get(
            "maxGeometryLongitudinalOverhangYards",
            DEFAULT_MAX_LONGITUDINAL_OVERHANG_YARDS,
        )
    )
    max_total_longitudinal = float(
        selection.get(
            "maxGeometryTotalLongitudinalOverhangYards",
            DEFAULT_MAX_TOTAL_LONGITUDINAL_OVERHANG_YARDS,
        )
    )

    route_min_x = min(point[0] for point in route_local)
    route_max_x = max(point[0] for point in route_local)
    route_min_y = min(point[1] for point in route_local)
    route_max_y = max(point[1] for point in route_local)
    geometry_min_x = min(point[0] for point in geometry_points)
    geometry_max_x = max(point[0] for point in geometry_points)
    geometry_min_y = min(point[1] for point in geometry_points)
    geometry_max_y = max(point[1] for point in geometry_points)

    left = max(0.0, route_min_x - geometry_min_x)
    right = max(0.0, geometry_max_x - route_max_x)
    behind = max(0.0, route_min_y - geometry_min_y)
    past = max(0.0, geometry_max_y - route_max_y)
    total_lateral = left + right
    total_longitudinal = behind + past

    passed = (
        left <= max_lateral
        and right <= max_lateral
        and total_lateral <= max_total_lateral
        and behind <= max_longitudinal
        and past <= max_longitudinal
        and total_longitudinal <= max_total_longitudinal
    )

    return {
        "passed": passed,
        "routeBounds": {
            "minX": round(route_min_x, 1),
            "maxX": round(route_max_x, 1),
            "minY": round(route_min_y, 1),
            "maxY": round(route_max_y, 1),
        },
        "geometryBounds": {
            "minX": round(geometry_min_x, 1),
            "maxX": round(geometry_max_x, 1),
            "minY": round(geometry_min_y, 1),
            "maxY": round(geometry_max_y, 1),
        },
        "overhangYards": {
            "left": round(left, 1),
            "right": round(right, 1),
            "behind": round(behind, 1),
            "past": round(past, 1),
            "totalLateral": round(total_lateral, 1),
            "totalLongitudinal": round(total_longitudinal, 1),
        },
        "limitsYards": {
            "perSideLateral": max_lateral,
            "totalLateral": max_total_lateral,
            "perSideLongitudinal": max_longitudinal,
            "totalLongitudinal": max_total_longitudinal,
        },
    }


def build_hole_component_safe(
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
    origin, forward, right, heading = v2.route_basis(route)
    projection_origin = base.course_projection_origin(hole_routes, features)

    start_radius = float((course_config.get("selection") or {}).get("teeStartRadiusYards", 220.0))
    route_distance_limit = float((course_config.get("selection") or {}).get("contextRouteDistanceYards", 110.0))
    behind_tolerance = float((course_config.get("selection") or {}).get("behindTeeToleranceYards", 35.0))
    past_green_tolerance = float((course_config.get("selection") or {}).get("pastGreenToleranceYards", 50.0))

    target_green, green_endpoint_gap = v2.green_for_route_endpoint(
        features,
        route,
        projection_origin,
    )
    if target_green is None:
        raise ValueError(f"Hole {hole_number}: no mapped green available")

    tee_candidates = v2.tee_diagnostics(features, route, projection_origin, start_radius)
    nearest_tee_gap = tee_candidates[0]["startPolygonGapYards"] if tee_candidates else float("inf")

    selected: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    green_max_downrange = v2.feature_downrange_extent(target_green, origin, forward, right)[1]

    for distance, feature in route_candidates.get(hole_number, []):
        min_downrange, max_downrange = v2.feature_downrange_extent(feature, origin, forward, right)
        if max_downrange < -behind_tolerance:
            continue
        if min_downrange > green_max_downrange + past_green_tolerance:
            continue
        if distance > route_distance_limit:
            continue
        selected[selection_key(feature)] = feature

    selected[selection_key(target_green)] = target_green

    route_local = [base.to_hole_local(point, origin, forward, right) for point in route]
    if len(route_local) < 2:
        raise ValueError(f"Hole {hole_number}: route has fewer than two local points")
    corridor = LineString(route_local).buffer(route_distance_limit)

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
        clipped_feature = dict(feature)
        clipped_feature["_clip_geometry"] = corridor
        serialized = base.serialize_polygons(clipped_feature, origin, forward, right)
        if feature["role"] == "surface":
            surfaces[feature["kind"]].extend(serialized)
        else:
            context[feature["kind"]].extend(serialized)

    all_polygons = [polygon for values in surfaces.values() for polygon in values]
    all_polygons.extend(polygon for values in context.values() for polygon in values)
    geometry_points = [tuple(point) for polygon in all_polygons for point in polygon]
    flat_points = geometry_points + route_local
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

    plausibility = geometry_plausibility(geometry_points, route_local, course_config)
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
    if not plausibility.get("passed"):
        overhang = plausibility.get("overhangYards") or {}
        warnings.append(
            "Selected geometry exceeds the hole plausibility envelope "
            f"(L {overhang.get('left')} / R {overhang.get('right')} / "
            f"behind {overhang.get('behind')} / past {overhang.get('past')} yd)"
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
        and plausibility.get("passed") is True
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
        "selectionCorridorYards": route_distance_limit,
        "geometryPlausibility": plausibility,
        "fairwayRequired": requires_fairway,
        "ready": ready,
        "warnings": warnings,
    }
    return model, diagnostics


def install_topology_safe_primitives() -> None:
    base.normalize_osm = normalize_osm_with_topology
    base.serialize_polygons = serialize_polygons_topology_safe
    v2.build_hole = build_hole_component_safe


if __name__ == "__main__":
    install_topology_safe_primitives()
    raise SystemExit(v2.main())
