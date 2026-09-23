#!/usr/bin/env python3
"""Regression tests for current-frame terrain sampling/composition."""
from __future__ import annotations

import json

import numpy as np

import import_course_terrain_v3 as terrain
import compose_course_package as compose


def assert_close(actual: float, expected: float, tolerance: float, label: str) -> None:
    if abs(actual - expected) > tolerance:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")


def test_current_frame_axes() -> None:
    # At heading 0, +y is north and +x is east.
    anchor_lat, anchor_lon = 33.5, -82.0
    lon, lat = terrain.local_xy_to_lon_lat(
        np.array([0.0, 100.0, 0.0]),
        np.array([0.0, 0.0, 100.0]),
        anchor_lat=anchor_lat,
        anchor_lon=anchor_lon,
        heading_degrees=0.0,
    )
    assert_close(float(lon[0]), anchor_lon, 1e-10, "origin longitude")
    assert_close(float(lat[0]), anchor_lat, 1e-10, "origin latitude")
    if not lon[1] > anchor_lon:
        raise AssertionError("+x/right did not move east at heading 0")
    if not lat[2] > anchor_lat:
        raise AssertionError("+y/forward did not move north at heading 0")

    # At heading 90, +y is east and +x is south.
    lon, lat = terrain.local_xy_to_lon_lat(
        np.array([0.0, 100.0]),
        np.array([100.0, 0.0]),
        anchor_lat=anchor_lat,
        anchor_lon=anchor_lon,
        heading_degrees=90.0,
    )
    if not lon[0] > anchor_lon:
        raise AssertionError("+y/forward did not move east at heading 90")
    if not lat[1] < anchor_lat:
        raise AssertionError("+x/right did not move south at heading 90")


def synthetic_geometry() -> dict:
    holes = {}
    for number in range(1, 19):
        holes[str(number)] = {
            "hole": number,
            "coordinateFrame": {
                "origin": "selected-tee",
                "anchorLatLon": [33.5 + number / 10000.0, -82.0],
                "headingDegreesTrue": 15.0,
            },
            "viewBounds": {"minX": -20.0, "minY": -20.0, "maxX": 100.0, "maxY": 500.0},
            "surfaces": {},
            "context": {},
        }
    return {
        "schemaVersion": "looper-static-course-package-v1",
        "courseId": "test-course",
        "holes": holes,
    }


def terrain_hole(number: int, geometry: dict) -> dict:
    frame = geometry["holes"][str(number)]["coordinateFrame"]
    return {
        "coordinateFrame": dict(frame),
        "grid": {
            "minX": -20.0,
            "minY": -20.0,
            "spacingYds": 10.0,
            "width": 2,
            "height": 2,
            "elevationOffsetFt": 100.0,
            "compression": "deflate",
            "valuesBase64": "eJxjYGBgAAAABAAB",
        },
    }


def test_partial_compose_and_frame_guard() -> None:
    geometry = synthetic_geometry()
    package = {
        "schemaVersion": "looper-course-terrain-v1",
        "courseId": "test-course",
        "source": {
            "provider": "usgs-3dep-1m",
            "dataset": "test",
            "sourceResolutionMeters": 1.0,
        },
        "runtimeTerrain": {
            "spacingYds": 10.0,
            "interpolation": "bilinear",
            "nodata": 65535,
        },
        "holes": {
            "1": terrain_hole(1, geometry),
            "6": terrain_hole(6, geometry),
        },
    }
    output, report = compose.compose(geometry, package, allow_partial=True)
    if report["terrainHoles"] != [1, 6] or report["complete"]:
        raise AssertionError(f"unexpected partial compose report: {report}")
    if "terrain" not in output["holes"]["1"] or "terrain" not in output["holes"]["6"]:
        raise AssertionError("H1/H6 terrain was not embedded")
    if "terrain" in output["holes"]["2"]:
        raise AssertionError("partial compose unexpectedly added H2 terrain")

    broken = json.loads(json.dumps(package))
    broken["holes"]["1"]["coordinateFrame"]["anchorLatLon"][0] += 0.001
    try:
        compose.compose(geometry, broken, allow_partial=True)
    except ValueError as exc:
        if "anchor" not in str(exc):
            raise
    else:
        raise AssertionError("frame guard accepted mismatched terrain anchor")


def main() -> int:
    test_current_frame_axes()
    test_partial_compose_and_frame_guard()
    print("Current-frame terrain axes, partial compose, and frame guard: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
