#!/usr/bin/env python3
"""Build generic whole-hole runtime terrain from a georeferenced DEM.

The output is ``looper-course-terrain-v1`` and is intended to be composed into
``looper-static-course-package-v1`` by ``compose_course_package.py``. It uses the
same selected-tee-local coordinate frame as course geometry so terrain and
surfaces stay registered without course-specific constants.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import Geod
from rasterio.warp import transform as transform_crs

METERS_TO_YARDS = 1.0936133
NODATA_ENCODED = 65535
DEFAULT_SPACING_YDS = 10.0
GEOD = Geod(ellps="WGS84")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def hole_basis_in_dem_crs(ds: rasterio.DatasetReader, hole: dict[str, Any]):
    frame = hole.get("coordinateFrame") or {}
    anchor_ll = frame.get("anchorLatLon") or frame.get("selectedTeeLatLon")
    heading = frame.get("headingDegreesTrue")
    if not (
        isinstance(anchor_ll, list) and len(anchor_ll) >= 2
        and finite(anchor_ll[0]) and finite(anchor_ll[1])
        and finite(heading)
    ):
        raise ValueError("hole coordinateFrame is missing anchorLatLon/headingDegreesTrue")
    if ds.crs is None:
        raise ValueError("DEM has no CRS")

    anchor_lat = float(anchor_ll[0])
    anchor_lon = float(anchor_ll[1])
    forward_lon, forward_lat, _ = GEOD.fwd(anchor_lon, anchor_lat, float(heading), 20.0)
    xs, ys = transform_crs(
        "EPSG:4326",
        ds.crs,
        [anchor_lon, forward_lon],
        [anchor_lat, forward_lat],
    )
    anchor = np.asarray([xs[0], ys[0]], dtype=float)
    delta = np.asarray([xs[1] - xs[0], ys[1] - ys[0]], dtype=float)
    length = float(np.linalg.norm(delta))
    if length <= 1e-6:
        raise ValueError("projected heading basis is degenerate")
    forward = delta / length
    right = np.asarray([forward[1], -forward[0]], dtype=float)
    return anchor, forward, right


def local_grid_to_pixels(
    ds: rasterio.DatasetReader,
    hole: dict[str, Any],
    xx_yds: np.ndarray,
    yy_yds: np.ndarray,
):
    anchor, forward, right = hole_basis_in_dem_crs(ds, hole)
    x_m = xx_yds / METERS_TO_YARDS
    y_m = yy_yds / METERS_TO_YARDS
    east = anchor[0] + right[0] * x_m + forward[0] * y_m
    north = anchor[1] + right[1] * x_m + forward[1] * y_m
    inv = ~ds.transform
    cols = inv.a * east + inv.b * north + inv.c
    rows = inv.d * east + inv.e * north + inv.f
    return cols, rows


def bilinear_pixels(
    dem: np.ndarray,
    nodata: float | None,
    cols: np.ndarray,
    rows: np.ndarray,
) -> np.ndarray:
    c0 = np.floor(cols).astype(int)
    r0 = np.floor(rows).astype(int)
    dc = cols - c0
    dr = rows - r0
    inside = (
        (r0 >= 0) & (r0 < dem.shape[0] - 1)
        & (c0 >= 0) & (c0 < dem.shape[1] - 1)
    )
    output = np.full(cols.shape, np.nan, dtype=float)
    if not np.any(inside):
        return output
    ri, ci = r0[inside], c0[inside]
    values = np.stack([
        dem[ri, ci],
        dem[ri, ci + 1],
        dem[ri + 1, ci],
        dem[ri + 1, ci + 1],
    ])
    valid = np.all(np.isfinite(values), axis=0)
    if nodata is not None and math.isfinite(nodata):
        valid &= np.all(values != nodata, axis=0)
    sampled = (
        values[0] * (1 - dc[inside]) * (1 - dr[inside])
        + values[1] * dc[inside] * (1 - dr[inside])
        + values[2] * (1 - dc[inside]) * dr[inside]
        + values[3] * dc[inside] * dr[inside]
    )
    partial = np.full(len(ri), np.nan, dtype=float)
    partial[valid] = sampled[valid]
    output[inside] = partial
    return output


def build(
    course_path: Path,
    dem_path: Path,
    source_metadata_path: Path,
    output_path: Path,
    spacing_yds: float,
) -> None:
    course = read_json(course_path)
    source_meta = read_json(source_metadata_path)
    if course.get("schemaVersion") != "looper-static-course-package-v1":
        raise SystemExit(f"Unsupported course package schema: {course.get('schemaVersion')!r}")
    holes = course.get("holes") or {}
    if sorted(int(key) for key in holes) != list(range(1, 19)):
        raise SystemExit("Canonical course package must contain holes 1-18")
    if spacing_yds <= 0 or spacing_yds > 20:
        raise SystemExit("Runtime terrain spacing must be >0 and <=20 yards")

    with rasterio.open(dem_path) as ds:
        if ds.crs is None:
            raise SystemExit("DEM must be georeferenced with a CRS")
        dem = ds.read(1).astype(float)
        nodata = None if ds.nodata is None else float(ds.nodata)

        nominal_resolution = source_meta.get("sourceResolutionMeters")
        if not finite(nominal_resolution) or float(nominal_resolution) <= 0:
            nominal_resolution = max(abs(float(ds.transform.a)), abs(float(ds.transform.e)))

        source = {
            "provider": source_meta.get("provider") or "Configured DEM provider",
            "dataset": source_meta.get("dataset") or "Georeferenced bare-earth DEM",
            "sourceResolutionMeters": round(float(nominal_resolution), 4),
            "sourceUrl": source_meta.get("serviceUrl") or source_meta.get("sourceUrl"),
            "exportUrl": source_meta.get("exportUrl"),
            "crs": str(ds.crs),
            "note": source_meta.get("note"),
        }
        package: dict[str, Any] = {
            "schemaVersion": "looper-course-terrain-v1",
            "courseId": course.get("courseId"),
            "courseName": course.get("courseName"),
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": source,
            "runtimeTerrain": {
                "spacingYds": spacing_yds,
                "interpolation": "bilinear",
                "encoding": "uint16 deci-feet above per-hole offset",
                "nodata": NODATA_ENCODED,
                "note": "Compact whole-hole browser terrain derived from the canonical import DEM.",
            },
            "holes": {},
        }

        for hole_number in range(1, 19):
            hole = holes[str(hole_number)]
            bounds = hole.get("viewBounds") or {}
            if not all(finite(bounds.get(key)) for key in ("minX", "minY", "maxX", "maxY")):
                raise RuntimeError(f"H{hole_number}: missing finite view bounds")
            min_x = math.floor(float(bounds["minX"]) / spacing_yds) * spacing_yds
            min_y = math.floor(float(bounds["minY"]) / spacing_yds) * spacing_yds
            max_x = math.ceil(float(bounds["maxX"]) / spacing_yds) * spacing_yds
            max_y = math.ceil(float(bounds["maxY"]) / spacing_yds) * spacing_yds
            xs = np.arange(min_x, max_x + spacing_yds * 0.25, spacing_yds)
            ys = np.arange(min_y, max_y + spacing_yds * 0.25, spacing_yds)
            xx, yy = np.meshgrid(xs, ys)
            cols, rows = local_grid_to_pixels(ds, hole, xx, yy)
            elevation_ft = bilinear_pixels(dem, nodata, cols, rows) * 3.280839895
            valid = np.isfinite(elevation_ft)
            valid_count = int(valid.sum())
            coverage = valid_count / int(elevation_ft.size)
            if valid_count == 0:
                raise RuntimeError(f"H{hole_number}: no valid DEM samples")
            if coverage < 0.95:
                raise RuntimeError(f"H{hole_number}: DEM coverage only {coverage:.1%}; expected >=95%")

            values = elevation_ft[valid]
            offset = math.floor(float(values.min()) * 10.0) / 10.0
            quantized = np.rint((elevation_ft - offset) * 10.0)
            encoded = np.full(elevation_ft.shape, NODATA_ENCODED, dtype="<u2")
            good = valid & (quantized >= 0) & (quantized < NODATA_ENCODED)
            encoded[good] = quantized[good].astype("<u2")
            compressed = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode("ascii")

            origin = str((hole.get("coordinateFrame") or {}).get("origin") or "")
            if not origin:
                raise RuntimeError(f"H{hole_number}: coordinateFrame.origin is missing")
            package["holes"][str(hole_number)] = {
                "coordinateSystem": {"origin": origin},
                "grid": {
                    "minX": round(float(min_x), 3),
                    "minY": round(float(min_y), 3),
                    "spacingYds": spacing_yds,
                    "width": int(len(xs)),
                    "height": int(len(ys)),
                    "elevationOffsetFt": round(offset, 1),
                    "compression": "deflate",
                    "valuesBase64": compressed,
                },
                "elevationRangeFt": [round(float(values.min()), 1), round(float(values.max()), 1)],
                "validSampleCoverage": round(coverage, 4),
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(package, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({
        "courseId": package["courseId"],
        "schemaVersion": package["schemaVersion"],
        "holes": len(package["holes"]),
        "spacingYds": spacing_yds,
        "source": source,
        "output": str(output_path),
    }, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-package", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--source-metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--spacing-yards", type=float, default=DEFAULT_SPACING_YDS)
    args = parser.parse_args()
    build(args.course_package, args.dem, args.source_metadata, args.output, args.spacing_yards)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
