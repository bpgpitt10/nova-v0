#!/usr/bin/env python3
"""Fetch and preserve one course's OSM geometry from its exact course element.

The course config supplies a specific OSM way/relation. We convert that element
to an Overpass area and query only golf/playable/context geometry inside it.
The fetch is rejected unless the result contains exactly one golf=hole route for
refs 1 through 18. There is intentionally no silent radius fallback: a failed
boundary query should stop the build rather than mix in a neighboring course.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
USER_AGENT = "LooperCourseCache/1.0 (+https://github.com/bpgpitt10/nova-v0)"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=120)
    return parser.parse_args()


def source_clause(config: dict[str, Any]) -> tuple[str, int]:
    source = config.get("osmCourseElement") or {}
    source_type = str(source.get("type") or "").lower()
    source_id = source.get("id")
    if source_type not in {"way", "relation"} or not isinstance(source_id, int):
        raise ValueError("config.osmCourseElement must contain type=way|relation and integer id")
    return ("rel" if source_type == "relation" else "way"), source_id


def query_for(config: dict[str, Any], timeout: int) -> str:
    osm_type, osm_id = source_clause(config)
    return f"""
[out:json][timeout:{timeout}];
{osm_type}(id:{osm_id});
map_to_area -> .courseArea;
(
  nwr(area.courseArea)["golf"];
  nwr(area.courseArea)["natural"~"^(wood|scrub|water)$"];
  nwr(area.courseArea)["landuse"~"^(forest|grass|meadow|reservoir)$"];
);
out geom;
""".strip()


def fetch_json(query: str, timeout: int) -> tuple[dict[str, Any], str]:
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(3):
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
                with urllib.request.urlopen(request, timeout=timeout + 30) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                return payload, endpoint
            except Exception as error:  # noqa: BLE001 - surface all network failures
                last_error = error
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"All Overpass endpoints failed: {last_error}")


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
            "Course boundary query did not resolve exactly one golf=hole route per ref 1-18. "
            f"missing={missing}; duplicates={duplicates}"
        )
    return {hole: values[0] for hole, values in by_ref.items()}


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    query = query_for(config, args.timeout)
    payload, endpoint = fetch_json(query, args.timeout)
    holes = validate_holes(payload)

    osm_type, osm_id = source_clause(config)
    payload["looperSnapshot"] = {
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "courseElement": {"type": osm_type, "id": osm_id},
        "overpassEndpoint": endpoint,
        "query": query,
        "validatedHoleRoutes": {
            str(hole): {"type": element[0], "id": element[1]}
            for hole, element in sorted(holes.items())
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "course": config.get("courseName"),
        "endpoint": endpoint,
        "elements": len(payload.get("elements", [])),
        "holeRefs": sorted(holes),
        "osmBase": (payload.get("osm3s") or {}).get("timestamp_osm_base"),
        "output": str(args.output),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
