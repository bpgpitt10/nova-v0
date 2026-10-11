#!/usr/bin/env python3
"""Fill unmapped course context from ESA WorldCover without changing golf surfaces.

The packaged OSM golf geometry remains authoritative. WorldCover is sampled only
inside each hole's runtime view bounds, transformed into Looper hole-local yards,
and then clipped against all already-known OSM surfaces/context. The resulting
polygons are visual/context evidence only; this tool never creates tactical
surfaces or penalties.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Callable

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from rasterio.mask import mask
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform, triangulate, unary_union
from shapely.validation import make_valid

EARTH_RADIUS_M = 6_371_008.8
YD_TO_M = 0.9144
M_TO_YD = 1.0 / YD_TO_M

# Keep the satellite source explicit and separate from tactical OSM semantics.
CLASS_TO_CONTEXT = {
    10: "landcover-woods",
    20: "landcover-scrub",
    30: "landcover-grass",
    60: "landcover-bare",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--holes", nargs="*", type=int)
    parser.add_argument("--min-area-sqyd", type=float, default=35.0)
    parser.add_argument("--simplify-yards", type=float, default=1.25)
    parser.add_argument("--smooth-yards", type=float, default=1.5)
    return parser.parse_args()


def scalar_or_array(value: Any):
    return np.asarray(value, dtype=float)


def local_wgs_transforms(anchor_lat: float, anchor_lon: float, heading_deg: float) -> tuple[Callable, Callable]:
    heading = math.radians(heading_deg)
    forward_e = math.sin(heading)
    forward_n = math.cos(heading)
    right_e = forward_n
    right_n = -forward_e
    cos_lat0 = math.cos(math.radians(anchor_lat))

    def local_to_wgs(x: Any, y: Any, z: Any = None):
        x_arr = scalar_or_array(x)
        y_arr = scalar_or_array(y)
        east_yd = x_arr * right_e + y_arr * forward_e
        north_yd = x_arr * right_n + y_arr * forward_n
        east_m = east_yd * YD_TO_M
        north_m = north_yd * YD_TO_M
        lat = anchor_lat + np.degrees(north_m / EARTH_RADIUS_M)
        lon = anchor_lon + np.degrees(east_m / (EARTH_RADIUS_M * cos_lat0))
        return lon, lat

    def wgs_to_local(lon: Any, lat: Any, z: Any = None):
        lon_arr = scalar_or_array(lon)
        lat_arr = scalar_or_array(lat)
        north_m = EARTH_RADIUS_M * np.radians(lat_arr - anchor_lat)
        east_m = EARTH_RADIUS_M * np.radians(lon_arr - anchor_lon) * cos_lat0
        east_yd = east_m * M_TO_YD
        north_yd = north_m * M_TO_YD
        x_local = east_yd * right_e + north_yd * right_n
        y_local = east_yd * forward_e + north_yd * forward_n
        return x_local, y_local

    return local_to_wgs, wgs_to_local


def polygon_from_points(points: Any) -> Polygon | None:
    if not isinstance(points, list) or len(points) < 3:
        return None
    try:
        polygon = make_valid(Polygon([(float(p[0]), float(p[1])) for p in points]))
    except (TypeError, ValueError, IndexError):
        return None
    if polygon.is_empty:
        return None
    if isinstance(polygon, Polygon):
        return polygon
    polygons = [part for part in getattr(polygon, "geoms", []) if isinstance(part, Polygon)]
    return max(polygons, key=lambda item: item.area, default=None)


def known_geometry(hole: dict[str, Any]) -> Any:
    polygons = []
    for group_name in ("surfaces", "context"):
        group = hole.get(group_name) or {}
        if not isinstance(group, dict):
            continue
        for kind, raw_polygons in group.items():
            if kind == "native-ground" or kind.startswith("landcover-"):
                continue
            if not isinstance(raw_polygons, list):
                continue
            for raw_polygon in raw_polygons:
                polygon = polygon_from_points(raw_polygon)
                if polygon is not None:
                    polygons.append(polygon)
    return make_valid(unary_union(polygons)) if polygons else GeometryCollection()


def _exterior_only_polygons(geometry: Any, depth: int = 0) -> list[Polygon]:
    """The runtime polygon format stores exteriors only; never fill interior holes.

    Cutting the clipped context into non-holed pieces prevents WorldCover from
    painting back over OSM tee islands surrounded by forest.
    """
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        if not geometry.interiors:
            return [geometry]
        if depth >= 3:
            raise ValueError("WorldCover polygon could not be made hole-free")
        pieces: list[Polygon] = []
        for triangle in triangulate(geometry):
            pieces.extend(_exterior_only_polygons(make_valid(triangle.intersection(geometry)), depth + 1))
        return pieces
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        return [
            item
            for part in geometry.geoms
            for item in _exterior_only_polygons(part, depth)
        ]
    return []


def serialize_geometry(geometry: Any, min_area: float, simplify: float, smooth: float, protected: Any = None) -> list[list[list[float]]]:
    if geometry.is_empty:
        return []
    cleaned = make_valid(geometry)
    if smooth > 0:
        cleaned = make_valid(cleaned.buffer(smooth, join_style=1).buffer(-smooth, join_style=1))
    if simplify > 0:
        cleaned = make_valid(cleaned.simplify(simplify, preserve_topology=True))
    # Protect AFTER smoothing/simplification, which can otherwise re-fill tees.
    # The small buffer prevents 0.1-yard coordinate serialization rounding from
    # repainting a mapped surface.
    if protected is not None and not protected.is_empty:
        cleaned = make_valid(cleaned.difference(protected.buffer(0.2)))

    output: list[list[list[float]]] = []
    for polygon in _exterior_only_polygons(cleaned):
        if polygon.area < min_area:
            continue
        coords = [[round(float(x), 1), round(float(y), 1)] for x, y in polygon.exterior.coords]
        if len(coords) >= 4:
            output.append(coords)
    return output


def enrich_hole(ds: rasterio.io.DatasetReader, hole: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    frame = hole.get("coordinateFrame") or {}
    anchor = frame.get("anchorLatLon")
    heading = frame.get("headingDegreesTrue")
    bounds = hole.get("viewBounds") or {}
    if (
        not isinstance(anchor, list) or len(anchor) < 2
        or not isinstance(heading, (int, float))
        or not all(isinstance(bounds.get(key), (int, float)) for key in ("minX", "minY", "maxX", "maxY"))
    ):
        raise ValueError(f"Hole {hole.get('hole')} lacks anchor/heading/view bounds required for WorldCover")

    anchor_lat, anchor_lon = float(anchor[0]), float(anchor[1])
    local_to_wgs, wgs_to_local = local_wgs_transforms(anchor_lat, anchor_lon, float(heading))
    local_view = box(float(bounds["minX"]), float(bounds["minY"]), float(bounds["maxX"]), float(bounds["maxY"]))
    view_wgs = transform(local_to_wgs, local_view)

    to_dataset = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True).transform
    to_wgs = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True).transform
    view_dataset = transform(to_dataset, view_wgs)

    data, affine = mask(ds, [mapping(view_dataset)], crop=True, filled=True, nodata=0)
    band = data[0].astype(np.uint8)
    valid = np.isin(band, np.array(list(CLASS_TO_CONTEXT), dtype=np.uint8))

    class_geometries: dict[str, list[Any]] = {kind: [] for kind in CLASS_TO_CONTEXT.values()}
    for raw_geom, raw_value in shapes(band, mask=valid, transform=affine):
        code = int(raw_value)
        kind = CLASS_TO_CONTEXT.get(code)
        if kind is None:
            continue
        geom_dataset = make_valid(shape(raw_geom))
        geom_wgs = transform(to_wgs, geom_dataset)
        geom_local = make_valid(transform(wgs_to_local, geom_wgs).intersection(local_view))
        if not geom_local.is_empty:
            class_geometries[kind].append(geom_local)

    known = known_geometry(hole)
    context = dict(hole.get("context") or {})
    context.pop("native-ground", None)
    for existing_kind in list(context):
        if existing_kind.startswith("landcover-"):
            context.pop(existing_kind, None)

    audit: dict[str, Any] = {
        "hole": int(hole.get("hole") or 0),
        "viewAreaSqYd": round(local_view.area, 1),
        "knownAreaSqYd": round(known.intersection(local_view).area, 1) if not known.is_empty else 0.0,
        "classes": {},
    }

    for kind, geometries in class_geometries.items():
        merged = make_valid(unary_union(geometries)) if geometries else GeometryCollection()
        if not known.is_empty:
            merged = make_valid(merged.difference(known))
        serialized = serialize_geometry(
            merged,
            min_area=args.min_area_sqyd,
            simplify=args.simplify_yards,
            smooth=args.smooth_yards,
            protected=known,
        )
        if serialized:
            context[kind] = serialized
        audit["classes"][kind] = {
            "polygons": len(serialized),
            "areaSqYd": round(sum((polygon_from_points(poly).area if polygon_from_points(poly) else 0.0) for poly in serialized), 1),
        }

    hole["context"] = context
    return audit


def main() -> int:
    args = parse_args()
    package = json.loads(args.package.read_text(encoding="utf-8"))
    holes = package.get("holes") or {}
    selected = set(args.holes or [int(key) for key in holes if str(key).isdigit()])

    audit = {
        "source": "ESA WorldCover 2021 v200",
        "sourceUrl": args.source_url,
        "resolutionMeters": 10,
        "policy": "context-only; OSM surfaces/context win; no tactical surface promotion",
        "holes": {},
    }

    with rasterio.open(args.source_url) as ds:
        for hole_number in sorted(selected):
            raw = holes.get(str(hole_number))
            if not isinstance(raw, dict):
                raise ValueError(f"Package is missing Hole {hole_number}")
            audit["holes"][str(hole_number)] = enrich_hole(ds, raw, args)

    package["landcoverProvenance"] = {
        "provider": "ESA WorldCover 2021 v200",
        "resolutionMeters": 10,
        "sourceUrl": args.source_url,
        "role": "visual/context fill for otherwise-unmapped ground; never overrides OSM golf geometry",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(package, separators=(",", ":")) + "\n", encoding="utf-8")

    if args.audit:
        args.audit.parent.mkdir(parents=True, exist_ok=True)
        args.audit.write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(audit, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
