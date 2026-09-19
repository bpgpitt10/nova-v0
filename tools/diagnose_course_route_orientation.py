#!/usr/bin/env python3
"""Print route-endpoint and tee-ownership evidence for OSM golf holes.

This is intentionally diagnostic, not a selection algorithm. Besides the simple
endpoint table it prints detailed tee candidates for suspicious holes so we can
see whether a tee is actually closest to the current hole route or belongs to a
neighboring hole.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import build_osm_course_package as base
import build_osm_course_package_v4 as v4

DETAIL_HOLES = {1, 9, 11, 13, 15, 16, 17}
DETAIL_ROUTE_START_RADIUS_YARDS = 450.0


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


def course_origin(routes: dict[int, dict[str, Any]]) -> tuple[float, float]:
    return base.centroid([
        point
        for route in routes.values()
        for point in route["geometry"]
    ])


def route_xy(routes: dict[int, dict[str, Any]], origin: tuple[float, float]):
    return {
        hole: [base.course_xy(point, origin) for point in route["geometry"]]
        for hole, route in routes.items()
    }


def tee_route_gap(
    tee: dict[str, Any],
    line: list[tuple[float, float]],
    origin: tuple[float, float],
) -> float:
    geometries_xy = [
        [base.course_xy(point, origin) for point in geometry]
        for geometry in tee["geometries"]
    ]
    return base.feature_distance_to_route(geometries_xy, line)


def target_green_for_route(route: dict[str, Any], greens: list[dict[str, Any]]):
    end = route["geometry"][-1]
    return min(
        greens,
        key=lambda green: base.haversine_yards(green["centroid"], end),
    )


def print_tee_ownership(
    hole: int,
    routes: dict[int, dict[str, Any]],
    tees: list[dict[str, Any]],
    greens: list[dict[str, Any]],
    lines: dict[int, list[tuple[float, float]]],
    origin: tuple[float, float],
) -> None:
    route = routes[hole]
    start = route["geometry"][0]
    target_green = target_green_for_route(route, greens)
    candidates = []
    for tee in tees:
        start_gap = v4.feature_distance_to_point_yards(tee, start)
        if start_gap > DETAIL_ROUTE_START_RADIUS_YARDS:
            continue
        route_gaps = {
            route_hole: tee_route_gap(tee, line, origin)
            for route_hole, line in lines.items()
        }
        nearest_hole = min(route_gaps, key=route_gaps.get)
        candidates.append({
            "osmId": tee.get("osm_id"),
            "startGap": start_gap,
            "greenDistance": base.haversine_yards(tee["centroid"], target_green["centroid"]),
            "currentRouteGap": route_gaps[hole],
            "nearestRouteHole": nearest_hole,
            "nearestRouteGap": route_gaps[nearest_hole],
        })

    candidates.sort(key=lambda item: (item["currentRouteGap"], item["startGap"], item["greenDistance"]))
    print(f"\nTEE OWNERSHIP H{hole} targetGreenOsmId={target_green.get('osm_id')}")
    print("osmId,startGap,greenDistance,currentRouteGap,nearestRouteHole,nearestRouteGap")
    for item in candidates[:18]:
        print(
            f"{item['osmId']},{item['startGap']:.1f},{item['greenDistance']:.1f},"
            f"{item['currentRouteGap']:.1f},{item['nearestRouteHole']},{item['nearestRouteGap']:.1f}"
        )


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

    origin = course_origin(routes)
    lines = route_xy(routes, origin)
    for hole in sorted(DETAIL_HOLES):
        print_tee_ownership(hole, routes, tees, greens, lines, origin)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
