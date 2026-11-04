#!/usr/bin/env python3
"""Acquire one georeferenced DEM covering an entire Looper course package.

This is the terrain-provider seam for the canonical course importer. Runtime
terrain/green builders consume the same normalized GeoTIFF regardless of where
it came from.

Supported sources:
- ``usgs-3dep``: automatic U.S. bare-earth acquisition from the National Map.
- ``geotiff-url``: any directly downloadable georeferenced GeoTIFF.
- ``geotiff-file``: an already available georeferenced GeoTIFF.

Provider-specific acquisition stops here. No downstream Looper code is allowed
to know which provider supplied a course.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import time
import urllib.error
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


DEM_FETCH_ATTEMPTS = 4
DEM_RETRY_WAIT_S = 20.0


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_tiff_payload(payload: bytes, label: str, content_type: str = "") -> None:
    if len(payload) < 1024:
        preview = payload[:500].decode("utf-8", errors="replace")
        raise SystemExit(f"{label} returned an unexpectedly small payload: {preview}")
    if payload[:2] not in {b"II", b"MM"} and "tiff" not in content_type.lower():
        preview = payload[:500].decode("utf-8", errors="replace")
        raise SystemExit(f"{label} did not return TIFF data ({content_type}): {preview}")


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


def write_metadata(metadata_path: Path, metadata: dict[str, Any]) -> None:
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
    # USGS's export service has brief outages (Wynn, 11/3: 502 Bad Gateway).
    # Retry server-side errors and timeouts a few times before giving up.
    payload, content_type = b"", ""
    for attempt in range(1, DEM_FETCH_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = response.read()
                content_type = response.headers.get("Content-Type", "")
            break
        except Exception as exc:
            retryable = not isinstance(exc, urllib.error.HTTPError) or exc.code >= 500 or exc.code == 429
            if not retryable or attempt == DEM_FETCH_ATTEMPTS:
                raise SystemExit(f"USGS 3DEP DEM fetch failed after {attempt} tries: {exc}") from exc
            wait = DEM_RETRY_WAIT_S * attempt
            print(f"USGS 3DEP DEM fetch failed ({exc}); retrying in {wait:.0f} s", flush=True)
            time.sleep(wait)

    validate_tiff_payload(payload, "USGS 3DEP", content_type)
    output.write_bytes(payload)
    metadata = {
        "schemaVersion": "looper-course-dem-source-v1",
        "courseId": course.get("courseId"),
        "provider": "USGS 3DEP",
        "providerKey": "usgs-3dep",
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
        "fetchedAt": now_iso(),
        "note": (
            "Exported from the USGS 3DEP multi-resolution bare-earth service at the requested/runtime pixel size; "
            "the service selects the best available underlying 3DEP source for the location."
        ),
    }
    write_metadata(metadata_path, metadata)
    print(json.dumps({
        "courseId": course.get("courseId"),
        "provider": metadata["provider"],
        "output": str(output),
        "bytes": len(payload),
        "width": width,
        "height": height,
        "exportResolutionMeters": metadata["exportResolutionMeters"],
    }, indent=2, sort_keys=True))


def fetch_geotiff_url(
    course: dict[str, Any],
    output: Path,
    metadata_path: Path,
    source_url: str,
    source_resolution_meters: float,
    dataset_name: str | None,
) -> None:
    request = urllib.request.Request(source_url, headers={"User-Agent": "LooperCourseImporter/1.0"})
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "")
    except Exception as exc:
        raise SystemExit(f"Configured GeoTIFF DEM fetch failed: {exc}") from exc
    validate_tiff_payload(payload, "Configured GeoTIFF DEM", content_type)
    output.write_bytes(payload)
    write_metadata(metadata_path, {
        "schemaVersion": "looper-course-dem-source-v1",
        "courseId": course.get("courseId"),
        "provider": "Configured GeoTIFF URL",
        "providerKey": "geotiff-url",
        "dataset": dataset_name or "Configured georeferenced DEM",
        "sourceUrl": source_url,
        "exportUrl": source_url,
        "sourceResolutionMeters": source_resolution_meters,
        "fetchedAt": now_iso(),
        "note": "Provider-neutral DEM acquired through the canonical Looper terrain-provider seam.",
    })
    print(json.dumps({
        "courseId": course.get("courseId"),
        "provider": "Configured GeoTIFF URL",
        "output": str(output),
        "bytes": len(payload),
        "sourceResolutionMeters": source_resolution_meters,
    }, indent=2, sort_keys=True))


def fetch_geotiff_file(
    course: dict[str, Any],
    output: Path,
    metadata_path: Path,
    source_file: Path,
    source_resolution_meters: float,
    dataset_name: str | None,
) -> None:
    if not source_file.exists() or not source_file.is_file():
        raise SystemExit(f"Configured DEM file does not exist: {source_file}")
    with source_file.open("rb") as handle:
        header = handle.read(4)
    if header[:2] not in {b"II", b"MM"}:
        raise SystemExit(f"Configured DEM file is not a TIFF: {source_file}")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_file, output)
    write_metadata(metadata_path, {
        "schemaVersion": "looper-course-dem-source-v1",
        "courseId": course.get("courseId"),
        "provider": "Configured GeoTIFF File",
        "providerKey": "geotiff-file",
        "dataset": dataset_name or "Configured georeferenced DEM",
        "sourceFile": str(source_file),
        "sourceResolutionMeters": source_resolution_meters,
        "fetchedAt": now_iso(),
        "note": "Provider-neutral DEM supplied through the canonical Looper terrain-provider seam.",
    })
    print(json.dumps({
        "courseId": course.get("courseId"),
        "provider": "Configured GeoTIFF File",
        "output": str(output),
        "bytes": output.stat().st_size,
        "sourceResolutionMeters": source_resolution_meters,
    }, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--provider", default="usgs-3dep", choices=["usgs-3dep", "geotiff-url", "geotiff-file"])
    parser.add_argument("--resolution-meters", type=float, default=DEFAULT_RESOLUTION_METERS)
    parser.add_argument("--margin-meters", type=float, default=DEFAULT_MARGIN_METERS)
    parser.add_argument("--source-url")
    parser.add_argument("--source-file", type=Path)
    parser.add_argument("--source-resolution-meters", type=float)
    parser.add_argument("--dataset-name")
    args = parser.parse_args()

    if args.resolution_meters <= 0:
        raise SystemExit("--resolution-meters must be positive")
    if args.margin_meters < 0:
        raise SystemExit("--margin-meters must be non-negative")

    course = read_json(args.course_package)
    if course.get("schemaVersion") != "looper-static-course-package-v1":
        raise SystemExit(f"Unsupported course package schema: {course.get('schemaVersion')!r}")

    if args.provider == "usgs-3dep":
        fetch_usgs_3dep(course, args.output, args.metadata, args.resolution_meters, args.margin_meters)
    elif args.provider == "geotiff-url":
        if not args.source_url:
            raise SystemExit("--provider geotiff-url requires --source-url")
        if not finite(args.source_resolution_meters) or float(args.source_resolution_meters) <= 0:
            raise SystemExit("--provider geotiff-url requires positive --source-resolution-meters")
        fetch_geotiff_url(
            course,
            args.output,
            args.metadata,
            args.source_url,
            float(args.source_resolution_meters),
            args.dataset_name,
        )
    else:
        if args.source_file is None:
            raise SystemExit("--provider geotiff-file requires --source-file")
        if not finite(args.source_resolution_meters) or float(args.source_resolution_meters) <= 0:
            raise SystemExit("--provider geotiff-file requires positive --source-resolution-meters")
        fetch_geotiff_file(
            course,
            args.output,
            args.metadata,
            args.source_file,
            float(args.source_resolution_meters),
            args.dataset_name,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
