#!/usr/bin/env python3
"""V6 course compiler helpers: preserve and normalize route-owned OSM tees.

V5 remains authoritative for hole ownership, route orientation, selected anchor,
and playable geometry. V6 turns route-owned tee geometry into a COURSE-WIDE tee
contract that the product can actually use:

- Hole 1 defines the selectable tee-set slots for the course.
- Real OSM tee/name/ref/colour labels are preserved when they uniquely identify
  a Hole 1 tee.
- Geometry-only tees receive deterministic back-to-front labels.
- Every selectable Hole 1 tee set is mapped to exactly one tee candidate on
  every hole. When a hole has fewer physical tee boxes, multiple course tee-set
  aliases may intentionally resolve to the same physical box.
- No course-specific mapping table or UI patch is required.

The import validator is responsible for refusing any package where this
course-wide invariant is not satisfied.
"""

from __future__ import annotations

from collections import Counter
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
    # Tee points carry legitimate source positions but NOT tee-box polygons.
    # They are review evidence only; never counted as physical surfaces or as
    # implicitly named product tee sets.
    for element in payload.get("elements", []):
        if element.get("type") != "node" or (element.get("tags") or {}).get("golf") != "tee":
            continue
        geometry = element.get("geometry") or []
        if len(geometry) != 1:
            continue
        try:
            latlon = (float(geometry[0]["lat"]), float(geometry[0]["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        features.append({
            "role": "evidence", "kind": "tee-point", "osm_type": "node",
            "osm_id": element.get("id"), "geometries": [[latlon]],
            "centroid": latlon, "source_feature": "golf=tee",
            "source_tags": _string_tags(element.get("tags")),
        })
    return features, hole_routes


def _tee_label(tags: dict[str, str]) -> str | None:
    for key in TEE_TAG_KEYS:
        value = tags.get(key)
        if value and value.strip():
            return value.strip()
    return None


def _normalize_label(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _fallback_tee_label(index: int, count: int) -> str:
    """Stable user-facing fallback when source data has no tee identity."""
    number = index + 1
    if count == 1:
        return "Tee 1"
    if index == 0:
        return "Tee 1 (Back)"
    if index == count - 1:
        return f"Tee {number} (Front)"
    return f"Tee {number}"


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


def _owned_tee_context(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    selection = config.get("selection") or {}
    tee_search_radius = float(selection.get("teeStartRadiusYards", v5.DEFAULT_TEE_SEARCH_RADIUS_YARDS))
    raw_route = hole_routes[hole_number]
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

    records: list[dict[str, Any]] = []
    for item in nearby_candidates:
        if not item["ownedByCurrentHole"]:
            continue
        feature = item["feature"]
        tags = _string_tags(feature.get("source_tags"))
        records.append({
            "item": item,
            "feature": feature,
            "tags": tags,
            "sourceLabel": _tee_label(tags),
            "teeToGreenCentroidYards": base.haversine_yards(feature["centroid"], target_green["centroid"]),
        })

    # Back-to-front is the canonical positional order. OSM IDs provide a stable
    # tie-break without introducing course-specific knowledge.
    records.sort(key=lambda record: (
        -float(record["teeToGreenCentroidYards"]),
        str(record["feature"].get("osm_id")),
    ))
    return {
        "route": route,
        "targetGreen": target_green,
        "selectedTee": selected_tee,
        "routeOrigin": route_origin,
        "forward": forward,
        "right": right,
        "anchorOffset": anchor_offset,
        "records": records,
    }


def _canonical_tee_slots(
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build the course's selectable tee identities from Hole 1.

    Hole 1 is already the Round Setup discovery hole, so making it the source of
    truth prevents the UI, importer and runtime from inventing different tee-set
    universes.
    """
    records = _owned_tee_context(1, config, features, hole_routes)["records"]
    source_labels = [_normalize_label(record.get("sourceLabel")) for record in records]
    counts = Counter(label for label in source_labels if label)
    used: set[str] = set()
    slots: list[dict[str, Any]] = []

    for index, record in enumerate(records):
        source_label = record.get("sourceLabel")
        source_key = _normalize_label(source_label)
        use_source = bool(source_key and counts[source_key] == 1 and source_key not in used)
        label = str(source_label).strip() if use_source else _fallback_tee_label(index, len(records))
        normalized = _normalize_label(label)
        if normalized in used:
            # Extremely defensive collision handling (for example a source tee
            # literally named "Tee 1 (Back)"). The generated identity remains
            # deterministic and unique.
            base_label = _fallback_tee_label(index, len(records))
            suffix = 2
            label = base_label
            normalized = _normalize_label(label)
            while normalized in used:
                label = f"{base_label} #{suffix}"
                normalized = _normalize_label(label)
                suffix += 1
        used.add(normalized)
        slots.append({
            "index": index,
            "label": label,
            "normalized": normalized,
            "sourceKey": source_key if use_source else None,
        })
    return slots


def _slot_assignments(
    records: list[dict[str, Any]],
    slots: list[dict[str, Any]],
) -> dict[int, list[str]]:
    """Map every course-wide tee slot to exactly one physical tee on this hole."""
    assignments: dict[int, list[str]] = {index: [] for index in range(len(records))}
    if not records or not slots:
        return assignments

    source_owners: dict[str, list[int]] = {}
    for index, record in enumerate(records):
        source_key = _normalize_label(record.get("sourceLabel"))
        if source_key:
            source_owners.setdefault(source_key, []).append(index)

    slot_denominator = max(1, len(slots) - 1)
    record_denominator = max(1, len(records) - 1)

    for slot_index, slot in enumerate(slots):
        exact = source_owners.get(slot.get("sourceKey") or "", []) if slot.get("sourceKey") else []
        if len(exact) == 1:
            owner = exact[0]
        else:
            slot_position = slot_index / slot_denominator if len(slots) > 1 else 0.0
            owner = min(
                range(len(records)),
                key=lambda record_index: (
                    abs((record_index / record_denominator if len(records) > 1 else 0.0) - slot_position),
                    record_index,
                ),
            )
        assignments[owner].append(slot["label"])
    return assignments


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
):
    """Return the V5 model plus course-wide runtime tee identities."""
    model, diagnostic = v5.model_for_hole(hole_number, config, features, hole_routes)

    selection = config.get("selection") or {}
    simplify_yards = float(selection.get("geometrySimplifyYards", v4.DEFAULT_SIMPLIFY_YARDS))
    context = _owned_tee_context(hole_number, config, features, hole_routes)
    records = context["records"]
    slots = _canonical_tee_slots(config, features, hole_routes)
    assignments = _slot_assignments(records, slots)

    route_origin = context["routeOrigin"]
    forward = context["forward"]
    right = context["right"]
    anchor_offset = context["anchorOffset"]
    selected_tee = context["selectedTee"]
    selected_osm_id = selected_tee.get("osm_id") if selected_tee is not None else None

    tee_candidates: list[dict[str, Any]] = []
    for record_index, record in enumerate(records):
        item = record["item"]
        feature = record["feature"]
        tags = record["tags"]
        local_before_rebase = base.to_hole_local(feature["centroid"], route_origin, forward, right)
        course_point = v5.shifted_point(local_before_rebase, anchor_offset)
        color = tags.get("colour") or tags.get("color")
        aliases = assignments.get(record_index, [])

        # The primary teeSet is the course-wide slot closest to this physical
        # tee's own back-to-front position; teeAliases carry any additional slots
        # that intentionally share this box on holes with fewer tee polygons.
        primary = None
        if aliases:
            slot_index_by_label = {slot["label"]: slot["index"] for slot in slots}
            record_position = record_index / max(1, len(records) - 1) if len(records) > 1 else 0.0
            primary = min(
                aliases,
                key=lambda label: (
                    abs((slot_index_by_label[label] / max(1, len(slots) - 1) if len(slots) > 1 else 0.0) - record_position),
                    slot_index_by_label[label],
                ),
            )
        ordered_aliases = ([primary] if primary else []) + [alias for alias in aliases if alias != primary]

        candidate = {
            "osmId": feature.get("osm_id"),
            "osmType": feature.get("osm_type"),
            "teeSet": primary,
            "teeAliases": ordered_aliases,
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
            "teeToGreenCentroidYards": round(float(record["teeToGreenCentroidYards"]), 1),
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

    # Preserve the package's historical front-to-back candidate ordering while
    # teeSet/teeAliases carry the course-wide identity independently.
    tee_candidates.sort(key=lambda candidate: (
        candidate["teeToGreenCentroidYards"],
        str(candidate["osmId"]),
    ))
    # Assign OSM point evidence by nearest mapped hole-line start, not by
    # nearest fairway or UI tee color. Keep provenance and uncertainty explicit.
    # A point is never converted into a fake surface polygon.
    tee_point_evidence = []
    mapped_points = [f for f in features if f["kind"] == "tee-point"]
    if mapped_points:
        greens = [f for f in features if f["kind"] == "green"]
        starts = {
            n: v5.orient_route_to_green(route, greens)[0]["geometry"][0]
            for n, route in hole_routes.items()
        }
        for point_feature in mapped_points:
            ranked = sorted(
                ((base.haversine_yards(point_feature["centroid"], start), n)
                 for n, start in starts.items())
            )
            if not ranked or ranked[0][1] != hole_number or ranked[0][0] > 220:
                continue
            local = base.to_hole_local(point_feature["centroid"], route_origin, forward, right)
            tags = _string_tags(point_feature.get("source_tags"))
            tee_point_evidence.append({
                "osmId": point_feature.get("osm_id"), "osmType": "node",
                "source": "osm-tee-node", "label": _tee_label(tags),
                "sourceTags": tags,
                "sourceLatLon": list(point_feature["centroid"]),
                "coursePoint": [round(v, 3) for v in v5.shifted_point(local, anchor_offset)],
                "routeStartGapYards": round(ranked[0][0], 1),
                "confidence": "mapped-position-only-no-tee-set",
            })
    model["teePointEvidence"] = tee_point_evidence
    diagnostic["mappedTeePointEvidence"] = len(tee_point_evidence)
    model["teeCandidates"] = tee_candidates
    model["teeSetContract"] = {
        "version": 1,
        "sourceHole": 1,
        "mapping": "source-identity-then-normalized-back-to-front-position",
        "teeSets": [slot["label"] for slot in slots],
    }
    diagnostic["ownedTeeCandidateCount"] = len(tee_candidates)
    diagnostic["courseTeeSets"] = [slot["label"] for slot in slots]
    diagnostic["ownedTeeCandidates"] = [
        {
            "osmId": candidate["osmId"],
            "teeSet": candidate["teeSet"],
            "teeAliases": candidate["teeAliases"],
            "label": candidate["label"],
            "coursePoint": candidate["coursePoint"],
            "teeToGreenCentroidYards": candidate["teeToGreenCentroidYards"],
            "selectedAnchor": candidate["selectedAnchor"],
        }
        for candidate in tee_candidates
    ]
    return model, diagnostic