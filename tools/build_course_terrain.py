#!/usr/bin/env python3
"""Build cached Looper terrain packages from official bare-earth elevation services.

The compiler is course-generic. OSM golf=hole routes define the exact same
hole-local frame used by the static geometry compiler. Provider adapters only
acquire a bounded official DEM raster; every provider is normalized into the
same compact browser terrain package.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import tempfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

import build_osm_course_package as base
import build_osm_course_package_v2 as v2
import build_osm_course_package_v3 as v3

METERS_TO_YARDS = 1.0936132983377078
YARDS_TO_METERS = 1.0 / METERS_TO_YARDS
EARTH_RADIUS_M = 6_371_008.8
NODATA_ENCODED = 65535
DEFAULT_RUNTIME_SPACING_YDS = 10.0
DEFAULT_SOURCE_RESOLUTION_M = 2.0
DEFAULT_SOURCE_PADDING_M = 300.0
MIN_HOLE_GRID_COVERAGE = 0.50

USGS_IMAGE_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
NRCAN_WCS = "https://datacube.services.geo.ca/ows/elevation"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def course_latlon_bounds(hole_routes: dict[int, dict[str, Any]]) -> tuple[float, float, float, float]:
    points = [point for record in hole_routes.values() for point in record["geometry"]]
    if not points:
        raise ValueError("No OSM hole-route coordinates available for terrain bounds")
    lats = [point[0] for point in points]
    lons = [point[1] for point in points]
    return min(lons), min(lats), max(lons), max(lats)


def projected_bounds(
    lonlat_bounds: tuple[float, float, float, float],
    epsg: int,
    padding_m: float,
) -> tuple[float, float, float, float]:
    min_lon, min_lat, max_lon, max_lat = lonlat_bounds
    transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    corners = [
        transformer.transform(min_lon, min_lat),
        transformer.transform(min_lon, max_lat),
        transformer.transform(max_lon, min_lat),
        transformer.transform(max_lon, max_lat),
    ]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    return min(xs) - padding_m, min(ys) - padding_m, max(xs) + padding_m, max(ys) + padding_m


def fetch_usgs_3dep(
    lonlat_bounds: tuple[float, float, float, float],
    resolution_m: float,
    padding_m: float,
) -> tuple[bytes, dict[str, Any]]:
    bbox = projected_bounds(lonlat_bounds, 3857, padding_m)
    width = max(2, math.ceil((bbox[2] - bbox[0]) / resolution_m))
    height = max(2, math.ceil((bbox[3] - bbox[1]) / resolution_m))
    if width > 8000 or height > 8000:
        raise ValueError(f"USGS extraction would exceed service limits: {width}x{height}")

    params = {
        "bbox": ",".join(f"{value:.3f}" for value in bbox),
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "renderingRule": json.dumps({"rasterFunction": "None"}, separators=(",", ":")),
        "f": "image",
    }
    url = f"{USGS_IMAGE_SERVICE}/exportImage"
    response = requests.get(url, params=params, timeout=180)
    response.raise_for_status()
    payload = response.content
    if len(payload) < 1024:
        raise ValueError(f"USGS terrain response was unexpectedly small ({len(payload)} bytes)")

    return payload, {
        "provider": "usgs-3dep",
        "dataset": "USGS 3DEP Bare Earth DEM Dynamic service",
        "sourceClass": "bare-earth-dem-best-available-3dep",
        "sourceUrl": USGS_IMAGE_SERVICE,
        "license": "U.S. Geological Survey public-domain data",
        "verticalDatum": "3DEP service vertical datum varies by source mosaic; elevations are service orthometric heights",
        "requestCrs": "EPSG:3857",
        "requestBounds": [round(value, 3) for value in bbox],
        "requestSize": [width, height],
        "extractionResolutionMeters": resolution_m,
    }


def fetch_nrcan_hrdem(
    lonlat_bounds: tuple[float, float, float, float],
    resolution_m: float,
    padding_m: float,
) -> tuple[bytes, dict[str, Any]]:
    bbox = projected_bounds(lonlat_bounds, 3979, padding_m)
    params = {
        "SERVICE": "WCS",
        "VERSION": "1.1.1",
        "REQUEST": "GetCoverage",
        "FORMAT": "image/geotiff",
        "IDENTIFIER": "dtm",
        "BOUNDINGBOX": ",".join(f"{value:.3f}" for value in bbox) + ",urn:ogc:def:crs:EPSG::3979",
        "GRIDBASECRS": "urn:ogc:def:crs:EPSG::3979",
        "GRIDOFFSETS": f"{resolution_m},-{resolution_m}",
        "GRIDORIGIN": f"{bbox[0]:.3f},{bbox[3]:.3f}",
        "Gridcs": "urn:ogc:def:cs:OGC:0.0:Grid2dSquareCS",
        "gridtype": "urn:ogc:def:method:WCS:1.1:2dSimpleGrid",
    }
    response = requests.get(NRCAN_WCS, params=params, timeout=240)
    response.raise_for_status()
    payload = response.content
    if len(payload) < 1024:
        preview = payload[:300].decode("utf-8", errors="replace")
        raise ValueError(f"NRCan terrain response was unexpectedly small: {preview}")

    return payload, {
        "provider": "nrcan-hrdem",
        "dataset": "Natural Resources Canada HRDEM Mosaic DTM",
        "sourceClass": "lidar-derived-high-resolution-dtm",
        "sourceUrl": NRCAN_WCS,
        "license": "Open Government Licence - Canada",
        "verticalDatum": "CGVD2013 orthometric heights",
        "requestCrs": "EPSG:3979",
        "requestBounds": [round(value, 3) for value in bbox],
        "extractionResolutionMeters": resolution_m,
    }


def acquire_source(
    provider: str,
    lonlat_bounds: tuple[float, float, float, float],
    resolution_m: float,
    padding_m: float,
) -> tuple[bytes, dict[str, Any]]:
    if provider == "usgs-3dep":
        return fetch_usgs_3dep(lonlat_bounds, resolution_m, padding_m)
    if provider == "nrcan-hrdem":
        return fetch_nrcan_hrdem(lonlat_bounds, resolution_m, padding_m)
    raise ValueError(f"Unsupported terrain provider: {provider}")


def local_xy_to_latlon(
    x_yds: np.ndarray,
    y_yds: np.ndarray,
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> tuple[np.ndarray, np.ndarray]:
    east_yds = right[0] * x_yds + forward[0] * y_yds
    north_yds = right[1] * x_yds + forward[1] * y_yds
    east_m = east_yds * YARDS_TO_METERS
    north_m = north_yds * YARDS_TO_METERS
    lat = origin[0] + np.degrees(north_m / EARTH_RADIUS_M)
    lon = origin[1] + np.degrees(east_m / (EARTH_RADIUS_M * math.cos(math.radians(origin[0]))))
    return lat, lon


def sample_raster_nearest(
    data: np.ndarray,
    transform: Any,
    crs: Any,
    nodata: float | None,
    lat: np.ndarray,
    lon: np.ndarray,
) -> np.ndarray:
    transformer = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    xs, ys = transformer.transform(lon.ravel(), lat.ravel())
    inverse = ~transform
    cols_float, rows_float = inverse * (np.asarray(xs), np.asarray(ys))
    cols = np.floor(cols_float).astype(int)
    rows = np.floor(rows_float).astype(int)
    inside = (rows >= 0) & (rows < data.shape[0]) & (cols >= 0) & (cols < data.shape[1])
    result = np.full(rows.shape, np.nan, dtype=float)
    result[inside] = data[rows[inside], cols[inside]]
    invalid = ~np.isfinite(result) | (np.abs(result) > 15_000)
    if nodata is not None and np.isfinite(nodata):
        invalid |= np.isclose(result, nodata)
    result[invalid] = np.nan
    return result.reshape(lat.shape)


def open_source_raster(payload: bytes, metadata: dict[str, Any]):
    memory_file = MemoryFile(payload)
    dataset = memory_file.open()
    if dataset.count < 1:
        dataset.close()
        memory_file.close()
        raise ValueError("Terrain source raster has no bands")

    transform = dataset.transform
    crs = dataset.crs
    if crs is None or transform.is_identity:
        request_crs = metadata["requestCrs"]
        bounds = metadata["requestBounds"]
        crs = request_crs
        transform = from_bounds(*bounds, dataset.width, dataset.height)
    return memory_file, dataset, transform, crs


def encode_grid(elevation_ft: np.ndarray) -> tuple[float, str, int, float, float]:
    finite = elevation_ft[np.isfinite(elevation_ft)]
    if finite.size == 0:
        raise ValueError("Terrain grid contains no finite elevation samples")
    offset = math.floor(float(finite.min()) * 10.0) / 10.0
    quantized = np.rint((elevation_ft - offset) * 10.0)
    encoded = np.full(elevation_ft.shape, NODATA_ENCODED, dtype="<u2")
    good = np.isfinite(elevation_ft) & (quantized >= 0) & (quantized < NODATA_ENCODED)
    encoded[good] = quantized[good].astype("<u2")
    compressed = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode("ascii")
    coverage = float(good.mean())
    return offset, compressed, int(good.sum()), coverage, float(finite.max() - finite.min())


def point_is_finite(grid: np.ndarray, xs: np.ndarray, ys: np.ndarray, x: float, y: float) -> bool:
    col = int(np.argmin(np.abs(xs - x)))
    row = int(np.argmin(np.abs(ys - y)))
    return bool(np.isfinite(grid[row, col]))


def build(
    osm_path: Path,
    config_path: Path,
    geometry_path: Path,
    output_path: Path,
    validation_path: Path,
    cache_path: Path,
) -> None:
    osm = json.loads(osm_path.read_text(encoding="utf-8"))
    config = json.loads(config_path.read_text(encoding="utf-8"))
    geometry = json.loads(geometry_path.read_text(encoding="utf-8"))
    terrain_config = config.get("terrain") or {}
    provider = terrain_config.get("provider")
    if not provider:
        raise ValueError(f"{config_path} does not configure terrain.provider")
    runtime_spacing = float(terrain_config.get("runtimeSpacingYards", DEFAULT_RUNTIME_SPACING_YDS))
    source_resolution = float(terrain_config.get("sourceResolutionMeters", DEFAULT_SOURCE_RESOLUTION_M))
    source_padding = float(terrain_config.get("sourcePaddingMeters", DEFAULT_SOURCE_PADDING_M))

    _, hole_routes = v3.normalize_osm_with_topology(osm)
    if sorted(hole_routes) != list(range(1, 19)):
        raise ValueError(f"Expected OSM routes 1-18; got {sorted(hole_routes)}")
    if geometry.get("courseId") != config.get("courseId"):
        raise ValueError("Geometry package courseId does not match terrain config")

    bounds_ll = course_latlon_bounds(hole_routes)
    source_bytes, source_metadata = acquire_source(provider, bounds_ll, source_resolution, source_padding)
    source_metadata["retrievedAt"] = utc_now()
    source_metadata["sourceSha256"] = sha256_bytes(source_bytes)
    source_metadata["sourceBoundsWgs84"] = [round(value, 7) for value in bounds_ll]

    memory_file, dataset, transform, raster_crs = open_source_raster(source_bytes, source_metadata)
    try:
        source_data = dataset.read(1).astype(float)
        nodata = dataset.nodata
        package_holes: dict[str, Any] = {}
        validation_holes: list[dict[str, Any]] = []

        for hole_number in range(1, 19):
            route = hole_routes[hole_number]["geometry"]
            origin, forward, right, _ = v2.route_basis(route)
            hole_geometry = (geometry.get("holes") or {}).get(str(hole_number))
            if not hole_geometry:
                raise ValueError(f"Geometry package is missing hole {hole_number}")
            view = hole_geometry.get("viewBounds") or {}
            min_x = math.floor(float(view["minX"]) / runtime_spacing) * runtime_spacing
            max_x = math.ceil(float(view["maxX"]) / runtime_spacing) * runtime_spacing
            min_y = math.floor(float(view["minY"]) / runtime_spacing) * runtime_spacing
            max_y = math.ceil(float(view["maxY"]) / runtime_spacing) * runtime_spacing
            xs = np.arange(min_x, max_x + runtime_spacing * 0.25, runtime_spacing)
            ys = np.arange(min_y, max_y + runtime_spacing * 0.25, runtime_spacing)
            xx, yy = np.meshgrid(xs, ys)
            lat, lon = local_xy_to_latlon(xx, yy, origin, forward, right)
            elevation_m = sample_raster_nearest(source_data, transform, raster_crs, nodata, lat, lon)
            elevation_ft = elevation_m * 3.280839895013123
            offset, compressed, valid_count, coverage, relief = encode_grid(elevation_ft)

            route_length = sum(base.haversine_yards(a, b) for a, b in zip(route, route[1:]))
            tee_ok = point_is_finite(elevation_ft, xs, ys, 0.0, 0.0)
            green_ok = point_is_finite(elevation_ft, xs, ys, 0.0, route_length)
            ready = coverage >= MIN_HOLE_GRID_COVERAGE and tee_ok and green_ok
            finite = elevation_ft[np.isfinite(elevation_ft)]
            package_holes[str(hole_number)] = {
                "grid": {
                    "minX": round(float(xs[0]), 3),
                    "minY": round(float(ys[0]), 3),
                    "spacingYds": runtime_spacing,
                    "width": int(len(xs)),
                    "height": int(len(ys)),
                    "elevationOffsetFt": round(offset, 1),
                    "compression": "deflate",
                    "valuesBase64": compressed,
                },
                "elevationRangeFt": [round(float(finite.min()), 1), round(float(finite.max()), 1)],
            }
            validation_holes.append({
                "hole": hole_number,
                "ready": ready,
                "coveragePct": round(coverage * 100.0, 2),
                "validSamples": valid_count,
                "totalSamples": int(elevation_ft.size),
                "teeSampleAvailable": tee_ok,
                "routeEndSampleAvailable": green_ok,
                "reliefFt": round(relief, 1),
                "grid": {"width": int(len(xs)), "height": int(len(ys)), "spacingYds": runtime_spacing},
            })
    finally:
        dataset.close()
        memory_file.close()

    generated_at = utc_now()
    package = {
        "schemaVersion": "looper-course-terrain-v1",
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "location": config["location"],
        "generatedAt": generated_at,
        "source": source_metadata,
        "runtimeTerrain": {
            "spacingYds": runtime_spacing,
            "interpolation": "bilinear",
            "encoding": "uint16 deci-feet above per-hole offset",
            "nodata": NODATA_ENCODED,
            "note": "Compact cached browser grid derived from the configured official bare-earth DEM service. No terrain network request is required during play.",
        },
        "holes": package_holes,
    }

    ready_holes = [item["hole"] for item in validation_holes if item["ready"]]
    validation = {
        "schemaVersion": "looper-course-terrain-validation-v1",
        "courseId": config["courseId"],
        "provider": provider,
        "generatedAt": generated_at,
        "sourceSha256": source_metadata["sourceSha256"],
        "sourceRaster": {
            "crs": str(raster_crs),
            "width": int(source_data.shape[1]),
            "height": int(source_data.shape[0]),
            "nodata": None if nodata is None else float(nodata),
        },
        "readyHoleCount": len(ready_holes),
        "readyHoles": ready_holes,
        "allHolesTerrainReady": len(ready_holes) == 18,
        "minimumHoleGridCoveragePct": MIN_HOLE_GRID_COVERAGE * 100.0,
        "holes": validation_holes,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    validation_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(package, separators=(",", ":")) + "\n", encoding="utf-8")
    validation_path.write_text(json.dumps(validation, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    cache = {
        "schemaVersion": "looper-course-terrain-cache-v1",
        "courseId": config["courseId"],
        "cachedAt": generated_at,
        "provider": provider,
        "sourceSha256": source_metadata["sourceSha256"],
        "terrainPackageSha256": sha256_file(output_path),
        "terrainPackagePath": str(output_path),
        "validationPath": str(validation_path),
        "runtimeNetworkDependency": False,
        "refreshPolicy": {
            "implicitRefresh": False,
            "serveCachedRegardlessOfAge": True,
            "refreshTriggers": ["explicit-refresh", "provider-dataset-update", "course-renovation"],
        },
    }
    cache_path.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "course": config["courseName"],
        "provider": provider,
        "source_bytes": len(source_bytes),
        "source_sha256": source_metadata["sourceSha256"],
        "ready_holes": ready_holes,
        "all_ready": len(ready_holes) == 18,
        "terrain_package": str(output_path),
        "validation": str(validation_path),
        "cache": str(cache_path),
    }, indent=2))
    if len(ready_holes) != 18:
        raise SystemExit(f"Terrain incomplete; ready holes: {ready_holes}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--geometry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    build(args.osm, args.config, args.geometry, args.output, args.validation, args.cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
