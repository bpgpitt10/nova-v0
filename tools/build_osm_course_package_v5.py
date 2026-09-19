#!/usr/bin/env python3
"""Canonical topology-safe route-course compiler.

V5 keeps the proven v2/v3 hole axes (OSM golf=hole start -> target green) so
existing LiDAR grids can be reused without rotation or resampling, but it moves
the runtime origin to the nearest mapped tee. In other words, V5 changes only
translation, not orientation.

It reuses V4's Shapely topology helpers and adds explicit metadata describing
the old route-start offset. That metadata is also what lets the terrain carry-
forward step translate embedded LiDAR/contours into the new selected-tee frame.
"""

from __future__ import annotations

import math
from typing import Any

from shapely import affinity
from shapely.geometry import LineString

import build_osm_course_package as base
import build_osm_course_package_v4 as v4


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
    route = hole_routes[hole_number]
    selection = config.get("selection") or {}
    max_tee_anchor = float(selection.get("maxTeeAnchorDistanceYards", v4.DEFAULT_MAX_TEE_ANCHOR_YARDS))
    context_width = float(selection.get("contextRouteDistanceYards", v4.DEFAULT_CONTEXT_CORRIDOR_YARDS))
    fairway_width = float(selection.get("fairwayCorridorYards", min(v4.DEFAULT_FAIRWAY_CORRIDOR_YARDS, context_width)))
    hazard_width = float(selection.get("hazardCorridorYards", min(v4.DEFAULT_HAZARD_CORRIDOR_YARDS, context_width)))
    simplify_yards = float(selection.get("geometrySimplifyYards", v4.DEFAULT_SIMPLIFY_YARDS))

    greens = [feature for feature in features if feature["kind"] == "green"]
    tees = [feature for feature in features if feature["kind"] == "tee"]
    target_green, green_endpoint_gap = base.select_target_green(route, greens)
    selected_tee, tee_candidates = v4.selected_tee_for_route(route, tees, max_tee_anchor)

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

    route_yards = v4.route_length_yards(route)
    hole_config = (config.get("holes") or {}).get(str(hole_number)) or {}
    par = int(hole_config.get("par") or route.get("par") or 0) or None
    reference_yards = float(hole_config.get("targetYards") or route_yards)
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
            f"Target green centroid is {green_endpoint_gap:.1f} yd from the OSM hole endpoint."
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

    nearest_gap = tee_candidates[0]["startPolygonGapYards"]
    diagnostic = {
        "hole": hole_number,
        "par": par,
        "referenceYards": round(reference_yards, 1),
        "anchorMethod": "selected-tee-nearest-route-start",
        "axisBasis": "osm-hole-route-start-to-target-green",
        "routeLengthYards": round(route_yards, 1),
        "routeLengthResidualYards": round(route_yards - reference_yards, 1),
        "straightTeeToGreenYards": round(math.hypot(pin[0], pin[1]), 1),
        "targetGreenOsmId": target_green.get("osm_id"),
        "greenEndpointGapYards": round(green_endpoint_gap, 1),
        "headingDegreesTrue": round(heading, 2),
        "nearestMappedTeeSurfaceYards": round(nearest_gap, 1),
        "selectedTeeOsmId": selected_tee.get("osm_id"),
        "selectedTeeOffsetFromRouteStartYds": [
            round(tee_offset[0], 1), round(tee_offset[1], 1)
        ],
        "nearbyTeeCandidates": [
            {
                "osmId": item["osmId"],
                "startPolygonGapYards": round(item["startPolygonGapYards"], 1),
                "startCentroidGapYards": round(item["startCentroidGapYards"], 1),
            }
            for item in tee_candidates[:6]
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
# model builder with V5's translation-only selected-tee implementation.
v4.model_for_hole = model_for_hole

if __name__ == "__main__":
    raise SystemExit(v4.main())
