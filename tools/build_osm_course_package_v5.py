#!/usr/bin/env python3
"""Canonical topology-safe route-course compiler.

V5 treats the OSM golf=hole route as authoritative hole ownership and treats
mapped golf=tee polygons as optional supporting evidence.

Anchor contract:
- If a mapped tee is clearly owned by this hole's route, runtime [0, 0] is that
  mapped tee centroid.
- If no mapped tee can be confidently assigned to this hole, runtime [0, 0]
  remains the golf=hole route start and is explicitly labeled a virtual tee.

Playable ownership contract:
- Fairway and golf=rough features must be owned by the current hole route.
- Ownership is determined against every mapped golf=hole route by polygon-to-
  route distance, with a small tie tolerance for genuinely shared polygons.
- Bunkers and water remain physical hazards when they intersect the tactical
  corridor, even if another hole route is marginally closer.

This prevents nearby tees and neighboring-hole playable surfaces from being
stolen simply because they intersect a broad tactical corridor. It also
preserves the cached route-axis orientation so existing LiDAR can be translated
without resampling.
"""

from __future__ import annotations

import math
from typing import Any

from shapely import affinity
from shapely.geometry import LineString

import build_osm_course_package as base
import build_osm_course_package_v4 as v4


DEFAULT_TEE_SEARCH_RADIUS_YARDS = 220.0
MAX_OWNED_TEE_ROUTE_GAP_YARDS = 35.0
ROUTE_DIRECTION_GREEN_MARGIN_YARDS = 15.0
ROUTE_OWNERSHIP_TIE_YARDS = 3.0
ROUTE_OWNED_SURFACE_KINDS = ("fairway", "rough")


def nearest_green_to_point(
    greens: list[dict[str, Any]],
    point: tuple[float, float],
) -> tuple[dict[str, Any], float]:
    ranked = sorted(
        ((base.haversine_yards(green["centroid"], point), green) for green in greens),
        key=lambda item: item[0],
    )
    if not ranked:
        raise ValueError("No mapped greens")
    return ranked[0][1], ranked[0][0]


def orient_route_to_green(
    route: dict[str, Any],
    greens: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], float, str, float, float]:
    """Reverse a route only when mapped-green evidence clearly requires it."""
    start = route["geometry"][0]
    end = route["geometry"][-1]
    start_green, start_gap = nearest_green_to_point(greens, start)
    end_green, end_gap = nearest_green_to_point(greens, end)

    if start_gap + ROUTE_DIRECTION_GREEN_MARGIN_YARDS < end_gap:
        oriented = dict(route)
        oriented["geometry"] = list(reversed(route["geometry"]))
        return oriented, start_green, start_gap, "reversed-to-green", start_gap, end_gap

    return route, end_green, end_gap, "as-mapped", start_gap, end_gap


def course_route_lines(
    hole_routes: dict[int, dict[str, Any]],
) -> tuple[tuple[float, float], dict[int, list[tuple[float, float]]]]:
    origin = base.centroid([
        point
        for route in hole_routes.values()
        for point in route["geometry"]
    ])
    return origin, {
        hole: [base.course_xy(point, origin) for point in route["geometry"]]
        for hole, route in hole_routes.items()
    }


def feature_route_gap(
    feature: dict[str, Any],
    route_line: list[tuple[float, float]],
    course_origin: tuple[float, float],
) -> float:
    geometries_xy = [
        [base.course_xy(point, course_origin) for point in geometry]
        for geometry in feature["geometries"]
    ]
    return base.feature_distance_to_route(geometries_xy, route_line)


def route_ownership_for_feature(
    feature: dict[str, Any],
    hole_number: int,
    route_lines: dict[int, list[tuple[float, float]]],
    course_origin: tuple[float, float],
    tie_yards: float = ROUTE_OWNERSHIP_TIE_YARDS,
) -> dict[str, Any]:
    route_gaps = {
        route_hole: feature_route_gap(feature, line, course_origin)
        for route_hole, line in route_lines.items()
    }
    nearest_gap = min(route_gaps.values(), default=float("inf"))
    nearest_holes = sorted(
        route_hole
        for route_hole, gap in route_gaps.items()
        if gap <= nearest_gap + tie_yards
    )
    current_gap = route_gaps.get(hole_number, float("inf"))
    return {
        "ownedByCurrentHole": current_gap <= nearest_gap + tie_yards,
        "currentRouteGapYards": current_gap,
        "nearestRouteGapYards": nearest_gap,
        "nearestRouteHoles": nearest_holes,
    }


def route_owned_features(
    features: list[dict[str, Any]],
    hole_number: int,
    route_lines: dict[int, list[tuple[float, float]]],
    course_origin: tuple[float, float],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    owned: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for feature in features:
        ownership = route_ownership_for_feature(
            feature,
            hole_number,
            route_lines,
            course_origin,
        )
        if ownership["ownedByCurrentHole"]:
            owned.append(feature)
        else:
            excluded.append({
                "osmId": feature.get("osm_id"),
                "kind": feature.get("kind"),
                "currentRouteGapYards": ownership["currentRouteGapYards"],
                "nearestRouteGapYards": ownership["nearestRouteGapYards"],
                "nearestRouteHoles": ownership["nearestRouteHoles"],
            })
    return owned, excluded


def tee_route_gap(
    tee: dict[str, Any],
    route_line: list[tuple[float, float]],
    course_origin: tuple[float, float],
) -> float:
    return feature_route_gap(tee, route_line, course_origin)


def tee_anchor_for_hole(
    hole_number: int,
    route: dict[str, Any],
    tees: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    search_radius_yards: float,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Return a route-owned mapped tee or None for a virtual route-start tee."""
    course_origin, route_lines = course_route_lines(hole_routes)
    route_start = route["geometry"][0]
    candidates: list[dict[str, Any]] = []

    for tee in tees:
        start_polygon_gap = v4.feature_distance_to_point_yards(tee, route_start)
        if start_polygon_gap > search_radius_yards:
            continue

        route_gaps = {
            route_hole: tee_route_gap(tee, line, course_origin)
            for route_hole, line in route_lines.items()
        }
        nearest_route_hole = min(route_gaps, key=route_gaps.get)
        current_route_gap = route_gaps[hole_number]
        owned = (
            nearest_route_hole == hole_number
            and current_route_gap <= MAX_OWNED_TEE_ROUTE_GAP_YARDS
        )
        candidates.append({
            "feature": tee,
            "osmId": tee.get("osm_id"),
            "startPolygonGapYards": start_polygon_gap,
            "startCentroidGapYards": base.haversine_yards(tee["centroid"], route_start),
            "currentRouteGapYards": current_route_gap,
            "nearestRouteHole": nearest_route_hole,
            "nearestRouteGapYards": route_gaps[nearest_route_hole],
            "ownedByCurrentHole": owned,
        })

    owned_candidates = [item for item in candidates if item["ownedByCurrentHole"]]
    owned_candidates.sort(
        key=lambda item: (
            item["startPolygonGapYards"],
            item["currentRouteGapYards"],
            item["startCentroidGapYards"],
        )
    )
    candidates.sort(
        key=lambda item: (
            not item["ownedByCurrentHole"],
            item["startPolygonGapYards"],
            item["currentRouteGapYards"],
        )
    )
    return (owned_candidates[0]["feature"] if owned_candidates else None), candidates


def basis_for_route_start(
    route: dict[str, Any],
    green: dict[str, Any],
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float], float]:
    origin = route["geometry"][0]
    gx, gy = base.local_east_north_yards(green["centroid"], origin)
    length = math.hypot(gx, gy)
    if length <= 1e-9:
        raise ValueError("OSM route start and target green collapse to the same point")
    forward = (gx / length, gy / length)
    right = (forward[1], -forward[0])
    heading = (math.degrees(math.atan2(gx, gy)) + 360.0) % 360.0
    return origin, forward, right, heading


def shifted_point(point: tuple[float, float], offset: tuple[float, float]) -> tuple[float, float]:
    return point[0] - offset[0], point[1] - offset[1]


def feature_polygons_rebased(
    feature: dict[str, Any],
    route_origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    anchor_offset: tuple[float, float],
):
    return [
        affinity.translate(polygon, xoff=-anchor_offset[0], yoff=-anchor_offset[1])
        for polygon in v4.feature_polygons_local(feature, route_origin, forward, right)
    ]


def feature_intersections_rebased(
    features: list[dict[str, Any]],
    corridor: Any,
    route_origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    anchor_offset: tuple[float, float],
    simplify_yards: float,
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    for feature in features:
        for polygon in feature_polygons_rebased(
            feature,
            route_origin,
            forward,
            right,
            anchor_offset,
        ):
            polygons.extend(v4.serialize_shape(polygon.intersection(corridor), simplify_yards))
    return polygons


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    raw_route = hole_routes[hole_number]
    selection = config.get("selection") or {}
    tee_search_radius = float(selection.get("teeStartRadiusYards", DEFAULT_TEE_SEARCH_RADIUS_YARDS))
    context_width = float(selection.get("contextRouteDistanceYards", v4.DEFAULT_CONTEXT_CORRIDOR_YARDS))
    fairway_width = float(selection.get("fairwayCorridorYards", min(v4.DEFAULT_FAIRWAY_CORRIDOR_YARDS, context_width)))
    hazard_width = float(selection.get("hazardCorridorYards", min(v4.DEFAULT_HAZARD_CORRIDOR_YARDS, context_width)))
    simplify_yards = float(selection.get("geometrySimplifyYards", v4.DEFAULT_SIMPLIFY_YARDS))

    greens = [feature for feature in features if feature["kind"] == "green"]
    tees = [feature for feature in features if feature["kind"] == "tee"]
    route, target_green, green_endpoint_gap, route_direction, start_green_gap, end_green_gap = (
        orient_route_to_green(raw_route, greens)
    )

    route_yards = v4.route_length_yards(route)
    hole_config = (config.get("holes") or {}).get(str(hole_number)) or {}
    par = int(hole_config.get("par") or route.get("par") or 0) or None
    reference_yards = float(hole_config.get("targetYards") or route_yards)

    selected_tee, tee_candidates = tee_anchor_for_hole(
        hole_number,
        route,
        tees,
        hole_routes,
        tee_search_radius,
    )

    route_origin, forward, right, heading = basis_for_route_start(route, target_green)
    if selected_tee is None:
        anchor_method = "route-start-virtual-tee"
        coordinate_origin = "osm-hole-route-start"
        anchor_latlon = route_origin
        anchor_offset = (0.0, 0.0)
        selected_candidate = None
    else:
        anchor_method = "selected-tee-route-owned"
        coordinate_origin = "selected-tee"
        anchor_latlon = selected_tee["centroid"]
        anchor_offset = base.to_hole_local(selected_tee["centroid"], route_origin, forward, right)
        selected_candidate = next(
            candidate for candidate in tee_candidates
            if candidate.get("osmId") == selected_tee.get("osm_id")
        )

    pin_old = base.to_hole_local(target_green["centroid"], route_origin, forward, right)
    pin = shifted_point(pin_old, anchor_offset)
    route_local = [
        shifted_point(base.to_hole_local(point, route_origin, forward, right), anchor_offset)
        for point in route["geometry"]
    ]

    tactical_line = LineString([(0.0, 0.0), *route_local, pin])
    fairway_corridor = tactical_line.buffer(fairway_width, cap_style="round", join_style="round")
    hazard_corridor = tactical_line.buffer(hazard_width, cap_style="round", join_style="round")
    context_corridor = tactical_line.buffer(context_width, cap_style="round", join_style="round")

    by_kind: dict[str, list[dict[str, Any]]] = {}
    for feature in features:
        by_kind.setdefault(feature["kind"], []).append(feature)

    course_origin, route_lines = course_route_lines(hole_routes)
    owned_by_kind: dict[str, list[dict[str, Any]]] = {}
    excluded_foreign_by_kind: dict[str, list[dict[str, Any]]] = {}
    for kind in ROUTE_OWNED_SURFACE_KINDS:
        owned, excluded = route_owned_features(
            by_kind.get(kind, []),
            hole_number,
            route_lines,
            course_origin,
        )
        owned_by_kind[kind] = owned
        excluded_foreign_by_kind[kind] = excluded

    selected_tee_polygons: list[list[list[float]]] = []
    if selected_tee is not None:
        for polygon in feature_polygons_rebased(
            selected_tee, route_origin, forward, right, anchor_offset
        ):
            selected_tee_polygons.extend(v4.serialize_shape(polygon, simplify_yards))

    target_green_polygons: list[list[list[float]]] = []
    for polygon in feature_polygons_rebased(
        target_green, route_origin, forward, right, anchor_offset
    ):
        target_green_polygons.extend(v4.serialize_shape(polygon, simplify_yards))

    surfaces = {
        "tee": selected_tee_polygons,
        "fairway": feature_intersections_rebased(
            owned_by_kind.get("fairway", []), fairway_corridor,
            route_origin, forward, right, anchor_offset, simplify_yards,
        ),
        "rough": feature_intersections_rebased(
            owned_by_kind.get("rough", []), context_corridor,
            route_origin, forward, right, anchor_offset, simplify_yards,
        ),
        "green": target_green_polygons,
        "bunker": feature_intersections_rebased(
            by_kind.get("bunker", []), hazard_corridor,
            route_origin, forward, right, anchor_offset, simplify_yards,
        ),
        "water": feature_intersections_rebased(
            by_kind.get("water", []), hazard_corridor,
            route_origin, forward, right, anchor_offset, simplify_yards,
        ),
    }
    surfaces = {kind: polygons for kind, polygons in surfaces.items() if polygons}

    context = {
        kind: feature_intersections_rebased(
            by_kind.get(kind, []), context_corridor,
            route_origin, forward, right, anchor_offset, simplify_yards,
        )
        for kind in ("woods", "scrub", "grass-context")
    }
    context = {kind: polygons for kind, polygons in context.items() if polygons}

    requires_fairway = par != 3
    surface_counts = {
        kind: len(surfaces.get(kind, []))
        for kind in ("tee", "fairway", "rough", "green", "bunker", "water")
    }
    total_playable = sum(surface_counts.values())
    warnings: list[str] = []

    if selected_tee is None:
        nearest = min(
            (candidate["startPolygonGapYards"] for candidate in tee_candidates),
            default=None,
        )
        suffix = f" Nearest mapped tee is {nearest:.1f} yd from route start." if nearest is not None else ""
        warnings.append(
            "No mapped tee surface was confidently owned by this hole route; "
            f"using golf=hole route start as a virtual tee anchor.{suffix}"
        )
    if requires_fairway and not owned_by_kind.get("fairway"):
        warnings.append("No route-owned fairway feature was found for this non-par-3 hole.")
    if surface_counts["fairway"] > v4.MAX_FAIRWAY_POLYGONS:
        warnings.append(f"Fairway fragmentation {surface_counts['fairway']} exceeds {v4.MAX_FAIRWAY_POLYGONS}.")
    if surface_counts["rough"] > v4.MAX_ROUGH_POLYGONS:
        warnings.append(f"Rough fragmentation {surface_counts['rough']} exceeds {v4.MAX_ROUGH_POLYGONS}.")
    if surface_counts["bunker"] > v4.MAX_BUNKER_POLYGONS:
        warnings.append(f"Bunker fragmentation {surface_counts['bunker']} exceeds {v4.MAX_BUNKER_POLYGONS}.")
    if total_playable > v4.MAX_PLAYABLE_POLYGONS:
        warnings.append(f"Playable polygon count {total_playable} exceeds {v4.MAX_PLAYABLE_POLYGONS}.")
    if green_endpoint_gap > 30:
        warnings.append(f"Target green centroid is {green_endpoint_gap:.1f} yd from the oriented OSM hole endpoint.")
    if route_direction != "as-mapped":
        warnings.append("OSM golf=hole route was reversed because green endpoint evidence required it.")

    tee_anchor_ready = selected_tee is None or surface_counts["tee"] > 0
    ready = (
        tee_anchor_ready
        and surface_counts["green"] > 0
        and (not requires_fairway or surface_counts["fairway"] > 0)
        and not any(
            "fragmentation" in warning.lower()
            or "polygon count" in warning.lower()
            or "no route-owned fairway" in warning.lower()
            for warning in warnings
        )
    )

    corridor_bounds = context_corridor.bounds
    green_latlon = target_green["centroid"]
    coordinate_frame: dict[str, Any] = {
        "origin": coordinate_origin,
        "teeAnchorMethod": anchor_method,
        "axisBasis": "osm-hole-route-start-to-target-green",
        "routeDirection": route_direction,
        "headingDegreesTrue": round(heading, 6),
        "anchorLatLon": [round(anchor_latlon[0], 8), round(anchor_latlon[1], 8)],
        "targetGreenLatLon": [round(green_latlon[0], 8), round(green_latlon[1], 8)],
        "selectedTeeOffsetFromRouteStartYds": [round(anchor_offset[0], 3), round(anchor_offset[1], 3)],
        "routeStartInSelectedTeeFrameYds": [round(-anchor_offset[0], 3), round(-anchor_offset[1], 3)],
    }
    if selected_tee is not None:
        coordinate_frame["selectedTeeOsmId"] = selected_tee.get("osm_id")
        coordinate_frame["selectedTeeLatLon"] = [
            round(selected_tee["centroid"][0], 8),
            round(selected_tee["centroid"][1], 8),
        ]

    model = {
        "hole": hole_number,
        "par": par,
        "referenceYards": round(reference_yards, 1),
        "coordinateFrame": coordinate_frame,
        "viewBounds": {
            "minX": round(float(corridor_bounds[0]), 1),
            "minY": round(float(corridor_bounds[1]), 1),
            "maxX": round(float(corridor_bounds[2]), 1),
            "maxY": round(float(corridor_bounds[3]), 1),
        },
        "surfaces": surfaces,
        "context": context,
    }

    nearest_start_gap = min(
        (candidate["startPolygonGapYards"] for candidate in tee_candidates),
        default=None,
    )
    diagnostic: dict[str, Any] = {
        "hole": hole_number,
        "par": par,
        "referenceYards": round(reference_yards, 1),
        "anchorMethod": anchor_method,
        "axisBasis": "osm-hole-route-start-to-target-green",
        "routeDirection": route_direction,
        "routeEndpointGreenGapsYards": {
            "mappedStart": round(start_green_gap, 1),
            "mappedEnd": round(end_green_gap, 1),
        },
        "routeLengthYards": round(route_yards, 1),
        "routeLengthResidualYards": round(route_yards - reference_yards, 1),
        "straightTeeToGreenYards": round(math.hypot(pin[0], pin[1]), 1),
        "targetGreenOsmId": target_green.get("osm_id"),
        "greenEndpointGapYards": round(green_endpoint_gap, 1),
        "headingDegreesTrue": round(heading, 2),
        "nearestMappedTeeSurfaceYards": round(nearest_start_gap, 1) if nearest_start_gap is not None else None,
        "selectedTeeOsmId": selected_tee.get("osm_id") if selected_tee is not None else None,
        "selectedTeeOffsetFromRouteStartYds": [round(anchor_offset[0], 1), round(anchor_offset[1], 1)],
        "nearbyTeeCandidates": [
            {
                "osmId": item["osmId"],
                "startPolygonGapYards": round(item["startPolygonGapYards"], 1),
                "startCentroidGapYards": round(item["startCentroidGapYards"], 1),
                "currentRouteGapYards": round(item["currentRouteGapYards"], 1),
                "nearestRouteHole": item["nearestRouteHole"],
                "nearestRouteGapYards": round(item["nearestRouteGapYards"], 1),
                "ownedByCurrentHole": bool(item["ownedByCurrentHole"]),
            }
            for item in tee_candidates[:8]
        ],
        "selectionCorridorYards": context_width,
        "routeOwnedSurfaceFeatures": {
            kind: len(owned_by_kind.get(kind, []))
            for kind in ROUTE_OWNED_SURFACE_KINDS
        },
        "excludedForeignSurfaceFeatures": {
            kind: len(excluded_foreign_by_kind.get(kind, []))
            for kind in ROUTE_OWNED_SURFACE_KINDS
        },
        "surfacePolygons": surface_counts,
        "contextPolygons": {
            kind: len(context.get(kind, []))
            for kind in ("woods", "scrub", "grass-context")
        },
        "fairwayRequired": requires_fairway,
        "ready": ready,
        "warnings": warnings,
    }
    if selected_candidate is not None:
        diagnostic["selectedTeeRouteGapYards"] = round(selected_candidate["currentRouteGapYards"], 1)
        diagnostic["selectedTeeNearestRouteHole"] = selected_candidate["nearestRouteHole"]

    return model, diagnostic


# Reuse V4's reproducible package/manifest writer with V5's anchor contract.
v4.model_for_hole = model_for_hole

if __name__ == "__main__":
    raise SystemExit(v4.main())
