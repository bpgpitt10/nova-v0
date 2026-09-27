#!/usr/bin/env python3
"""Build Looper's high-resolution green-detail sidecar from a georeferenced DEM.

The canonical course package already defines each hole in selected-tee-local yards
and includes WGS84 tee/green anchors. This compiler uses those anchors to project
that local frame directly into the DEM CRS, samples only a small green+apron box,
and emits the same compact 1 yd / 3x3 tactical contract used by Live Caddie.

It intentionally does not discover elevation data. Course config/workflows must
provide a trusted georeferenced GeoTIFF/COG (local file or downloaded asset).
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
from rasterio.warp import transform as transform_crs

METERS_TO_YARDS = 1.0936133
NODATA_ENCODED = 65535
DEFAULT_SPACING_YDS = 1.0
DEFAULT_MARGIN_YDS = 12.0


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def polygon_area(points: list[list[float]]) -> float:
    if len(points) < 3:
        return 0.0
    total = 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        total += float(a[0]) * float(b[1]) - float(b[0]) * float(a[1])
    return abs(total) / 2.0


def target_green_polygon(hole: dict[str, Any]) -> np.ndarray:
    surfaces = hole.get("surfaces") or {}
    polygons = surfaces.get("green") or []
    candidates: list[list[list[float]]] = []
    for polygon in polygons:
        points = []
        for point in polygon or []:
            if (
                isinstance(point, (list, tuple))
                and len(point) >= 2
                and isinstance(point[0], (int, float))
                and isinstance(point[1], (int, float))
            ):
                points.append([float(point[0]), float(point[1])])
        if len(points) >= 3:
            candidates.append(points)
    if not candidates:
        raise ValueError("hole has no usable target-green polygon")
    # Canonical packages normally contain one target green. Largest-area wins if
    # topology repair leaves multiple pieces.
    return np.asarray(max(candidates, key=polygon_area), dtype=float)


def points_inside_polygon(xx: np.ndarray, yy: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    inside = np.zeros(xx.shape, dtype=bool)
    xj, yj = polygon[-1]
    for xi, yi in polygon:
        crosses = (yi > yy) != (yj > yy)
        x_at_y = (xj - xi) * (yy - yi) / ((yj - yi) + 1e-12) + xi
        inside ^= crosses & (xx < x_at_y)
        xj, yj = xi, yi
    return inside


def hole_basis_in_dem_crs(ds: rasterio.DatasetReader, hole: dict[str, Any]):
    frame = hole.get("coordinateFrame") or {}
    tee_ll = frame.get("selectedTeeLatLon")
    green_ll = frame.get("targetGreenLatLon")
    if not (
        isinstance(tee_ll, list) and len(tee_ll) >= 2
        and isinstance(green_ll, list) and len(green_ll) >= 2
    ):
        raise ValueError("hole coordinateFrame is missing selectedTeeLatLon/targetGreenLatLon")
    if ds.crs is None:
        raise ValueError("DEM has no CRS")
    xs, ys = transform_crs(
        "EPSG:4326",
        ds.crs,
        [float(tee_ll[1]), float(green_ll[1])],
        [float(tee_ll[0]), float(green_ll[0])],
    )
    tee = np.asarray([xs[0], ys[0]], dtype=float)
    green = np.asarray([xs[1], ys[1]], dtype=float)
    delta = green - tee
    length = float(np.linalg.norm(delta))
    if length <= 1e-6:
        raise ValueError("tee/green projected anchors are degenerate")
    forward = delta / length
    right = np.asarray([forward[1], -forward[0]], dtype=float)
    return tee, forward, right


def local_grid_to_dem_pixels(
    ds: rasterio.DatasetReader,
    hole: dict[str, Any],
    xx_yds: np.ndarray,
    yy_yds: np.ndarray,
):
    tee, forward, right = hole_basis_in_dem_crs(ds, hole)
    x_m = xx_yds / METERS_TO_YARDS
    y_m = yy_yds / METERS_TO_YARDS
    east = tee[0] + right[0] * x_m + forward[0] * y_m
    north = tee[1] + right[1] * x_m + forward[1] * y_m
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


def plane_summary(x: np.ndarray, y: np.ndarray, z_ft: np.ndarray):
    good = np.isfinite(x) & np.isfinite(y) & np.isfinite(z_ft)
    if int(good.sum()) < 4:
        return None
    gx, gy, gz = x[good], y[good], z_ft[good]
    design = np.column_stack([gx, gy, np.ones(len(gx))])
    a, b, _ = np.linalg.lstsq(design, gz, rcond=None)[0]
    slope_percent = math.hypot(float(a), float(b)) / 3.0 * 100.0
    downhill = np.asarray([-float(a), -float(b)], dtype=float)
    norm = float(np.linalg.norm(downhill))
    if norm > 1e-9:
        downhill /= norm
        bearing = (math.degrees(math.atan2(float(downhill[0]), float(downhill[1]))) + 360) % 360
    else:
        downhill[:] = 0
        bearing = 0.0
    return {
        "sampleCount": int(good.sum()),
        "meanElevationFt": round(float(np.mean(gz)), 2),
        "minElevationFt": round(float(np.min(gz)), 2),
        "maxElevationFt": round(float(np.max(gz)), 2),
        "elevationRangeFt": round(float(np.max(gz) - np.min(gz)), 2),
        "planeSlopePercent": round(slope_percent, 2),
        "downhillLocalUnit": [round(float(downhill[0]), 4), round(float(downhill[1]), 4)],
        "downhillBearingDeg": round(bearing, 1),
    }


def sector_summaries(
    xx: np.ndarray,
    yy: np.ndarray,
    elevation_ft: np.ndarray,
    green_mask: np.ndarray,
    bounds: tuple[float, float, float, float],
    overall_mean_ft: float,
):
    min_x, max_x, min_y, max_y = bounds
    x_edges = np.linspace(min_x, max_x, 4)
    y_edges = np.linspace(min_y, max_y, 4)
    rows = ("front", "middle", "back")
    columns = ("left", "center", "right")
    output = []
    for row in range(3):
        for column in range(3):
            x0, x1 = x_edges[column], x_edges[column + 1]
            y0, y1 = y_edges[row], y_edges[row + 1]
            x_ok = (xx >= x0) & ((xx <= x1) if column == 2 else (xx < x1))
            y_ok = (yy >= y0) & ((yy <= y1) if row == 2 else (yy < y1))
            mask = green_mask & x_ok & y_ok & np.isfinite(elevation_ft)
            summary = plane_summary(xx[mask], yy[mask], elevation_ft[mask])
            item: dict[str, Any] = {
                "id": f"{rows[row]}-{columns[column]}",
                "row": rows[row],
                "column": columns[column],
                "boundsYds": [round(float(x0), 1), round(float(x1), 1), round(float(y0), 1), round(float(y1), 1)],
            }
            if summary:
                item.update(summary)
                item["deltaFromGreenMeanFt"] = round(summary["meanElevationFt"] - overall_mean_ft, 2)
            else:
                item["sampleCount"] = 0
            output.append(item)
    return output


def build(
    course_path: Path,
    dem_path: Path,
    output_path: Path,
    spacing_yds: float,
    margin_yds: float,
    dataset_name: str,
    source_url: str | None,
    source_resolution_meters: float | None,
):
    course = read_json(course_path)
    if course.get("schemaVersion") != "looper-static-course-package-v1":
        raise SystemExit(f"Unsupported course package schema: {course.get('schemaVersion')!r}")
    holes = course.get("holes") or {}
    if sorted(int(key) for key in holes) != list(range(1, 19)):
        raise SystemExit("Canonical course package must contain holes 1-18")
    if spacing_yds <= 0 or spacing_yds > 2:
        raise SystemExit("Green detail spacing must be >0 and <=2 yards")
    if margin_yds < 0 or margin_yds > 30:
        raise SystemExit("Green detail margin must be between 0 and 30 yards")

    with rasterio.open(dem_path) as ds:
        dem = ds.read(1).astype(float)
        nodata = None if ds.nodata is None else float(ds.nodata)
        if ds.crs is None:
            raise SystemExit("DEM must be georeferenced with a CRS")
        package: dict[str, Any] = {
            "schemaVersion": "looper-course-green-detail-v1",
            "courseId": course.get("courseId"),
            "courseName": course.get("courseName"),
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": {
                "dataset": dataset_name,
                "tile": dem_path.name,
                "crs": str(ds.crs),
                "sourceResolutionMeters": source_resolution_meters,
                "sourceUrl": source_url,
            },
            "runtimeTerrain": {
                "spacingYds": spacing_yds,
                "marginYds": margin_yds,
                "interpolation": "bilinear",
                "encoding": "uint16 deci-feet above per-hole offset",
                "nodata": NODATA_ENCODED,
            },
            "tacticalSummary": {
                "layout": "3x3 green bounding-box sectors",
                "rows": ["front", "middle", "back"],
                "columns": ["left", "center", "right"],
                "downhillBearingContract": "0=hole-forward, 90=right, 180=back toward tee, 270=left",
                "note": "Broad landing/roll context only; not a putting-break model.",
            },
            "holes": {},
        }

        for hole_number in range(1, 19):
            hole = holes[str(hole_number)]
            polygon = target_green_polygon(hole)
            green_min_x, green_min_y = np.min(polygon, axis=0)
            green_max_x, green_max_y = np.max(polygon, axis=0)
            min_x = math.floor(float(green_min_x - margin_yds) / spacing_yds) * spacing_yds
            max_x = math.ceil(float(green_max_x + margin_yds) / spacing_yds) * spacing_yds
            min_y = math.floor(float(green_min_y - margin_yds) / spacing_yds) * spacing_yds
            max_y = math.ceil(float(green_max_y + margin_yds) / spacing_yds) * spacing_yds
            xs = np.arange(min_x, max_x + spacing_yds * 0.25, spacing_yds)
            ys = np.arange(min_y, max_y + spacing_yds * 0.25, spacing_yds)
            xx, yy = np.meshgrid(xs, ys)
            cols, rows = local_grid_to_dem_pixels(ds, hole, xx, yy)
            elevation_ft = bilinear_pixels(dem, nodata, cols, rows) * 3.280839895
            finite = elevation_ft[np.isfinite(elevation_ft)]
            if finite.size == 0:
                raise RuntimeError(f"H{hole_number}: no valid DEM samples around green")

            green_mask = points_inside_polygon(xx, yy, polygon) & np.isfinite(elevation_ft)
            overall = plane_summary(xx[green_mask], yy[green_mask], elevation_ft[green_mask])
            if not overall:
                raise RuntimeError(f"H{hole_number}: target green has too few valid DEM samples")

            offset = math.floor(float(finite.min()) * 10) / 10
            quantized = np.rint((elevation_ft - offset) * 10)
            encoded = np.full(elevation_ft.shape, NODATA_ENCODED, dtype="<u2")
            valid = np.isfinite(elevation_ft) & (quantized >= 0) & (quantized < NODATA_ENCODED)
            encoded[valid] = quantized[valid].astype("<u2")
            compressed = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode("ascii")
            green_bounds = (
                float(green_min_x), float(green_max_x),
                float(green_min_y), float(green_max_y),
            )
            sectors = sector_summaries(
                xx, yy, elevation_ft, green_mask, green_bounds, float(overall["meanElevationFt"])
            )
            package["holes"][str(hole_number)] = {
                "greenBoundsYds": [round(value, 1) for value in green_bounds],
                "greenSampleCount": int(green_mask.sum()),
                "greenSummary": overall,
                "sectors": sectors,
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
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(package, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {output_path} ({output_path.stat().st_size:,} bytes)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-package", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--spacing-yards", type=float, default=DEFAULT_SPACING_YDS)
    parser.add_argument("--margin-yards", type=float, default=DEFAULT_MARGIN_YDS)
    parser.add_argument("--dataset-name", default="Configured high-resolution bare-earth DEM")
    parser.add_argument("--source-url")
    parser.add_argument("--source-resolution-meters", type=float)
    args = parser.parse_args()
    build(
        args.course_package,
        args.dem,
        args.output,
        args.spacing_yards,
        args.margin_yards,
        args.dataset_name,
        args.source_url,
        args.source_resolution_meters,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
