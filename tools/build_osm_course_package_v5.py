#!/usr/bin/env python3
"""Canonical topology-safe route-course compiler.

V5 keeps the proven cached route-axis orientation whenever the mapped green
confirms that orientation, so existing LiDAR grids can be reused without
rotation or resampling. It moves the runtime origin to an evidence-selected
mapped tee.

Important OSM reality: golf=hole ways do not always begin at the tee surface.
Therefore V5 does not require the route start itself to sit on a tee. Tee
selection uses three signals together:
- the tee is within the configured tee-start search window;
- it is on the current-hole side of the selected green, not merely a nearby
  next-hole tee beside the green;
- its tee-to-green distance is plausible relative to the OSM hole length.

If the mapped green clearly indicates that a route is reversed, V5 records that
fact explicitly. Terrain carry-forward is allowed to reject such a hole rather
than silently rotating an old DEM.
"""

from __future__ import annotations

import math
from typing import Any

from shapely import affinity
from shapely.geometry import LineString

import build_osm_course_package as base
import build_osm_course_package_v4 as v4


DEFAULT_TEE_SEARCH_RADIUS_YARDS = 220.0
ROUTE_DIRECTION_GREEN_MARGIN_YARDS = 15.0
MIN_TEE_GREEN_ROUTE_RATIO = 0.50
MIN_TEE_GREEN_BEHIND_ROUTE_START_YARDS = 35.0


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
    """Orient only when green evidence clearly favors the first route endpoint."""
    start = route["geometry"][0]
    end = route["geometry"][-1]
    start_green, start_gap = nearest_green_to_point(greens, start)
    end_green, end_gap = nearest_green_to_point(greens, end)

    if start_gap + ROUTE_DIRECTION_GREEN_MARGIN_YARDS < end_gap:
        oriented = dict(route)
        oriented["geometry"] = list(reversed(route["geometry"]))
        return oriented, start_green, start_gap, "reversed-to-green", start_gap, end_gap

    return route, end_green, end_gap, "as-mapped", start_gap, end_gap


def length_aware_tee_for_route(
    route: dict[str, Any],
    target_green: dict[str, Any],
    tees: list[dict[str, Any]],
    target_yards: float,
    search_radius_yards: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Choose a mapped tee without assuming the route's first node is the tee.

    The route-start search radius is only a candidate boundary. Selection is
    driven by current-green distance plus hole-length evidence, which prevents a
    nearby next-hole tee at the green end from winning simply because it is near
    an endpoint.
    """
    route_start = route["geometry"][0]
    green = target_green["centroid"]
    route_start_to_green = base.haversine_yards(route_start, green)
    minimum_green_distance = max(
        40.0,
        target_yards * MIN_TEE_GREEN_ROUTE_RATIO,
        route_start_to_green - MIN_TEE_GREEN_BEHIND_ROUTE_START_YARDS,
    )

    candidates: list[dict[str, Any]] = []
    for tee in tees:
        start_polygon_gap = v4.feature_distance_to_point_yards(tee, route_start)
        if start_polygon_gap > search_radius_yards:
            continue
        start_centroid_gap = base.haversine_yards(tee["centroid"], route_start)
        green_distance = base.haversine_yards(tee["centroid"], green)
        length_residual = green_distance - target_yards
        candidates.append(
            {
                "feature": tee,
                "osmId": tee.get("osm_id"),
                "startPolygonGapYards": start_polygon_gap,
                "startCentroidGapYards": start_centroid_gap,
                "greenDistanceYards": green_distance,
                "lengthResidualYards": length_residual,
                "eligibleByGreenDistance": green_distance >= minimum_green_distance,
                "selectionScore": abs(length_residual) + 0.10 * start_polygon_gap,
            }
        )

    if not candidates:
        raise ValueError(
            f"No mapped tee surface within {search_radius_yards:.0f} yd of the OSM hole route start."
        )

    eligible = [candidate for candidate in candidates if candidate["eligibleByGreenDistance"]]
    if not eligible:
        nearest = min(candidates, key=lambda item: item["startPolygonGapYards"])
        raise ValueError(
            "Mapped tee candidates exist near the OSM route start, but none are far enough from "
            "the selected green to represent the current hole. "
            f"Nearest route-start tee gap={nearest['startPolygonGapYards']:.1f} yd; "
            f"minimum tee-to-green distance={minimum_green_distance:.1f} yd."
        )

    ranked = sorted(
        eligible,
        key=lambda item: (
            item["selectionScore"],
            item["startPolygonGapYards"],
            item["startCentroidGapYards"],
        ),
    )
    return ranked[0]["feature"], sorted(
        candidates,
        key=lambda item: (
            not item["eligibleByGreenDistance"],
            item["selectionScore"],
            item["startPolygonGapYards"],
        ),
    )


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
    tee_offset: tuple[float, float],
):
    return [
        affinity.translate(polygon, xoff=-tee_offset[0], yoff=-tee_offset[1])
        for polygon in v4.feature_polygons_local(feature, route_origin, forward, right)
    ]


def feature_intersections_rebased(
    features: list[dict[str, Any]],
    corridor: Any,
    route_origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    tee_offset: tuple[float, float],
    simplify_yards: float,
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    for feature in features:
        for polygon in feature_polygons_rebased(
            feature,
            route_origin,
            forward,
            right,
            tee_offset,
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
    tee_search_radius = float(
        selection.get("teeStartRadiusYards", DEFAULT_TEE_SEARCH_RADIUS_YARDS)
    )
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

    selected_tee, tee_candidates = length_aware_tee_for_route(
        route,
        target_green,
        tees,
        reference_yards,
        tee_search_radius,
    )

    route_origin, forward, right, heading = basis_for_route_start(route, target_green)
    tee_offset = base.to_hole_local(selected_tee["centroid"], route_origin, forward, right)
    pin_old = base.to_hole_local(target_green["centroid"], route_origin, forward, right)
    pin = shifted_point(pin_old, tee_offset)
    route_local = [
        shifted_point(base.to_hole_local(point, route_origin, forward, right), tee_offset)
        for point in route["geometry"]
    ]

    tactical_line = LineString([(0.0, 0.0), *route_local, pin])
    fairway_corridor = tactical_line.buffer(fairway_width, cap_style="round", join_style="round")
    hazard_corridor = tactical_line.buffer(hazard_width, cap_style="round", join_style="round")
    context_corridor = tactical_line.buffer(context_width, cap_style="round", join_style="round")

    by_kind: dict[str, list[dict[str, Any]]] = {}
    for feature in features:
        by_kind.setdefault(feature["kind"], []).append(feature)

    selected_tee_polygons: list[list[list[float]]] = []
    for polygon in feature_polygons_rebased(
        selected_tee, route_origin, forward, right, tee_offset
    ):
        selected_tee_polygons.extend(v4.serialize_shape(polygon, simplify_yards))

    target_green_polygons: list[list[list[float]]] = []
    for polygon in feature_polygons_rebased(
        target_green, route_origin, forward, right, tee_offset
    ):
        target_green_polygons.extend(v4.serialize_shape(polygon, simplify_yards))

    surfaces = {
        "tee": selected_tee_polygons,
        "fairway": feature_intersections_rebased(
            by_kind.get("fairway", []), fairway_corridor,
            route_origin, forward, right, tee_offset, simplify_yards,
        ),
        "rough": feature_intersections_rebased(
            by_kind.get("rough", []), context_corridor,
            route_origin, forward, right, tee_offset, simplify_yards,
        ),
        "green": target_green_polygons,
        "bunker": feature_intersections_rebased(
            by_kind.get("bunker", []), hazard_corridor,
            route_origin, forward, right, tee_offset, simplify_yards,
        ),
        "water": feature_intersections_rebased(
            by_kind.get("water", []), hazard_corridor,
            route_origin, forward, right, tee_offset, simplify_yards,
        ),
    }
    surfaces = {kind: polygons for kind, polygons in surfaces.items() if polygons}

    context = {
        kind: feature_intersections_rebased(
            by_kind.get(kind, []), context_corridor,
            route_origin, forward, right, tee_offset, simplify_yards,
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
    if surface_counts["fairway"] > v4.MAX_FAIRWAY_POLYGONS:
        warnings.append(
            f"Fairway fragmentation {surface_counts['fairway']} exceeds {v4.MAX_FAIRWAY_POLYGONS}."
        )
    if surface_counts["rough"] > v4.MAX_ROUGH_POLYGONS:
        warnings.append(
            f"Rough fragmentation {surface_counts['rough']} exceeds {v4.MAX_ROUGH_POLYGONS}."
        )
    if surface_counts["bunker"] > v4.MAX_BUNKER_POLYGONS:
        warnings.append(
            f"Bunker fragmentation {surface_counts['bunker']} exceeds {v4.MAX_BUNKER_POLYGONS}."
        )
    if total_playable > v4.MAX_PLAYABLE_POLYGONS:
        warnings.append(
            f"Playable polygon count {total_playable} exceeds {v4.MAX_PLAYABLE_POLYGONS}."
        )
    if green_endpoint_gap > 30:
        warnings.append(
            f"Target green centroid is {green_endpoint_gap:.1f} yd from the oriented OSM hole endpoint."
        )
    if route_direction != "as-mapped":
        warnings.append("OSM golf=hole route was reversed because green endpoint evidence required it.")

    selected_candidate = next(
        candidate for candidate in tee_candidates
        if candidate.get("osmId") == selected_tee.get("osm_id")
    )
    selected_start_gap = float(selected_candidate["startPolygonGapYards"])
    if selected_start_gap > v4.DEFAULT_MAX_TEE_ANCHOR_YARDS:
        warnings.append(
            f"OSM hole route begins {selected_start_gap:.1f} yd from the selected tee; "
            "tee was chosen by green and hole-length evidence rather than route-start proximity alone."
        )

    ready = (
        surface_counts["tee"] > 0
        and surface_counts["green"] > 0
        and (not requires_fairway or surface_counts["fairway"] > 0)
        and not any(
            "fragmentation" in warning.lower() or "polygon count" in warning.lower()
            for warning in warnings
        )
    )

    corridor_bounds = context_corridor.bounds
    tee_latlon = selected_tee["centroid"]
    green_latlon = target_green["centroid"]
    model = {
        "hole": hole_number,
        "par": par,
        "referenceYards": round(reference_yards, 1),
        "coordinateFrame": {
            "origin": "selected-tee",
            "axisBasis": "osm-hole-route-start-to-target-green",
            "routeDirection": route_direction,
            "headingDegreesTrue": round(heading, 6),
            "selectedTeeOsmId": selected_tee.get("osm_id"),
            "selectedTeeLatLon": [round(tee_latlon[0], 8), round(tee_latlon[1], 8)],
            "targetGreenLatLon": [round(green_latlon[0], 8), round(green_latlon[1], 8)],
            "selectedTeeOffsetFromRouteStartYds": [
                round(tee_offset[0], 3), round(tee_offset[1], 3)
            ],
            "routeStartInSelectedTeeFrameYds": [
                round(-tee_offset[0], 3), round(-tee_offset[1], 3)
            ],
        },
        "viewBounds": {
            "minX": round(float(corridor_bounds[0]), 1),
            "minY": round(float(corridor_bounds[1]), 1),
            "maxX": round(float(corridor_bounds[2]), 1),
            "maxY": round(float(corridor_bounds[3]), 1),
        },
        "surfaces": surfaces,
        "context": context,
    }

    diagnostic = {
        "hole": hole_number,
        "par": par,
        "referenceYards": round(reference_yards, 1),
        "anchorMethod": "selected-tee-green-length-evidence",
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
        "nearestMappedTeeSurfaceYards": round(selected_start_gap, 1),
        "selectedTeeOsmId": selected_tee.get("osm_id"),
        "selectedTeeGreenDistanceYards": round(selected_candidate["greenDistanceYards"], 1),
        "selectedTeeLengthResidualYards": round(selected_candidate["lengthResidualYards"], 1),
        "selectedTeeSelectionScore": round(selected_candidate["selectionScore"], 1),
        "selectedTeeOffsetFromRouteStartYds": [
            round(tee_offset[0], 1), round(tee_offset[1], 1)
        ],
        "nearbyTeeCandidates": [
            {
                "osmId": item["osmId"],
                "startPolygonGapYards": round(item["startPolygonGapYards"], 1),
                "startCentroidGapYards": round(item["startCentroidGapYards"], 1),
                "greenDistanceYards": round(item["greenDistanceYards"], 1),
                "lengthResidualYards": round(item["lengthResidualYards"], 1),
                "eligibleByGreenDistance": bool(item["eligibleByGreenDistance"]),
                "selectionScore": round(item["selectionScore"], 1),
            }
            for item in tee_candidates[:8]
        ],
        "selectionCorridorYards": context_width,
        "surfacePolygons": surface_counts,
        "contextPolygons": {
            kind: len(context.get(kind, []))
            for kind in ("woods", "scrub", "grass-context")
        },
        "fairwayRequired": requires_fairway,
        "ready": ready,
        "warnings": warnings,
    }
    return model, diagnostic


# Reuse the fully reproducible V4 CLI/package/manifest writer, but replace its
# model builder with V5's evidence-selected tee implementation.
v4.model_for_hole = model_for_hole

if __name__ == "__main__":
    raise SystemExit(v4.main())
