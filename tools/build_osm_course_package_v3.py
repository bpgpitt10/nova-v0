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

A malformed standalone surface/context multipolygon is allowed to be skipped
only for the specific orphan-inner-ring defect seen in real OSM extracts. Golf
hole routes remain strict, arbitrary topology errors remain fatal, and the V2
readiness checks still determine whether losing that feature makes any hole
unusable. Every tolerated skip is recorded in the validation manifest.
"""

from __future__ import annotations

from typing import Any, Iterable

import build_osm_course_package as base
import build_osm_course_package_v2 as v2

try:
    from shapely import make_valid
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
    from shapely.ops import triangulate
except ImportError as exc:
    raise SystemExit(
        "build_osm_course_package_v3.py requires Shapely. "
        "Install tools/requirements-course-importer.txt before building course packages."
    ) from exc

MIN_AREA_YDS2 = 1e-6
TOLERATED_FEATURE_TOPOLOGY_ERROR = "inner ring not contained by an outer ring"


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

        geometries = [part["outer"] for part in parts]
        points = [point for geometry in geometries for point in geometry]
        if not points:
            continue
        features.append(
            {
                "role": role,
                "kind": kind,
                "osm_type": element.get("type"),
                "osm_id": element.get("id"),
                "source_feature": base.source_feature(tags, kind),
                "geometries": geometries,
                "holes_by_geometry": [part["holes"] for part in parts],
                "centroid": base.centroid(points),
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


def serialize_polygons_topology_safe(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    holes_by_geometry = feature.get("holes_by_geometry") or []

    for index, geometry in enumerate(feature["geometries"]):
        outer = local_ring(geometry, origin, forward, right)
        source_holes = holes_by_geometry[index] if index < len(holes_by_geometry) else []
        holes = [local_ring(hole, origin, forward, right) for hole in source_holes if len(hole) >= 3]

        if not holes:
            if len(outer) >= 3:
                polygons.append([[round(x, 3), round(y, 3)] for x, y in outer])
            continue

        shape = make_valid(Polygon(outer, holes))
        source_parts = polygon_parts(shape)
        source_area = sum(part.area for part in source_parts)
        serialized_area = 0.0
        simple_parts: list[Polygon] = []
        for valid_part in source_parts:
            simple_parts.extend(decompose_hole_free(valid_part))

        for part in simple_parts:
            coords = list(part.exterior.coords)
            if len(coords) < 4:
                continue
            serialized_area += part.area
            polygons.append([[round(float(x), 3), round(float(y), 3)] for x, y in coords])

        tolerance = max(0.05, source_area * 1e-7)
        if abs(serialized_area - source_area) > tolerance:
            raise ValueError(
                f"Topology decomposition changed area for OSM {feature.get('osm_type')} "
                f"{feature.get('osm_id')}: source={source_area:.3f}, pieces={serialized_area:.3f}"
            )

    return polygons


def install_topology_safe_primitives() -> None:
    base.normalize_osm = normalize_osm_with_topology
    base.serialize_polygons = serialize_polygons_topology_safe


if __name__ == "__main__":
    install_topology_safe_primitives()
    raise SystemExit(v2.main())
