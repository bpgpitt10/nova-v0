#!/usr/bin/env python3
"""OSM-first course geometry proof for Looper.

This script is deliberately isolated from the live GSPro path. It turns an Overpass
JSON snapshot into per-hole semantic geometry in golfer-local yards, selects the
mapped tee that best matches a GSPro tee-to-pin distance, associates static OSM
features to holes, and emits inspectable JSON + SVG artifacts.

No network access is required. No production Looper behavior is changed.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

EARTH_RADIUS_M = 6_371_008.8
M_TO_YD = 1.0936133
STATIC_TYPES = ("fairway", "green", "bunker", "rough", "lateral_water_hazard", "water_hazard")
POLYGON_TYPES = set(STATIC_TYPES) | {"tee"}


def geometries(element: dict[str, Any]) -> list[list[dict[str, float]]]:
    out: list[list[dict[str, float]]] = []
    if element.get("geometry"):
        out.append(element["geometry"])
    for member in element.get("members", []):
        if member.get("geometry"):
            out.append(member["geometry"])
    return out


def points(element: dict[str, Any]) -> list[dict[str, float]]:
    return [
        p
        for geom in geometries(element)
        for p in geom
        if p.get("lat") is not None and p.get("lon") is not None
    ]


def centroid_latlon(ps: list[dict[str, float]]) -> tuple[float, float]:
    return (
        sum(float(p["lat"]) for p in ps) / len(ps),
        sum(float(p["lon"]) for p in ps) / len(ps),
    )


def haversine_yards(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h)) * M_TO_YD


def local_east_north_yards(
    latlon: tuple[float, float], origin: tuple[float, float]
) -> tuple[float, float]:
    lat, lon = latlon
    lat0, lon0 = origin
    north_m = EARTH_RADIUS_M * math.radians(lat - lat0)
    east_m = EARTH_RADIUS_M * math.radians(lon - lon0) * math.cos(math.radians(lat0))
    return east_m * M_TO_YD, north_m * M_TO_YD


def point_segment_distance(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    if denom <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def point_polyline_distance(p: tuple[float, float], line: list[tuple[float, float]]) -> float:
    if not line:
        return float("inf")
    if len(line) == 1:
        return math.hypot(p[0] - line[0][0], p[1] - line[0][1])
    return min(point_segment_distance(p, a, b) for a, b in zip(line, line[1:]))


def point_in_polygon(p: tuple[float, float], poly: list[tuple[float, float]]) -> bool:
    if len(poly) < 3:
        return False
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def polyline_polygon_distance(line: list[tuple[float, float]], poly: list[tuple[float, float]]) -> float:
    if not line or not poly:
        return float("inf")
    if any(point_in_polygon(p, poly) for p in line):
        return 0.0
    candidates = [point_polyline_distance(p, line) for p in poly]
    return min(candidates) if candidates else float("inf")


def build_course_projection(elements: list[dict[str, Any]]) -> tuple[float, float]:
    ps = [p for e in elements for p in points(e)]
    if not ps:
        raise ValueError("OSM payload contains no geometry points")
    return centroid_latlon(ps)


def normalize_osm(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    features: list[dict[str, Any]] = []
    hole_routes: dict[int, dict[str, Any]] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        golf = tags.get("golf")
        ps = points(element)
        if not golf or not ps:
            continue
        feature = {
            "osm_type": element.get("type"),
            "osm_id": element.get("id"),
            "golf": golf,
            "ref": tags.get("ref"),
            "par": tags.get("par"),
            "name": tags.get("name"),
            "geometry": [[float(p["lat"]), float(p["lon"])] for p in ps],
            "centroid": list(centroid_latlon(ps)),
        }
        features.append(feature)
        if golf == "hole" and str(tags.get("ref", "")).isdigit():
            hole_routes[int(tags["ref"])] = feature
    return features, hole_routes


def course_xy(latlon: Iterable[float], origin: tuple[float, float]) -> tuple[float, float]:
    lat, lon = latlon
    return local_east_north_yards((float(lat), float(lon)), origin)


def assign_features_to_holes(
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
    course_origin: tuple[float, float],
) -> None:
    route_xy = {
        hole: [course_xy(p, course_origin) for p in route["geometry"]]
        for hole, route in hole_routes.items()
    }
    for feature in features:
        if feature["golf"] not in STATIC_TYPES:
            continue
        poly = [course_xy(p, course_origin) for p in feature["geometry"]]
        distances = {
            hole: polyline_polygon_distance(line, poly)
            for hole, line in route_xy.items()
        }
        if distances:
            best_hole = min(distances, key=distances.get)
            feature["assigned_hole"] = best_hole
            feature["assigned_route_distance_yards"] = round(distances[best_hole], 2)


def select_target_green(
    hole_route: dict[str, Any], greens: list[dict[str, Any]]
) -> tuple[dict[str, Any], float]:
    endpoint = tuple(hole_route["geometry"][-1])
    ranked = sorted(
        ((haversine_yards(tuple(g["centroid"]), endpoint), g) for g in greens),
        key=lambda item: item[0],
    )
    if not ranked:
        raise ValueError("No mapped greens")
    return ranked[0][1], ranked[0][0]


def select_tee(
    hole_route: dict[str, Any],
    target_green: dict[str, Any],
    tees: list[dict[str, Any]],
    target_yards: float,
    radius_yards: float = 180.0,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    start = tuple(hole_route["geometry"][0])
    green = tuple(target_green["centroid"])
    candidates: list[dict[str, Any]] = []
    for tee in tees:
        c = tuple(tee["centroid"])
        start_gap = haversine_yards(c, start)
        if start_gap > radius_yards:
            continue
        green_distance = haversine_yards(c, green)
        candidates.append(
            {
                "feature": tee,
                "tee_id": tee["osm_id"],
                "start_gap_yards": start_gap,
                "green_distance_yards": green_distance,
                "target_residual_yards": green_distance - target_yards,
            }
        )
    if not candidates:
        raise ValueError("No tee polygon candidates near nominal hole start")
    candidates.sort(key=lambda c: (abs(c["target_residual_yards"]), c["start_gap_yards"]))
    return candidates[0]["feature"], candidates


def basis_for_anchors(
    tee: dict[str, Any], green: dict[str, Any]
) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float], float]:
    origin = tuple(tee["centroid"])
    gx, gy = local_east_north_yards(tuple(green["centroid"]), origin)
    length = math.hypot(gx, gy)
    if length < 1e-6:
        raise ValueError("Tee and green anchors collapse to the same point")
    forward = (gx / length, gy / length)
    right = (forward[1], -forward[0])
    heading = (math.degrees(math.atan2(gx, gy)) + 360.0) % 360.0
    return origin, forward, right, heading


def to_golfer_xy(
    latlon: Iterable[float],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[float]:
    east, north = course_xy(latlon, origin)
    return [
        east * right[0] + north * right[1],
        east * forward[0] + north * forward[1],
    ]


def serialize_feature(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
    route_local: list[tuple[float, float]],
) -> dict[str, Any]:
    polygon = [to_golfer_xy(p, origin, forward, right) for p in feature["geometry"]]
    centroid = to_golfer_xy(feature["centroid"], origin, forward, right)
    poly_tuples = [(p[0], p[1]) for p in polygon]
    route_distance = polyline_polygon_distance(route_local, poly_tuples)
    return {
        "osm_id": feature["osm_id"],
        "osm_type": feature["osm_type"],
        "golf": feature["golf"],
        "name": feature.get("name"),
        "ref": feature.get("ref"),
        "assigned_hole": feature.get("assigned_hole"),
        "association_distance_yards": round(route_distance, 2),
        "centroid": {"right_yards": round(centroid[0], 3), "forward_yards": round(centroid[1], 3)},
        "polygon": [
            {"right_yards": round(p[0], 3), "forward_yards": round(p[1], 3)}
            for p in polygon
        ],
    }


def model_for_hole(
    hole: int,
    gspro_target_yards: float,
    course_name: str,
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    route = hole_routes[hole]
    greens = [f for f in features if f["golf"] == "green"]
    tees = [f for f in features if f["golf"] == "tee"]
    target_green, green_endpoint_gap = select_target_green(route, greens)
    selected_tee, tee_candidates = select_tee(route, target_green, tees, gspro_target_yards)
    origin, forward, right, heading = basis_for_anchors(selected_tee, target_green)

    route_points = [to_golfer_xy(p, origin, forward, right) for p in route["geometry"]]
    route_local = [(p[0], p[1]) for p in route_points]

    included: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for feature in features:
        golf = feature["golf"]
        include = False
        if golf in STATIC_TYPES and feature.get("assigned_hole") == hole:
            include = True
        if golf == "green" and feature["osm_id"] == target_green["osm_id"]:
            include = True
        if golf == "tee" and feature["osm_id"] == selected_tee["osm_id"]:
            include = True
        if include:
            included[golf].append(serialize_feature(feature, origin, forward, right, route_local))

    selected_green_distance = haversine_yards(tuple(selected_tee["centroid"]), tuple(target_green["centroid"]))
    all_local_points = [p for p in route_points]
    for group in included.values():
        for feature in group:
            all_local_points.extend(
                [[p["right_yards"], p["forward_yards"]] for p in feature["polygon"]]
            )
    min_r = min(p[0] for p in all_local_points)
    max_r = max(p[0] for p in all_local_points)
    min_f = min(p[1] for p in all_local_points)
    max_f = max(p[1] for p in all_local_points)

    fairways = included.get("fairway", [])
    fairway_route_gap = min((f["association_distance_yards"] for f in fairways), default=None)

    candidate_summary = [
        {
            "tee_id": c["tee_id"],
            "start_gap_yards": round(c["start_gap_yards"], 1),
            "green_distance_yards": round(c["green_distance_yards"], 1),
            "target_residual_yards": round(c["target_residual_yards"], 1),
        }
        for c in tee_candidates[:6]
    ]

    return {
        "schema": "looper.osm_hole_geometry.v0",
        "course": course_name,
        "hole": hole,
        "source": {
            "provider": "OpenStreetMap",
            "license": "ODbL 1.0",
            "role": "static_geometry_candidate",
        },
        "input": {"gspro_tee_to_pin_yards": gspro_target_yards},
        "osm_metadata": {"route_par": route.get("par"), "route_osm_id": route["osm_id"]},
        "anchors": {
            "selected_tee_osm_id": selected_tee["osm_id"],
            "selected_tee_latlon": selected_tee["centroid"],
            "target_green_osm_id": target_green["osm_id"],
            "target_green_latlon": target_green["centroid"],
            "green_endpoint_gap_yards": round(green_endpoint_gap, 1),
            "tee_to_green_centroid_yards": round(selected_green_distance, 1),
            "gspro_distance_residual_yards": round(selected_green_distance - gspro_target_yards, 1),
            "tee_candidates": candidate_summary,
        },
        "transform": {
            "origin": "selected_tee_centroid",
            "positive_forward": "selected_tee_to_target_green_centroid",
            "positive_right": "golfer_right",
            "heading_degrees_true": round(heading, 2),
            "units": "yards",
        },
        "route": [
            {"right_yards": round(p[0], 3), "forward_yards": round(p[1], 3)}
            for p in route_points
        ],
        "features": dict(included),
        "bounds": {
            "min_right_yards": round(min_r, 1),
            "max_right_yards": round(max_r, 1),
            "min_forward_yards": round(min_f, 1),
            "max_forward_yards": round(max_f, 1),
        },
        "checks": {
            "selected_tee_present": True,
            "target_green_present": True,
            "fairway_count": len(fairways),
            "bunker_count": len(included.get("bunker", [])),
            "rough_count": len(included.get("rough", [])),
            "water_count": len(included.get("lateral_water_hazard", [])) + len(included.get("water_hazard", [])),
            "fairway_route_gap_yards": fairway_route_gap,
            "static_geometry_ready": bool(fairways and included.get("green") and included.get("tee")),
        },
    }


def svg_polygon(points_: list[dict[str, float]], mapper, attrs: str) -> str:
    pts = " ".join(f"{mapper(p['right_yards'], p['forward_yards'])[0]:.1f},{mapper(p['right_yards'], p['forward_yards'])[1]:.1f}" for p in points_)
    return f'<polygon points="{pts}" {attrs}/>'


def render_svg(model: dict[str, Any], path: Path) -> None:
    width, height, margin = 620, 860, 55
    bounds = model["bounds"]
    min_r, max_r = bounds["min_right_yards"], bounds["max_right_yards"]
    min_f, max_f = bounds["min_forward_yards"], bounds["max_forward_yards"]
    pad_r = max(20.0, (max_r - min_r) * 0.08)
    pad_f = max(20.0, (max_f - min_f) * 0.05)
    min_r -= pad_r
    max_r += pad_r
    min_f -= pad_f
    max_f += pad_f
    span_r = max(max_r - min_r, 1.0)
    span_f = max(max_f - min_f, 1.0)
    scale = min((width - 2 * margin) / span_r, (height - 2 * margin - 40) / span_f)

    def mapper(r: float, f: float) -> tuple[float, float]:
        x = width / 2 + (r - (min_r + max_r) / 2) * scale
        y = height - margin - (f - min_f) * scale
        return x, y

    styles = {
        "rough": 'fill="#768b63" fill-opacity="0.40" stroke="#526247" stroke-width="1"',
        "fairway": 'fill="#98b77d" fill-opacity="0.82" stroke="#637e52" stroke-width="1.4"',
        "lateral_water_hazard": 'fill="#78aaca" fill-opacity="0.78" stroke="#447da4" stroke-width="1.4"',
        "water_hazard": 'fill="#78aaca" fill-opacity="0.78" stroke="#447da4" stroke-width="1.4"',
        "bunker": 'fill="#d8c796" fill-opacity="0.95" stroke="#aa9764" stroke-width="1.2"',
        "green": 'fill="#62a765" fill-opacity="0.95" stroke="#3d783f" stroke-width="1.5"',
        "tee": 'fill="#b4cb99" fill-opacity="0.95" stroke="#607a4d" stroke-width="1.5"',
    }
    order = ["rough", "fairway", "lateral_water_hazard", "water_hazard", "bunker", "green", "tee"]
    body: list[str] = []
    for golf in order:
        for feature in model["features"].get(golf, []):
            body.append(svg_polygon(feature["polygon"], mapper, styles[golf]))

    route_pts = " ".join(
        f"{mapper(p['right_yards'], p['forward_yards'])[0]:.1f},{mapper(p['right_yards'], p['forward_yards'])[1]:.1f}"
        for p in model["route"]
    )
    body.append(f'<polyline points="{route_pts}" fill="none" stroke="#202020" stroke-width="2" stroke-dasharray="7 5" opacity="0.7"/>')
    tx, ty = mapper(0.0, 0.0)
    body.append(f'<circle cx="{tx:.1f}" cy="{ty:.1f}" r="5" fill="#111"/><text x="{tx+8:.1f}" y="{ty+4:.1f}" font-size="12">TEE</text>')
    green = model["features"].get("green", [{}])[0]
    if green:
        gx = green["centroid"]["right_yards"]
        gf = green["centroid"]["forward_yards"]
        px, py = mapper(gx, gf)
        body.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="4" fill="#b2182b"/><text x="{px+7:.1f}" y="{py+4:.1f}" font-size="12">GREEN</text>')

    checks = model["checks"]
    title = f"{model['course']} — Hole {model['hole']}"
    subtitle = (
        f"GSPro {model['input']['gspro_tee_to_pin_yards']:.0f} yd | "
        f"OSM tee→green {model['anchors']['tee_to_green_centroid_yards']:.1f} yd | "
        f"residual {model['anchors']['gspro_distance_residual_yards']:+.1f} yd | "
        f"fairway {checks['fairway_count']} | bunker {checks['bunker_count']}"
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect width="100%" height="100%" fill="#f5f4ef"/>
<text x="20" y="26" font-family="Arial, sans-serif" font-size="18" font-weight="700">{title}</text>
<text x="20" y="45" font-family="Arial, sans-serif" font-size="11">{subtitle}</text>
<g font-family="Arial, sans-serif">{''.join(body)}</g>
<text x="20" y="842" font-family="Arial, sans-serif" font-size="10">Static geometry candidate © OpenStreetMap contributors, ODbL. GSPro-specific penalty/OB/green-state layers intentionally not inferred here.</text>
</svg>'''
    path.write_text(svg, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", required=True, type=Path, help="Overpass JSON snapshot")
    parser.add_argument("--tee-targets-json", required=True, type=Path, help='JSON mapping such as {"1": 350, ...}')
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--course-name", default="Greywolf Golf Course")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = json.loads(args.osm.read_text(encoding="utf-8"))
    targets_raw = json.loads(args.tee_targets_json.read_text(encoding="utf-8"))
    targets = {int(k): float(v) for k, v in targets_raw.items()}
    features, hole_routes = normalize_osm(payload)
    course_origin = build_course_projection(payload.get("elements", []))
    assign_features_to_holes(features, hole_routes, course_origin)

    missing = sorted(set(targets) - set(hole_routes))
    if missing:
        raise SystemExit(f"Missing OSM hole routes: {missing}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    models: list[dict[str, Any]] = []
    for hole in sorted(targets):
        model = model_for_hole(hole, targets[hole], args.course_name, features, hole_routes)
        models.append(model)
        stem = f"greywolf-hole-{hole:02d}"
        (args.out_dir / f"{stem}.json").write_text(json.dumps(model, indent=2, sort_keys=True), encoding="utf-8")
        render_svg(model, args.out_dir / f"{stem}.svg")

    residuals = [abs(m["anchors"]["gspro_distance_residual_yards"]) for m in models]
    feature_totals = Counter()
    for m in models:
        for golf, group in m["features"].items():
            feature_totals[golf] += len(group)
    manifest = {
        "schema": "looper.osm_geometry_proof_manifest.v0",
        "course": args.course_name,
        "hole_count": len(models),
        "source": "preserved OpenStreetMap/Overpass snapshot",
        "coordinate_system": "selected tee origin; +forward to target green centroid; +right golfer-right; yards",
        "tee_match": {
            "mean_abs_residual_yards": round(sum(residuals) / len(residuals), 2),
            "median_abs_residual_yards": round(sorted(residuals)[len(residuals) // 2], 2),
            "within_10_yards": sum(r <= 10 for r in residuals),
            "within_20_yards": sum(r <= 20 for r in residuals),
        },
        "feature_totals_assigned": dict(sorted(feature_totals.items())),
        "all_holes_static_geometry_ready": all(m["checks"]["static_geometry_ready"] for m in models),
        "holes": [
            {
                "hole": m["hole"],
                "gspro_yards": m["input"]["gspro_tee_to_pin_yards"],
                "osm_tee_green_yards": m["anchors"]["tee_to_green_centroid_yards"],
                "residual_yards": m["anchors"]["gspro_distance_residual_yards"],
                "heading_degrees_true": m["transform"]["heading_degrees_true"],
                "fairways": m["checks"]["fairway_count"],
                "bunkers": m["checks"]["bunker_count"],
                "rough": m["checks"]["rough_count"],
                "water": m["checks"]["water_count"],
                "ready": m["checks"]["static_geometry_ready"],
            }
            for m in models
        ],
    }
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(manifest, indent=2, sort_keys=True))
    if len(models) != 18:
        raise SystemExit(f"Expected 18 Greywolf models, got {len(models)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
