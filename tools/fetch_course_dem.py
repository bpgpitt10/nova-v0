#!/usr/bin/env python3
"""Fetch one georeferenced DEM covering an entire Looper course package.

The canonical importer owns elevation acquisition. For U.S. courses the default
provider is the USGS 3DEP bare-earth ImageServer. The fetch extent is derived
from every hole's packaged local view bounds so a fresh course import does not
require a hand-authored DEM URL or a second terrain pass.
"""
from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyproj import Transformer

METERS_TO_YARDS = 1.0936133
USGS_3DEP_EXPORT = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/"
    "3DEPElevation/ImageServer/exportImage"
)
DEFAULT_RESOLUTION_METERS = 1.0
DEFAULT_MARGIN_METERS = 40.0
MAX_IMAGE_DIMENSION = 7900


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def course_extent_3857(course: dict[str, Any], margin_meters: float) -> tuple[float, float, float, float]:
    holes = course.get("holes") or {}
    if sorted(int(key) for key in holes) != list(range(1, 19)):
        raise SystemExit("Course package must contain holes 1-18 before DEM acquisition")

    to_web = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    xs: list[float] = []
    ys: list[float] = []

    for hole_number in range(1, 19):
        hole = holes[str(hole_number)]
        frame = hole.get("coordinateFrame") or {}
        anchor_ll = frame.get("anchorLatLon") or frame.get("selectedTeeLatLon")
        heading = frame.get("headingDegreesTrue")
        bounds = hole.get("viewBounds") or {}
        if not (
            isinstance(anchor_ll, list)
            and len(anchor_ll) >= 2
            and finite(anchor_ll[0])
            and finite(anchor_ll[1])
            and finite(heading)
            and all(finite(bounds.get(key)) for key in ("minX", "minY", "maxX", "maxY"))
        ):
            raise SystemExit(f"H{hole_number}: missing geodetic anchor/heading/view bounds for DEM extent")

        anchor_x, anchor_y = to_web.transform(float(anchor_ll[1]), float(anchor_ll[0]))
        radians = math.radians(float(heading))
        forward = (math.sin(radians), math.cos(radians))
        right = (math.cos(radians), -math.sin(radians))

        for local_x in (float(bounds["minX"]), float(bounds["maxX"])):
            for local_y in (float(bounds["minY"]), float(bounds["maxY"])):
                x_m = local_x / METERS_TO_YARDS
                y_m = local_y / METERS_TO_YARDS
                xs.append(anchor_x + right[0] * x_m + forward[0] * y_m)
                ys.append(anchor_y + right[1] * x_m + forward[1] * y_m)

    return (
        min(xs) - margin_meters,
        min(ys) - margin_meters,
        max(xs) + margin_meters,
        max(ys) + margin_meters,
    )


def fetch_usgs_3dep(
    course: dict[str, Any],
    output: Path,
    metadata_path: Path,
    requested_resolution_meters: float,
    margin_meters: float,
) -> None:
    min_x, min_y, max_x, max_y = course_extent_3857(course, margin_meters)
    width_m = max_x - min_x
    height_m = max_y - min_y
    effective_resolution = max(
        requested_resolution_meters,
        width_m / MAX_IMAGE_DIMENSION,
        height_m / MAX_IMAGE_DIMENSION,
    )
    width = max(2, int(math.ceil(width_m / effective_resolution)))
    height = max(2, int(math.ceil(height_m / effective_resolution)))

    params = {
        "bbox": f"{min_x:.3f},{min_y:.3f},{max_x:.3f},{max_y:.3f}",
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "returnSquarePixels": "true",
        "f": "image",
    }
    url = USGS_3DEP_EXPORT + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "LooperCourseImporter/1.0"})
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "")
    except Exception as exc:
        raise SystemExit(f"USGS 3DEP DEM fetch failed: {exc}") from exc

    if len(payload) < 1024:
        preview = payload[:500].decode("utf-8", errors="replace")
        raise SystemExit(f"USGS 3DEP returned an unexpectedly small payload: {preview}")
    if payload[:2] not in {b"II", b"MM"} and "tiff" not in content_type.lower():
        preview = payload[:500].decode("utf-8", errors="replace")
        raise SystemExit(f"USGS 3DEP did not return TIFF data ({content_type}): {preview}")

    output.write_bytes(payload)
    metadata = {
        "schemaVersion": "looper-course-dem-source-v1",
        "courseId": course.get("courseId"),
        "provider": "USGS 3DEP",
        "dataset": "USGS 3DEP Bare Earth DEM Dynamic Service",
        "serviceUrl": "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer",
        "exportUrl": url,
        "crs": "EPSG:3857",
        "requestedResolutionMeters": requested_resolution_meters,
        "exportResolutionMeters": round(effective_resolution, 4),
        "sourceResolutionMeters": round(effective_resolution, 4),
        "bbox3857": [round(min_x, 3), round(min_y, 3), round(max_x, 3), round(max_y, 3)],
        "width": width,
        "height": height,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "note": (
            "Exported from the USGS 3DEP multi-resolution bare-earth service at the requested/runtime pixel size; "
            "the service selects the best available underlying 3DEP source for the location."
        ),
    }
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "courseId": course.get("courseId"),
        "provider": metadata["provider"],
        "output": str(output),
        "bytes": len(payload),
        "width": width,
        "height": height,
        "exportResolutionMeters": metadata["exportResolutionMeters"],
    }, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--provider", default="usgs-3dep", choices=["usgs-3dep"])
    parser.add_argument("--resolution-meters", type=float, default=DEFAULT_RESOLUTION_METERS)
    parser.add_argument("--margin-meters", type=float, default=DEFAULT_MARGIN_METERS)
    args = parser.parse_args()

    if args.resolution_meters <= 0:
        raise SystemExit("--resolution-meters must be positive")
    if args.margin_meters < 0:
        raise SystemExit("--margin-meters must be non-negative")

    course = read_json(args.course_package)
    if course.get("schemaVersion") != "looper-static-course-package-v1":
        raise SystemExit(f"Unsupported course package schema: {course.get('schemaVersion')!r}")

    fetch_usgs_3dep(
        course,
        args.output,
        args.metadata,
        args.resolution_meters,
        args.margin_meters,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
