#!/usr/bin/env python3
"""Compose Looper static OSM geometry and LiDAR terrain into one runtime package.

Terrain is optional for backward compatibility.  Current-frame terrain can be
composed either as a complete 18-hole package or, with ``--allow-partial``, as a
focused acceptance slice (for example Augusta H1/H6) without disturbing geometry
or existing terrain on the other holes.
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


def frame_origin(hole: dict[str, Any]) -> str | None:
    """Read both the current V5+ coordinateFrame and the legacy coordinateSystem."""
    for key in ("coordinateFrame", "coordinateSystem"):
        frame = hole.get(key)
        if isinstance(frame, dict) and isinstance(frame.get("origin"), str):
            return frame["origin"]
    return None


def validate_coordinate_frame(
    geometry_hole: dict[str, Any],
    terrain_hole: dict[str, Any],
    *,
    hole: int,
    legacy: bool,
) -> None:
    if legacy:
        return
    geometry_origin = frame_origin(geometry_hole)
    terrain_origin = frame_origin(terrain_hole)
    if not isinstance(geometry_origin, str):
        raise ValueError(f"Hole {hole} geometry must declare coordinateFrame/coordinateSystem.origin")
    if not isinstance(terrain_origin, str):
        raise ValueError(f"Hole {hole} generic terrain must declare coordinateFrame/coordinateSystem.origin")
    if terrain_origin != geometry_origin:
        raise ValueError(
            f"Hole {hole} terrain origin {terrain_origin!r} does not match "
            f"geometry origin {geometry_origin!r}"
        )

    # For the current-frame schema, also make sure the terrain was sampled
    # against the exact geometry anchor/heading rather than merely sharing an
    # origin label such as "selected-tee".
    geometry_frame = geometry_hole.get("coordinateFrame")
    terrain_frame = terrain_hole.get("coordinateFrame")
    if isinstance(geometry_frame, dict) and isinstance(terrain_frame, dict):
        g_anchor = geometry_frame.get("anchorLatLon")
        t_anchor = terrain_frame.get("anchorLatLon")
        g_heading = geometry_frame.get("headingDegreesTrue")
        t_heading = terrain_frame.get("headingDegreesTrue")
        if g_anchor != t_anchor:
            raise ValueError(
                f"Hole {hole} terrain anchor {t_anchor!r} does not match geometry anchor {g_anchor!r}"
            )
        if not finite(g_heading) or not finite(t_heading) or abs(float(g_heading) - float(t_heading)) > 1e-6:
            raise ValueError(
                f"Hole {hole} terrain heading {t_heading!r} does not match geometry heading {g_heading!r}"
            )


def compose(
    geometry: dict[str, Any],
    terrain: dict[str, Any],
    *,
    allow_partial: bool = False,
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

    if missing and not allow_partial:
        raise ValueError(
            "Terrain package is incomplete; missing holes: "
            + ", ".join(str(hole) for hole in missing)
        )

    output["terrainProvenance"] = {
        "schemaVersion": terrain_schema,
        "source": copy.deepcopy(terrain.get("source")),
        "runtimeTerrain": copy.deepcopy(terrain.get("runtimeTerrain")),
        "terrainHoles": merged,
        "partial": bool(missing),
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
        "missingTerrainHoles": missing,
        "complete": len(merged) == 18,
        "partialAllowed": allow_partial,
    }
    return output, report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--geometry", required=True, type=Path)
    parser.add_argument("--terrain", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--allow-partial", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    geometry = json.loads(args.geometry.read_text(encoding="utf-8"))
    terrain = json.loads(args.terrain.read_text(encoding="utf-8"))
    output, report = compose(geometry, terrain, allow_partial=args.allow_partial)

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
