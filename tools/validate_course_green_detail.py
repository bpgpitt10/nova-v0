#!/usr/bin/env python3
"""Validate a Looper high-resolution green-detail sidecar.

This validator is intentionally producer-independent. A course may generate the
asset from any trusted DEM source, or carry forward a previously validated asset,
but promotion must preserve the same runtime contract.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any

SUPPORTED_SCHEMAS = {
    "looper-course-green-detail-v1",
    "looper-greywolf-green-detail-v1",  # backward-compatible prototype
}
NODATA_DEFAULT = 65535
EXPECTED_SECTORS = {
    "front-left", "front-center", "front-right",
    "middle-left", "middle-center", "middle-right",
    "back-left", "back-center", "back-right",
}


def fail(message: str) -> None:
    raise SystemExit(message)


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def validate_grid(hole_number: int, raw: dict[str, Any], package_nodata: int) -> list[str]:
    errors: list[str] = []
    grid = raw.get("grid") or {}
    spacing = grid.get("spacingYds")
    width = grid.get("width")
    height = grid.get("height")
    offset = grid.get("elevationOffsetFt")
    if not finite_number(spacing) or float(spacing) <= 0 or float(spacing) > 2:
        errors.append(f"H{hole_number}: grid spacing must be >0 and <=2 yd")
    if not isinstance(width, int) or width < 2 or not isinstance(height, int) or height < 2:
        errors.append(f"H{hole_number}: grid dimensions must both be >=2")
    if not finite_number(offset):
        errors.append(f"H{hole_number}: elevationOffsetFt is missing/non-finite")
    if grid.get("compression") != "deflate":
        errors.append(f"H{hole_number}: unsupported compression {grid.get('compression')!r}")
    encoded = grid.get("valuesBase64")
    if not isinstance(encoded, str) or not encoded:
        errors.append(f"H{hole_number}: valuesBase64 is missing")
        return errors
    if isinstance(width, int) and isinstance(height, int) and width >= 2 and height >= 2:
        try:
            payload = zlib.decompress(base64.b64decode(encoded))
            expected = width * height * 2
            if len(payload) != expected:
                errors.append(f"H{hole_number}: decoded grid is {len(payload)} bytes; expected {expected}")
            else:
                values = struct.unpack(f"<{width * height}H", payload)
                valid_count = sum(1 for value in values if value != package_nodata)
                if valid_count == 0:
                    errors.append(f"H{hole_number}: grid contains no valid terrain samples")
        except Exception as exc:
            errors.append(f"H{hole_number}: cannot decode terrain grid: {exc}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--course-package", type=Path)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    green = json.loads(args.package.read_text(encoding="utf-8"))
    schema = green.get("schemaVersion")
    if schema not in SUPPORTED_SCHEMAS:
        fail(f"Unsupported green-detail schema: {schema!r}")

    course = None
    if args.course_package:
        course = json.loads(args.course_package.read_text(encoding="utf-8"))
        if course.get("schemaVersion") != "looper-static-course-package-v1":
            fail(f"Unsupported course package schema: {course.get('schemaVersion')!r}")
        green_course_id = green.get("courseId")
        if green_course_id and green_course_id != course.get("courseId"):
            fail(
                f"Green-detail courseId {green_course_id!r} does not match course package "
                f"{course.get('courseId')!r}"
            )

    runtime = green.get("runtimeTerrain") or {}
    spacing = runtime.get("spacingYds")
    margin = runtime.get("marginYds")
    nodata = int(runtime.get("nodata", NODATA_DEFAULT))
    errors: list[str] = []
    warnings: list[str] = []
    if not finite_number(spacing) or float(spacing) <= 0 or float(spacing) > 2:
        errors.append("runtimeTerrain.spacingYds must be >0 and <=2")
    if not finite_number(margin) or float(margin) < 0:
        errors.append("runtimeTerrain.marginYds must be >=0")
    if runtime.get("encoding") != "uint16 deci-feet above per-hole offset":
        errors.append(f"unsupported terrain encoding: {runtime.get('encoding')!r}")

    holes = green.get("holes")
    if not isinstance(holes, dict):
        fail("green-detail package has no holes object")
    expected_holes = set(str(number) for number in range(1, 19))
    if set(holes) != expected_holes:
        errors.append(f"green-detail holes must be exactly 1-18; got {sorted(holes)}")

    course_holes = (course or {}).get("holes") or {}
    for hole_number in range(1, 19):
        raw = holes.get(str(hole_number))
        if not isinstance(raw, dict):
            continue
        sample_count = raw.get("greenSampleCount")
        if not isinstance(sample_count, int) or sample_count < 4:
            errors.append(f"H{hole_number}: greenSampleCount must be >=4")
        summary = raw.get("greenSummary") or {}
        for key in ("meanElevationFt", "minElevationFt", "maxElevationFt", "elevationRangeFt", "planeSlopePercent"):
            if not finite_number(summary.get(key)):
                errors.append(f"H{hole_number}: greenSummary.{key} is missing/non-finite")
        sectors = raw.get("sectors")
        if not isinstance(sectors, list) or len(sectors) != 9:
            errors.append(f"H{hole_number}: expected exactly 9 tactical sectors")
        else:
            ids = {str(item.get("id")) for item in sectors if isinstance(item, dict)}
            if ids != EXPECTED_SECTORS:
                errors.append(f"H{hole_number}: tactical sector IDs do not match 3x3 contract")
            populated = sum(
                1 for item in sectors
                if isinstance(item, dict) and isinstance(item.get("sampleCount"), int) and item["sampleCount"] > 0
            )
            if populated < 7:
                warnings.append(f"H{hole_number}: only {populated}/9 tactical sectors have green samples")
        errors.extend(validate_grid(hole_number, raw, nodata))

        if course_holes:
            course_hole = course_holes.get(str(hole_number)) or {}
            greens = ((course_hole.get("surfaces") or {}).get("green") or [])
            if not greens:
                errors.append(f"H{hole_number}: course package has no green polygon")
            frame = course_hole.get("coordinateFrame") or {}
            if not frame.get("selectedTeeLatLon") or not frame.get("targetGreenLatLon"):
                errors.append(f"H{hole_number}: course package is missing tee/green geodetic anchors")

    print(json.dumps({
        "schemaVersion": schema,
        "courseId": green.get("courseId"),
        "holeCount": len(holes),
        "spacingYds": spacing,
        "marginYds": margin,
        "warnings": warnings,
        "errors": errors,
    }, indent=2))
    if errors:
        return 1
    if args.strict and warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
