#!/usr/bin/env python3
"""Audit coordinate/terrain invariants across a static course-package rebuild.

The main safety property for the V3 -> V5 transition is that topology may change,
and the runtime origin may translate, but the cached LiDAR grid must not rotate,
resample, or otherwise change values. This audit works for both route-start and
already-rebased old packages by comparing old/new anchor offsets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-package", required=True, type=Path)
    parser.add_argument("--new-package", required=True, type=Path)
    parser.add_argument("--tolerance", type=float, default=0.01)
    return parser.parse_args()


def pair(value: Any, default: tuple[float, float] = (0.0, 0.0)) -> tuple[float, float]:
    if isinstance(value, list) and len(value) >= 2:
        x, y = value[0], value[1]
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            return float(x), float(y)
    return default


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def fail(message: str) -> None:
    raise ValueError(message)


def nearly(actual: float, expected: float, tolerance: float, label: str) -> None:
    if abs(actual - expected) > tolerance:
        fail(f"{label}: expected {expected:.6f}, got {actual:.6f}")


def terrain_value_hash(terrain: dict[str, Any]) -> str:
    value = terrain.get("valuesBase64")
    if not isinstance(value, str) or not value:
        fail("terrain valuesBase64 missing")
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def polygon_centroid(points: list[list[float]]) -> tuple[float, float]:
    usable = [point for point in points if isinstance(point, list) and len(point) >= 2 and finite(point[0]) and finite(point[1])]
    if not usable:
        fail("polygon has no finite points")
    return (
        sum(float(point[0]) for point in usable) / len(usable),
        sum(float(point[1]) for point in usable) / len(usable),
    )


def terrain_extent(terrain: dict[str, Any]) -> tuple[float, float, float, float]:
    min_x = terrain.get("minX")
    min_y = terrain.get("minY")
    width = terrain.get("width")
    height = terrain.get("height")
    spacing = terrain.get("runtimeSpacingYds")
    if not all(finite(value) for value in (min_x, min_y, width, height, spacing)):
        fail("terrain extent metadata incomplete")
    max_x = float(min_x) + (int(width) - 1) * float(spacing)
    max_y = float(min_y) + (int(height) - 1) * float(spacing)
    return float(min_x), max_x, float(min_y), max_y


def assert_point_in_terrain(point: tuple[float, float], terrain: dict[str, Any], hole: int, label: str) -> None:
    min_x, max_x, min_y, max_y = terrain_extent(terrain)
    # One grid spacing tolerance allows centroids on the source DEM crop edge.
    tolerance = float(terrain.get("runtimeSpacingYds") or 0.0) + 0.1
    x, y = point
    if x < min_x - tolerance or x > max_x + tolerance or y < min_y - tolerance or y > max_y + tolerance:
        fail(
            f"Hole {hole} {label} {point} is outside terrain extent "
            f"x=[{min_x:.1f},{max_x:.1f}] y=[{min_y:.1f},{max_y:.1f}]"
        )


def main() -> int:
    args = parse_args()
    old_package = json.loads(args.old_package.read_text(encoding="utf-8"))
    new_package = json.loads(args.new_package.read_text(encoding="utf-8"))
    old_holes = old_package.get("holes")
    new_holes = new_package.get("holes")
    if not isinstance(old_holes, dict) or not isinstance(new_holes, dict):
        fail("both packages must contain keyed holes")
    if sorted(map(int, new_holes.keys())) != list(range(1, 19)):
        fail("new package does not contain exactly holes 1-18")

    selected_holes: list[int] = []
    virtual_holes: list[int] = []
    heading_deltas: list[float] = []
    terrain_hashes: list[str] = []

    immutable_terrain_fields = (
        "source",
        "sourceResolutionMeters",
        "runtimeSpacingYds",
        "interpolation",
        "width",
        "height",
        "elevationOffsetFt",
        "nodata",
        "compression",
        "valuesBase64",
    )

    for hole_number in range(1, 19):
        key = str(hole_number)
        old_hole = old_holes.get(key)
        new_hole = new_holes.get(key)
        if not isinstance(old_hole, dict) or not isinstance(new_hole, dict):
            fail(f"Hole {hole_number} missing in old/new package")

        old_frame = old_hole.get("coordinateFrame") or {}
        new_frame = new_hole.get("coordinateFrame") or {}
        if new_frame.get("routeDirection", "as-mapped") != "as-mapped":
            fail(f"Hole {hole_number} changed route orientation; translation-only terrain is unsafe")

        old_offset = pair(old_frame.get("selectedTeeOffsetFromRouteStartYds"))
        new_offset = pair(new_frame.get("selectedTeeOffsetFromRouteStartYds"))
        expected_shift = (old_offset[0] - new_offset[0], old_offset[1] - new_offset[1])

        old_heading = old_frame.get("headingDegreesTrue")
        new_heading = new_frame.get("headingDegreesTrue")
        if finite(old_heading) and finite(new_heading):
            delta = abs(float(new_heading) - float(old_heading)) % 360.0
            delta = min(delta, 360.0 - delta)
            heading_deltas.append(delta)
            if delta > 0.02:
                fail(f"Hole {hole_number} heading changed by {delta:.4f}°")

        old_terrain = old_hole.get("terrain")
        new_terrain = new_hole.get("terrain")
        if not isinstance(old_terrain, dict) or not isinstance(new_terrain, dict):
            fail(f"Hole {hole_number} missing old/new embedded terrain")

        for field in immutable_terrain_fields:
            if old_terrain.get(field) != new_terrain.get(field):
                fail(f"Hole {hole_number} terrain field {field} changed")
        terrain_hashes.append(terrain_value_hash(new_terrain))

        old_min_x = old_terrain.get("minX")
        old_min_y = old_terrain.get("minY")
        new_min_x = new_terrain.get("minX")
        new_min_y = new_terrain.get("minY")
        if not all(finite(value) for value in (old_min_x, old_min_y, new_min_x, new_min_y)):
            fail(f"Hole {hole_number} terrain origin metadata invalid")
        nearly(float(new_min_x), float(old_min_x) + expected_shift[0], args.tolerance, f"Hole {hole_number} terrain minX")
        nearly(float(new_min_y), float(old_min_y) + expected_shift[1], args.tolerance, f"Hole {hole_number} terrain minY")

        origin = new_frame.get("origin")
        method = new_frame.get("teeAnchorMethod")
        surfaces = new_hole.get("surfaces") or {}
        tees = surfaces.get("tee") if isinstance(surfaces, dict) else None
        tee_count = len(tees) if isinstance(tees, list) else 0

        if method == "selected-tee-route-owned":
            selected_holes.append(hole_number)
            if origin != "selected-tee":
                fail(f"Hole {hole_number} selected tee method but origin={origin!r}")
            if tee_count <= 0:
                fail(f"Hole {hole_number} selected tee method but no tee surface")
            tee_centers = [polygon_centroid(poly) for poly in tees if isinstance(poly, list)]
            nearest_center = min(math.hypot(x, y) for x, y in tee_centers)
            if nearest_center > 15.0:
                fail(f"Hole {hole_number} selected tee geometry is {nearest_center:.1f} yd from [0,0]")
        elif method == "route-start-virtual-tee":
            virtual_holes.append(hole_number)
            if origin != "osm-hole-route-start":
                fail(f"Hole {hole_number} virtual tee method but origin={origin!r}")
            if tee_count != 0:
                fail(f"Hole {hole_number} virtual tee unexpectedly packages {tee_count} tee polygons")
        else:
            fail(f"Hole {hole_number} has unknown teeAnchorMethod={method!r}")

        assert_point_in_terrain((0.0, 0.0), new_terrain, hole_number, "runtime origin")
        greens = surfaces.get("green") if isinstance(surfaces, dict) else None
        if not isinstance(greens, list) or not greens:
            fail(f"Hole {hole_number} has no green surface")
        # The runtime loader chooses a green polygon centroid as the pin. Every green
        # polygon centroid should remain inside the carried terrain extent.
        for index, polygon in enumerate(greens):
            if isinstance(polygon, list):
                assert_point_in_terrain(polygon_centroid(polygon), new_terrain, hole_number, f"green centroid {index + 1}")

    print(json.dumps({
        "status": "PASS",
        "holes": 18,
        "selectedTeeHoles": selected_holes,
        "virtualTeeHoles": virtual_holes,
        "maxHeadingDeltaDegrees": round(max(heading_deltas, default=0.0), 6),
        "terrainValuePayloadsUnchanged": len(terrain_hashes) == 18,
        "uniqueTerrainPayloadHashes": len(set(terrain_hashes)),
        "terrainTransform": "translation-only; immutable grid/value fields identical",
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
