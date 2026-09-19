#!/usr/bin/env python3
"""Fetch only golf-tagged geometry inside an exact configured course boundary.

Used for fast diagnostics of hole routes, tees, greens, fairways and bunkers.
The production snapshot still uses fetch_osm_course_snapshot.py so natural and
landuse context are preserved for the final package.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import fetch_osm_course_snapshot as fetcher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=35)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))

    source_payload, source_endpoint = fetcher.fetch_json(
        fetcher.source_query(config, args.timeout), args.timeout
    )
    source_elements = source_payload.get("elements") or []
    if len(source_elements) != 1:
        raise ValueError(f"Expected exactly one configured course source element; got {len(source_elements)}")
    boundary = fetcher.boundary_shape(source_elements[0])

    golf_query = fetcher.bbox_queries(boundary.bounds, args.timeout)["golf"]
    raw_payload, golf_endpoint = fetcher.fetch_json(golf_query, args.timeout)
    payload = fetcher.filter_to_boundary(raw_payload, boundary)
    holes = fetcher.validate_holes(payload)

    _, source_type, osm_id = fetcher.source_clause(config)
    payload["looperSnapshot"] = {
        "diagnosticOnly": True,
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "courseElement": {"type": source_type, "id": osm_id},
        "sourceOverpassEndpoint": source_endpoint,
        "golfOverpassEndpoint": golf_endpoint,
        "golfQuery": golf_query,
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
        "golfEndpoint": golf_endpoint,
        "rawGolfElements": len(raw_payload.get("elements", [])),
        "filteredGolfElements": len(payload.get("elements", [])),
        "holeRefs": sorted(holes),
        "output": str(args.output),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
