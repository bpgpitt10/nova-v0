#!/usr/bin/env python3
"""V6 course compiler helpers: preserve every route-owned OSM tee candidate.

V5 remains authoritative for hole ownership, route orientation, selected anchor,
and playable geometry. V6 adds metadata only: the generated hole model retains
all route-owned tee boxes in the same local coordinate frame as the hole.
"""

from __future__ import annotations

from typing import Any

import build_osm_course_package as base
import build_osm_course_package_v4 as v4
import build_osm_course_package_v5 as v5


_BASE_NORMALIZE_OSM = base.normalize_osm
TEE_TAG_KEYS = ("tee", "name", "ref", "colour", "color")


def _string_tags(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): str(tag_value)
        for key, tag_value in value.items()
        if isinstance(key, str) and isinstance(tag_value, (str, int, float, bool))
    }


def normalize_osm(payload: dict[str, Any]):
    """Run the existing normalizer, then restore source OSM tags by element id."""
    features, hole_routes = _BASE_NORMALIZE_OSM(payload)
    tags_by_element = {
        (str(element.get("type")), element.get("id")): _string_tags(element.get("tags"))
        for element in payload.get("elements", [])
        if element.get("id") is not None
    }
    for feature in features:
        tags = tags_by_element.get((str(feature.get("osm_type")), feature.get("osm_id")), {})
        if tags:
            feature["source_tags"] = tags
    return features, hole_routes


def _tee_label(tags: dict[str, str]) -> str | None:
    for key in TEE_TAG_KEYS:
        value = tags.get(key)
        if value and value.strip():
            return value.strip()
    return None


def _candidate_polygons(
    feature: dict[str, Any],
    route_origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    anchor_offset: tuple[float, float],
    simplify_yards: float,
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    for polygon in v5.feature_polygons_rebased(
        feature,
        route_origin,
        forward,
        right,
        anchor_offset,
    ):
        polygons.extend(v4.serialize_shape(polygon, simplify_yards))
    return polygons


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
):
    """Return the unchanged V5 model plus every confidently owned tee candidate."""
    model, diagnostic = v5.model_for_hole(hole_number, config, features, hole_routes)

    raw_route = hole_routes[hole_number]
    selection = config.get("selection") or {}
    tee_search_radius = float(selection.get("teeStartRadiusYards", v5.DEFAULT_TEE_SEARCH_RADIUS_YARDS))
    simplify_yards = float(selection.get("geometrySimplifyYards", v4.DEFAULT_SIMPLIFY_YARDS))

    greens = [feature for feature in features if feature["kind"] == "green"]
    tees = [feature for feature in features if feature["kind"] == "tee"]
    route, target_green, *_ = v5.orient_route_to_green(raw_route, greens)
    selected_tee, nearby_candidates = v5.tee_anchor_for_hole(
        hole_number,
        route,
        tees,
        hole_routes,
        tee_search_radius,
    )

    route_origin, forward, right, _ = v5.basis_for_route_start(route, target_green)
    anchor_offset = (
        base.to_hole_local(selected_tee["centroid"], route_origin, forward, right)
        if selected_tee is not None
        else (0.0, 0.0)
    )
    selected_osm_id = selected_tee.get("osm_id") if selected_tee is not None else None

    tee_candidates: list[dict[str, Any]] = []
    for item in nearby_candidates:
        if not item["ownedByCurrentHole"]:
            continue
        feature = item["feature"]
        tags = _string_tags(feature.get("source_tags"))
        local_before_rebase = base.to_hole_local(feature["centroid"], route_origin, forward, right)
        course_point = v5.shifted_point(local_before_rebase, anchor_offset)
        tee_to_green = base.haversine_yards(feature["centroid"], target_green["centroid"])
        color = tags.get("colour") or tags.get("color")
        candidate = {
            "osmId": feature.get("osm_id"),
            "osmType": feature.get("osm_type"),
            "teeSet": tags.get("tee"),
            "name": tags.get("name"),
            "ref": tags.get("ref"),
            "color": color,
            "label": _tee_label(tags),
            "sourceTags": tags,
            "sourceLatLon": [
                round(feature["centroid"][0], 8),
                round(feature["centroid"][1], 8),
            ],
            "coursePoint": [round(course_point[0], 3), round(course_point[1], 3)],
            "teeToGreenCentroidYards": round(tee_to_green, 1),
            "startPolygonGapYards": round(item["startPolygonGapYards"], 1),
            "currentRouteGapYards": round(item["currentRouteGapYards"], 1),
            "selectedAnchor": feature.get("osm_id") == selected_osm_id,
            "polygons": _candidate_polygons(
                feature,
                route_origin,
                forward,
                right,
                anchor_offset,
                simplify_yards,
            ),
        }
        tee_candidates.append(candidate)

    tee_candidates.sort(key=lambda candidate: (
        candidate["teeToGreenCentroidYards"],
        str(candidate["osmId"]),
    ))
    model["teeCandidates"] = tee_candidates
    diagnostic["ownedTeeCandidateCount"] = len(tee_candidates)
    diagnostic["ownedTeeCandidates"] = [
        {
            "osmId": candidate["osmId"],
            "teeSet": candidate["teeSet"],
            "label": candidate["label"],
            "coursePoint": candidate["coursePoint"],
            "teeToGreenCentroidYards": candidate["teeToGreenCentroidYards"],
            "selectedAnchor": candidate["selectedAnchor"],
        }
        for candidate in tee_candidates
    ]
    return model, diagnostic
