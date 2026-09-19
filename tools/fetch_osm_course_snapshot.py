#!/usr/bin/env python3
"""Fetch and preserve one course's OSM geometry from its exact course element.

The course config supplies a specific OSM way/relation. We first fetch that exact
boundary, then query only its tight bounding box and locally intersect returned
features with the source boundary. This avoids brittle Overpass map_to_area
materialization while still preventing nearby courses from leaking into the
snapshot. The result is rejected unless it contains exactly one golf=hole route
for refs 1 through 18.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

from shapely.geometry import GeometryCollection, LineString, MultiLineString, Point, Polygon
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
USER_AGENT = "LooperCourseCache/1.0 (+https://github.com/bpgpitt10/nova-v0)"
BOUNDARY_TOLERANCE_DEG = 0.00015
QUERY_MARGIN_DEG = 0.0006


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=45)
    return parser.parse_args()


def source_clause(config: dict[str, Any]) -> tuple[str, str, int]:
    source = config.get("osmCourseElement") or {}
    source_type = str(source.get("type") or "").lower()
    source_id = source.get("id")
    if source_type not in {"way", "relation"} or not isinstance(source_id, int):
        raise ValueError("config.osmCourseElement must contain type=way|relation and integer id")
    return ("rel" if source_type == "relation" else "way"), source_type, source_id


def fetch_json(query: str, timeout: int) -> tuple[dict[str, Any], str]:
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(2):
        for endpoint in OVERPASS_URLS:
            request = urllib.request.Request(
                endpoint,
                data=encoded,
                headers={
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout + 15) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                return payload, endpoint
            except Exception as error:  # noqa: BLE001 - surface all network failures
                last_error = error
        if attempt < 1:
            time.sleep(2)
    raise RuntimeError(f"All Overpass endpoints failed: {last_error}")


def coords(points: Iterable[dict[str, Any]]) -> list[tuple[float, float]]:
    output: list[tuple[float, float]] = []
    for point in points:
        lat = point.get("lat")
        lon = point.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            output.append((float(lon), float(lat)))
    return output


def lines_for_element(element: dict[str, Any], *, outer_only: bool = False) -> list[LineString]:
    direct = coords(element.get("geometry") or [])
    output: list[LineString] = []
    if len(direct) >= 2:
        output.append(LineString(direct))
    for member in element.get("members") or []:
        if outer_only and member.get("role") not in ("outer", ""):
            continue
        member_coords = coords(member.get("geometry") or [])
        if len(member_coords) >= 2:
            output.append(LineString(member_coords))
    return output


def boundary_shape(element: dict[str, Any]):
    direct = coords(element.get("geometry") or [])
    if len(direct) >= 4 and direct[0] == direct[-1]:
        shape = make_valid(Polygon(direct))
        if not shape.is_empty:
            return shape

    lines = lines_for_element(element, outer_only=True)
    if not lines:
        raise ValueError("Course source element did not contain usable boundary geometry")
    merged = unary_union(lines)
    polygons = list(polygonize(merged))
    if not polygons:
        if isinstance(merged, (LineString, MultiLineString)):
            raise ValueError("Course source relation outer members did not close into a polygon")
        raise ValueError("Course source element did not form a polygon")
    return make_valid(unary_union(polygons))


def feature_shape(element: dict[str, Any]):
    direct = coords(element.get("geometry") or [])
    if len(direct) == 1:
        return Point(direct[0])
    if len(direct) >= 2:
        if len(direct) >= 4 and direct[0] == direct[-1]:
            return make_valid(Polygon(direct))
        return LineString(direct)

    lines = lines_for_element(element)
    if not lines:
        return GeometryCollection()
    merged = unary_union(lines)
    polygons = list(polygonize(merged))
    return make_valid(unary_union(polygons)) if polygons else merged


def source_query(config: dict[str, Any], timeout: int) -> str:
    osm_clause, _, osm_id = source_clause(config)
    return f"[out:json][timeout:{timeout}];{osm_clause}(id:{osm_id});out geom;"


def bbox_query(bounds: tuple[float, float, float, float], timeout: int) -> str:
    min_lon, min_lat, max_lon, max_lat = bounds
    south = min_lat - QUERY_MARGIN_DEG
    west = min_lon - QUERY_MARGIN_DEG
    north = max_lat + QUERY_MARGIN_DEG
    east = max_lon + QUERY_MARGIN_DEG
    bbox = f"({south:.8f},{west:.8f},{north:.8f},{east:.8f})"
    return f"""
[out:json][timeout:{timeout}];
(
  wr{bbox}["golf"];
  wr{bbox}["natural"~"^(wood|scrub|water)$"];
  wr{bbox}["landuse"~"^(forest|grass|meadow|reservoir)$"];
);
out geom;
""".strip()


def filter_to_boundary(payload: dict[str, Any], boundary) -> dict[str, Any]:
    envelope = boundary.buffer(BOUNDARY_TOLERANCE_DEG)
    kept = []
    for element in payload.get("elements", []):
        shape = feature_shape(element)
        if shape.is_empty:
            continue
        if shape.intersects(envelope):
            kept.append(element)
    return {
        "version": payload.get("version", 0.6),
        "generator": payload.get("generator", "Overpass API"),
        "osm3s": payload.get("osm3s") or {},
        "elements": kept,
    }


def validate_holes(payload: dict[str, Any]) -> dict[int, tuple[str, int]]:
    by_ref: dict[int, list[tuple[str, int]]] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if tags.get("golf") != "hole":
            continue
        raw_ref = str(tags.get("ref", "")).strip()
        if not raw_ref.isdigit():
            continue
        hole = int(raw_ref)
        if 1 <= hole <= 18:
            by_ref.setdefault(hole, []).append((str(element.get("type")), int(element.get("id"))))

    missing = [hole for hole in range(1, 19) if hole not in by_ref]
    duplicates = {hole: values for hole, values in by_ref.items() if len(values) != 1}
    if missing or duplicates:
        raise ValueError(
            "Exact course-boundary filter did not resolve exactly one golf=hole route per ref 1-18. "
            f"missing={missing}; duplicates={duplicates}"
        )
    return {hole: values[0] for hole, values in by_ref.items()}


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))

    source_payload, source_endpoint = fetch_json(source_query(config, args.timeout), args.timeout)
    source_elements = source_payload.get("elements") or []
    if len(source_elements) != 1:
        raise ValueError(f"Expected exactly one configured course source element; got {len(source_elements)}")
    boundary = boundary_shape(source_elements[0])

    query = bbox_query(boundary.bounds, args.timeout)
    raw_payload, feature_endpoint = fetch_json(query, args.timeout)
    payload = filter_to_boundary(raw_payload, boundary)
    holes = validate_holes(payload)

    osm_clause, source_type, osm_id = source_clause(config)
    payload["looperSnapshot"] = {
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "courseElement": {"type": source_type, "id": osm_id},
        "sourceOverpassEndpoint": source_endpoint,
        "featureOverpassEndpoint": feature_endpoint,
        "sourceQuery": source_query(config, args.timeout),
        "featureQuery": query,
        "boundaryBoundsLonLat": [round(value, 8) for value in boundary.bounds],
        "rawFeatureElementCount": len(raw_payload.get("elements", [])),
        "filteredFeatureElementCount": len(payload.get("elements", [])),
        "validatedHoleRoutes": {
            str(hole): {"type": element[0], "id": element[1]}
            for hole, element in sorted(holes.items())
        },
        "sourceClause": osm_clause,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "course": config.get("courseName"),
        "sourceEndpoint": source_endpoint,
        "featureEndpoint": feature_endpoint,
        "rawElements": len(raw_payload.get("elements", [])),
        "filteredElements": len(payload.get("elements", [])),
        "holeRefs": sorted(holes),
        "osmBase": (payload.get("osm3s") or {}).get("timestamp_osm_base"),
        "output": str(args.output),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
