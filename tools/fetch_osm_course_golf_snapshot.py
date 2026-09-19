#!/usr/bin/env python3
"""Fetch golf-tagged geometry for one exact course without Overpass.

This diagnostic helper uses the core OpenStreetMap bbox map endpoint for one
small course-sized read, converts the returned XML into the Overpass-like shape
used by the Looper geometry compiler, filters locally to golf=* and then to the
configured course boundary.

Production package extraction remains in fetch_osm_course_snapshot.py and uses
Overpass for cached source snapshots. This helper exists only so tee/green/route
diagnostics are not blocked by Overpass queue/load.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import fetch_osm_course_snapshot as fetcher

MAP_MARGIN_DEG = 0.0006


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=45)
    return parser.parse_args()


def tags_for(element) -> dict[str, str]:
    return {
        tag.attrib.get("k", ""): tag.attrib.get("v", "")
        for tag in element.findall("tag")
        if tag.attrib.get("k")
    }


def fetch_core_map_golf(
    bounds: tuple[float, float, float, float],
    timeout: int,
) -> tuple[dict[str, Any], str, int]:
    min_lon, min_lat, max_lon, max_lat = bounds
    west = min_lon - MAP_MARGIN_DEG
    south = min_lat - MAP_MARGIN_DEG
    east = max_lon + MAP_MARGIN_DEG
    north = max_lat + MAP_MARGIN_DEG
    url = (
        f"{fetcher.OSM_API_BASE}/map?bbox="
        f"{west:.8f},{south:.8f},{east:.8f},{north:.8f}"
    )
    request = urllib.request.Request(
        url,
        headers={"User-Agent": fetcher.USER_AGENT},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout + 20) as response:
        root = ET.fromstring(response.read())

    nodes: dict[int, tuple[float, float]] = {}
    for node in root.findall("node"):
        try:
            nodes[int(node.attrib["id"])] = (
                float(node.attrib["lat"]),
                float(node.attrib["lon"]),
            )
        except (KeyError, TypeError, ValueError):
            continue

    all_ways: dict[int, dict[str, Any]] = {}
    for way in root.findall("way"):
        try:
            way_id = int(way.attrib["id"])
        except (KeyError, TypeError, ValueError):
            continue
        geometry = []
        for nd in way.findall("nd"):
            try:
                ref = int(nd.attrib["ref"])
            except (KeyError, TypeError, ValueError):
                continue
            point = nodes.get(ref)
            if point is not None:
                geometry.append({"lat": point[0], "lon": point[1]})
        all_ways[way_id] = {
            "type": "way",
            "id": way_id,
            "tags": tags_for(way),
            "geometry": geometry,
        }

    golf_elements: list[dict[str, Any]] = [
        way for way in all_ways.values()
        if "golf" in (way.get("tags") or {}) and len(way.get("geometry") or []) >= 2
    ]

    for relation in root.findall("relation"):
        relation_tags = tags_for(relation)
        if "golf" not in relation_tags:
            continue
        try:
            relation_id = int(relation.attrib["id"])
        except (KeyError, TypeError, ValueError):
            continue
        members = []
        for member in relation.findall("member"):
            if member.attrib.get("type") != "way":
                continue
            try:
                ref = int(member.attrib["ref"])
            except (KeyError, TypeError, ValueError):
                continue
            member_way = all_ways.get(ref)
            if member_way is None or len(member_way.get("geometry") or []) < 2:
                continue
            members.append({
                "type": "way",
                "ref": ref,
                "role": member.attrib.get("role", ""),
                "geometry": member_way["geometry"],
            })
        if members:
            golf_elements.append({
                "type": "relation",
                "id": relation_id,
                "tags": relation_tags,
                "members": members,
            })

    payload = {
        "version": 0.6,
        "generator": "OpenStreetMap core map API diagnostic",
        "elements": golf_elements,
    }
    raw_element_count = len(root.findall("node")) + len(root.findall("way")) + len(root.findall("relation"))
    return payload, url, raw_element_count


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))

    source_element, source_endpoint = fetcher.fetch_source_element(config, args.timeout)
    boundary = fetcher.boundary_shape(source_element)

    raw_payload, map_endpoint, raw_element_count = fetch_core_map_golf(boundary.bounds, args.timeout)
    payload = fetcher.filter_to_boundary(raw_payload, boundary)
    holes = fetcher.validate_holes(payload)

    _, source_type, osm_id = fetcher.source_clause(config)
    payload["looperSnapshot"] = {
        "diagnosticOnly": True,
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "courseElement": {"type": source_type, "id": osm_id},
        "sourceEndpoint": source_endpoint,
        "mapEndpoint": map_endpoint,
        "boundaryBoundsLonLat": [round(value, 8) for value in boundary.bounds],
        "validatedHoleRoutes": {
            str(hole): {"type": element[0], "id": element[1]}
            for hole, element in sorted(holes.items())
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "course": config.get("courseName"),
        "sourceEndpoint": source_endpoint,
        "mapEndpoint": map_endpoint,
        "rawMapElements": raw_element_count,
        "golfElementsBeforeBoundaryFilter": len(raw_payload.get("elements", [])),
        "filteredGolfElements": len(payload.get("elements", [])),
        "holeRefs": sorted(holes),
        "output": str(args.output),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
