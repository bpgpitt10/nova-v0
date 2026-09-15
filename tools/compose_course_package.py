#!/usr/bin/env python3
"""Compose Looper static OSM geometry and LiDAR terrain into one runtime package.

The final browser artifact remains ``looper-static-course-package-v1``. Terrain
is optional for backward compatibility, but when supplied it is embedded per
hole so runtime consumers make one package request per course rather than
coordinating geometry and terrain sidecars.

Generic terrain input schema (preferred): ``looper-course-terrain-v1``.
The legacy Greywolf terrain schema is accepted only as an explicit migration
input. New course builders should emit the generic schema.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

STATIC_SCHEMA = "looper-static-course-package-v1"
TERRAIN_SCHEMA = "looper-course-terrain-v1"
LEGACY_GREYWOLF_TERRAIN_SCHEMA = "looper-greywolf-terrain-v1"


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_contours(contours: Any, *, hole: int) -> list[dict[str, Any]]:
    if contours is None:
        return []
    if not isinstance(contours, list):
        raise ValueError(f"Hole {hole} terrain contours must be a list")
    output: list[dict[str, Any]] = []
    for index, contour in enumerate(contours, 1):
        if not isinstance(contour, dict) or not finite(contour.get("elevationFt")):
            raise ValueError(f"Hole {hole} contour {index} has invalid elevationFt")
        points = contour.get("points")
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError(f"Hole {hole} contour {index} must have at least two points")
        for point_index, point in enumerate(points, 1):
            if (
                not isinstance(point, list)
                or len(point) < 2
                or not finite(point[0])
                or not finite(point[1])
            ):
                raise ValueError(f"Hole {hole} contour {index} point {point_index} is invalid")
        output.append(copy.deepcopy(contour))
    return output


def embedded_terrain(
    terrain_package: dict[str, Any],
    raw_hole: dict[str, Any],
    *,
    hole: int,
) -> dict[str, Any]:
    grid = raw_hole.get("grid")
    source = terrain_package.get("source")
    runtime = terrain_package.get("runtimeTerrain")
    if not isinstance(grid, dict) or not isinstance(source, dict) or not isinstance(runtime, dict):
        raise ValueError(f"Hole {hole} terrain package is missing grid/source/runtimeTerrain")

    source_resolution = source.get("sourceResolutionMeters")
    spacing = grid.get("spacingYds")
    interpolation = runtime.get("interpolation")
    nodata = runtime.get("nodata")
    for label, value in {
        "sourceResolutionMeters": source_resolution,
        "runtimeSpacingYds": spacing,
        "minX": grid.get("minX"),
        "minY": grid.get("minY"),
        "elevationOffsetFt": grid.get("elevationOffsetFt"),
        "nodata": nodata,
    }.items():
        if not finite(value):
            raise ValueError(f"Hole {hole} terrain {label} is missing or invalid")
    if float(source_resolution) <= 0 or float(spacing) <= 0:
        raise ValueError(f"Hole {hole} terrain resolution/spacing must be positive")
    if interpolation != "bilinear":
        raise ValueError(f"Hole {hole} terrain interpolation must be bilinear")
    if not positive_int(grid.get("width")) or not positive_int(grid.get("height")):
        raise ValueError(f"Hole {hole} terrain width/height must be positive integers")
    if grid.get("compression") != "deflate":
        raise ValueError(f"Hole {hole} terrain compression must be deflate")
    values = grid.get("valuesBase64")
    if not isinstance(values, str) or not values:
        raise ValueError(f"Hole {hole} terrain valuesBase64 is missing")

    return {
        "source": "lidar-dem",
        "sourceResolutionMeters": source_resolution,
        "runtimeSpacingYds": spacing,
        "interpolation": interpolation,
        "minX": grid["minX"],
        "minY": grid["minY"],
        "width": grid["width"],
        "height": grid["height"],
        "elevationOffsetFt": grid["elevationOffsetFt"],
        "nodata": nodata,
        "compression": "deflate",
        "valuesBase64": values,
        **({"note": runtime["note"]} if isinstance(runtime.get("note"), str) else {}),
    }


def validate_coordinate_frame(
    geometry_hole: dict[str, Any],
    terrain_hole: dict[str, Any],
    *,
    hole: int,
    legacy: bool,
) -> None:
    if legacy:
        return
    geometry_origin = (geometry_hole.get("coordinateSystem") or {}).get("origin")
    terrain_origin = (terrain_hole.get("coordinateSystem") or {}).get("origin")
    if not isinstance(terrain_origin, str):
        raise ValueError(f"Hole {hole} generic terrain must declare coordinateSystem.origin")
    if terrain_origin != geometry_origin:
        raise ValueError(
            f"Hole {hole} terrain origin {terrain_origin!r} does not match "
            f"geometry origin {geometry_origin!r}"
        )


def compose(
    geometry: dict[str, Any],
    terrain: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    if geometry.get("schemaVersion") != STATIC_SCHEMA:
        raise ValueError(f"Geometry package must use {STATIC_SCHEMA}")
    course_id = geometry.get("courseId")
    if not isinstance(course_id, str) or not course_id:
        raise ValueError("Geometry package has no courseId")
    geometry_holes = geometry.get("holes")
    if not isinstance(geometry_holes, dict):
        raise ValueError("Geometry package has no holes object")

    terrain_schema = terrain.get("schemaVersion")
    legacy = terrain_schema == LEGACY_GREYWOLF_TERRAIN_SCHEMA
    if terrain_schema not in {TERRAIN_SCHEMA, LEGACY_GREYWOLF_TERRAIN_SCHEMA}:
        raise ValueError(
            f"Terrain package must use {TERRAIN_SCHEMA} "
            f"(or legacy {LEGACY_GREYWOLF_TERRAIN_SCHEMA})"
        )
    if not legacy and terrain.get("courseId") != course_id:
        raise ValueError(
            f"Terrain package courseId {terrain.get('courseId')!r} does not match {course_id!r}"
        )

    terrain_holes = terrain.get("holes")
    if not isinstance(terrain_holes, dict):
        raise ValueError("Terrain package has no holes object")

    output = copy.deepcopy(geometry)
    merged: list[int] = []
    missing: list[int] = []
    for hole in range(1, 19):
        key = str(hole)
        geometry_hole = output["holes"].get(key)
        if not isinstance(geometry_hole, dict):
            raise ValueError(f"Geometry package is missing Hole {hole}")
        terrain_hole = terrain_holes.get(key)
        if terrain_hole is None:
            missing.append(hole)
            continue
        if not isinstance(terrain_hole, dict):
            raise ValueError(f"Hole {hole} terrain entry is malformed")

        validate_coordinate_frame(
            geometry_hole,
            terrain_hole,
            hole=hole,
            legacy=legacy,
        )
        geometry_hole["terrain"] = embedded_terrain(terrain, terrain_hole, hole=hole)
        contours = validate_contours(terrain_hole.get("contours"), hole=hole)
        if contours:
            geometry_hole["contours"] = contours
        merged.append(hole)

    if missing:
        raise ValueError(
            "Terrain package is incomplete; missing holes: "
            + ", ".join(str(hole) for hole in missing)
        )

    output["terrainProvenance"] = {
        "schemaVersion": terrain_schema,
        "source": copy.deepcopy(terrain.get("source")),
        "runtimeTerrain": copy.deepcopy(terrain.get("runtimeTerrain")),
        **(
            {"courseCoordinateSystem": copy.deepcopy(terrain.get("courseCoordinateSystem"))}
            if terrain.get("courseCoordinateSystem") is not None
            else {}
        ),
    }

    report = {
        "schemaVersion": "looper-course-package-compose-report-v1",
        "courseId": course_id,
        "terrainInputSchema": terrain_schema,
        "terrainHoleCount": len(merged),
        "terrainHoles": merged,
        "complete": len(merged) == 18,
    }
    return output, report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--geometry", required=True, type=Path)
    parser.add_argument("--terrain", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    geometry = json.loads(args.geometry.read_text(encoding="utf-8"))
    terrain = json.loads(args.terrain.read_text(encoding="utf-8"))
    output, report = compose(geometry, terrain)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
