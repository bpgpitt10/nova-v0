#!/usr/bin/env python3
"""Print tee/green endpoint evidence for every OSM golf=hole route."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import build_osm_course_package as base
import build_osm_course_package_v4 as v4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", required=True, type=Path)
    return parser.parse_args()


def nearest_polygon_gap(features: list[dict[str, Any]], point) -> tuple[float, int | str | None]:
    ranked = sorted(
        (
            v4.feature_distance_to_point_yards(feature, point),
            feature.get("osm_id"),
        )
        for feature in features
    )
    return ranked[0] if ranked else (float("inf"), None)


def nearest_centroid_gap(features: list[dict[str, Any]], point) -> tuple[float, int | str | None]:
    ranked = sorted(
        (base.haversine_yards(feature["centroid"], point), feature.get("osm_id"))
        for feature in features
    )
    return ranked[0] if ranked else (float("inf"), None)


def main() -> int:
    args = parse_args()
    payload = json.loads(args.osm.read_text(encoding="utf-8"))
    features, routes = base.normalize_osm(payload)
    tees = [feature for feature in features if feature["kind"] == "tee"]
    greens = [feature for feature in features if feature["kind"] == "green"]

    print("hole,startTeeGap,endTeeGap,startGreenGap,endGreenGap,preferred,forwardScore,reverseScore")
    for hole in range(1, 19):
        route = routes[hole]
        start = route["geometry"][0]
        end = route["geometry"][-1]
        start_tee, _ = nearest_polygon_gap(tees, start)
        end_tee, _ = nearest_polygon_gap(tees, end)
        start_green, _ = nearest_centroid_gap(greens, start)
        end_green, _ = nearest_centroid_gap(greens, end)
        forward_score = start_tee + end_green
        reverse_score = end_tee + start_green
        preferred = "reverse" if reverse_score + 5 < forward_score else "forward"
        print(
            f"{hole},{start_tee:.1f},{end_tee:.1f},{start_green:.1f},{end_green:.1f},"
            f"{preferred},{forward_score:.1f},{reverse_score:.1f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
