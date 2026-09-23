#!/usr/bin/env python3
"""Build LiDAR terrain directly in the current per-hole coordinate frame.

Unlike the original terrain importer, this version does not reconstruct a hole
frame from the raw OSM route.  It treats the geometry package's
``coordinateFrame`` as authoritative, so selected-tee / reversed-route V5+ hole
packages can be sampled without moving the terrain back into the old route-start
frame.

The first production use is intentionally narrow: Augusta H1/H6.  ``--holes``
allows the same importer to expand to the remaining holes after this slice is
validated.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import rasterio
from pyproj import Geod, Transformer

SCHEMA = "looper-course-terrain-v1"
SOURCE_SCHEMA = "looper-course-terrain-source-v1"
VALIDATION_SCHEMA = "looper-course-terrain-validation-v1"
CACHE_SCHEMA = "looper-course-terrain-cache-v1"
VERSION = "import_course_terrain_v3"
UA = "LooperTerrainImporter/3.0 (+https://github.com/bpgpitt10/nova-v0)"
USGS_DATASET = "Digital Elevation Model (DEM) 1 meter"
USGS_API = "https://tnmaccess.nationalmap.gov/api/v1/products"
M_TO_FT = 3.280839895013123
YD_TO_M = 0.9144
NODATA = 65535
GEOD = Geod(ellps="WGS84")


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected JSON object")
    return value


def write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def geometry_sha(package: dict[str, Any]) -> str:
    value = json.loads(json.dumps(package))
    value.pop("terrainProvenance", None)
    for hole in (value.get("holes") or {}).values():
        if isinstance(hole, dict):
            hole.pop("terrain", None)
            hole.pop("contours", None)
    return canonical_sha(value)


def parse_holes(raw: str) -> list[int]:
    holes: set[int] = set()
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            start_raw, end_raw = token.split("-", 1)
            start, end = int(start_raw), int(end_raw)
            if end < start:
                start, end = end, start
            holes.update(range(start, end + 1))
        else:
            holes.add(int(token))
    if not holes or min(holes) < 1 or max(holes) > 18:
        raise argparse.ArgumentTypeError("--holes must resolve to hole numbers 1..18")
    return sorted(holes)


def frame_for_hole(hole: dict[str, Any], number: int) -> dict[str, Any]:
    frame = hole.get("coordinateFrame")
    if not isinstance(frame, dict):
        raise RuntimeError(f"Hole {number}: missing coordinateFrame")
    origin = frame.get("origin")
    if origin not in {"selected-tee", "osm-hole-route-start"}:
        raise RuntimeError(f"Hole {number}: unsupported coordinateFrame.origin {origin!r}")
    anchor = frame.get("anchorLatLon")
    if (
        not isinstance(anchor, list)
        or len(anchor) < 2
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in anchor[:2])
    ):
        raise RuntimeError(f"Hole {number}: invalid coordinateFrame.anchorLatLon")
    heading = frame.get("headingDegreesTrue")
    if not isinstance(heading, (int, float)) or isinstance(heading, bool):
        raise RuntimeError(f"Hole {number}: invalid coordinateFrame.headingDegreesTrue")
    return frame


def local_xy_to_lon_lat(
    x_yards: Any,
    y_yards: Any,
    *,
    anchor_lat: float,
    anchor_lon: float,
    heading_degrees: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert current-frame local x(right), y(forward) yards to WGS84 lon/lat."""
    x = np.asarray(x_yards, dtype=float)
    y = np.asarray(y_yards, dtype=float)
    heading = math.radians(float(heading_degrees))

    # Heading is clockwise from true north.  Local +x is right of +y/forward.
    east_yards = x * math.cos(heading) + y * math.sin(heading)
    north_yards = -x * math.sin(heading) + y * math.cos(heading)
    distance_m = np.hypot(east_yards, north_yards) * YD_TO_M
    azimuth_deg = np.degrees(np.arctan2(east_yards, north_yards))

    lon0 = np.full(np.shape(distance_m), float(anchor_lon), dtype=float)
    lat0 = np.full(np.shape(distance_m), float(anchor_lat), dtype=float)
    lon, lat, _ = GEOD.fwd(lon0, lat0, azimuth_deg, distance_m)
    return np.asarray(lon), np.asarray(lat)


def grid_spec(
    hole: dict[str, Any],
    number: int,
    spacing: float,
    padding: float,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    bounds = hole.get("viewBounds") or hole.get("bounds")
    if not isinstance(bounds, dict):
        raise RuntimeError(f"Hole {number}: missing viewBounds/bounds")
    try:
        min_x = math.floor((float(bounds["minX"]) - padding) / spacing) * spacing
        max_x = math.ceil((float(bounds["maxX"]) + padding) / spacing) * spacing
        min_y = math.floor((float(bounds["minY"]) - padding) / spacing) * spacing
        max_y = math.ceil((float(bounds["maxY"]) + padding) / spacing) * spacing
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"Hole {number}: invalid view bounds") from exc
    xs = np.arange(min_x, max_x + spacing * 0.25, spacing)
    ys = np.arange(min_y, max_y + spacing * 0.25, spacing)
    if len(xs) < 2 or len(ys) < 2:
        raise RuntimeError(f"Hole {number}: terrain grid is degenerate")
    return xs, ys, min_x, min_y


def requested_bounds_wgs84(
    geometry: dict[str, Any],
    holes: Iterable[int],
    spacing: float,
    padding: float,
    source_margin_m: float,
) -> tuple[float, float, float, float]:
    lons: list[float] = []
    lats: list[float] = []
    package_holes = geometry.get("holes") or {}
    for number in holes:
        hole = package_holes.get(str(number))
        if not isinstance(hole, dict):
            raise RuntimeError(f"Geometry package missing Hole {number}")
        frame = frame_for_hole(hole, number)
        xs, ys, _, _ = grid_spec(hole, number, spacing, padding)
        # Corners are sufficient because the local->geodesic transform is monotonic
        # at golf-hole scale.
        xx = np.array([xs[0], xs[-1], xs[0], xs[-1]], dtype=float)
        yy = np.array([ys[0], ys[0], ys[-1], ys[-1]], dtype=float)
        lat0, lon0 = float(frame["anchorLatLon"][0]), float(frame["anchorLatLon"][1])
        lon, lat = local_xy_to_lon_lat(
            xx,
            yy,
            anchor_lat=lat0,
            anchor_lon=lon0,
            heading_degrees=float(frame["headingDegreesTrue"]),
        )
        lons.extend(float(v) for v in lon)
        lats.extend(float(v) for v in lat)

    west, east = min(lons), max(lons)
    south, north = min(lats), max(lats)
    mid_lat = (south + north) / 2.0
    lat_margin = source_margin_m / 111_320.0
    lon_margin = source_margin_m / max(1.0, 111_320.0 * math.cos(math.radians(mid_lat)))
    return west - lon_margin, south - lat_margin, east + lon_margin, north + lat_margin


def get_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise ValueError("non-object JSON")
            return value
        except Exception as exc:  # network retry
            error = exc
            time.sleep(2**attempt)
    raise RuntimeError(f"GET failed {url}: {error}")


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=300) as response, destination.open("wb") as handle:
                shutil.copyfileobj(response, handle, 1 << 20)
            if destination.stat().st_size > 0:
                return
        except Exception as exc:
            error = exc
            destination.unlink(missing_ok=True)
            time.sleep(2**attempt)
    raise RuntimeError(f"download failed {url}: {error}")


def discover_usgs(bounds: tuple[float, float, float, float]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    query = urllib.parse.urlencode(
        {
            "datasets": USGS_DATASET,
            "bbox": ",".join(f"{value:.7f}" for value in bounds),
            "prodFormats": "GeoTIFF",
            "max": 100,
            "outputFormat": "JSON",
        }
    )
    url = f"{USGS_API}?{query}"
    catalog = get_json(url)
    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in catalog.get("items") or []:
        if not isinstance(item, dict):
            continue
        href = item.get("downloadURL") or item.get("downloadUrl")
        if not isinstance(href, str) or not href.startswith("http") or href in seen:
            continue
        seen.add(href)
        products.append(
            {
                "id": str(item.get("sourceId") or item.get("id") or item.get("title") or href),
                "url": href,
                "title": item.get("title"),
            }
        )
    if not products:
        raise RuntimeError("USGS 3DEP returned no downloadable 1 m GeoTIFF products")
    metadata = {
        "schemaVersion": SOURCE_SCHEMA,
        "provider": "usgs-3dep-1m",
        "dataset": USGS_DATASET,
        "lidarDerived": True,
        "license": "U.S. public domain",
        "catalogQueryUrl": url,
        "sourceBoundsWgs84": [round(value, 7) for value in bounds],
    }
    return metadata, products


def acquire_usgs(
    bounds: tuple[float, float, float, float],
    temp_dir: Path,
) -> tuple[list[Path], dict[str, Any]]:
    metadata, products = discover_usgs(bounds)
    rasters: list[Path] = []
    records: list[dict[str, Any]] = []
    for index, product in enumerate(products):
        parsed_suffix = Path(urllib.parse.urlparse(product["url"]).path).suffix
        path = temp_dir / f"source-{index:03d}{parsed_suffix or '.bin'}"
        download(product["url"], path)
        record = {
            **product,
            "downloadSha256": sha256_file(path),
            "downloadBytes": path.stat().st_size,
        }
        records.append(record)
        if zipfile.is_zipfile(path):
            extracted = temp_dir / f"unzipped-{index:03d}"
            extracted.mkdir()
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist():
                    if Path(name).suffix.lower() in {".tif", ".tiff"}:
                        archive.extract(name, extracted)
                        rasters.append(extracted / name)
        else:
            rasters.append(path)
    if not rasters:
        raise RuntimeError("USGS products contained no GeoTIFFs")
    metadata["products"] = records
    metadata["retrievedAt"] = now()
    return rasters, metadata


class Sampler:
    def __init__(self, paths: list[Path], max_resolution_m: float):
        self.datasets: list[Any] = []
        self.transforms: list[Transformer] = []
        self.resolutions_m: list[float] = []
        for path in paths:
            dataset = rasterio.open(path)
            if not dataset.crs or dataset.crs.is_geographic:
                dataset.close()
                raise RuntimeError(f"source must use a projected CRS: {path}")
            try:
                factor = float(dataset.crs.linear_units_factor[1])
            except Exception:
                factor = 1.0 if str(dataset.crs.linear_units).lower() in {"metre", "meter", "m"} else math.nan
            resolution = max(abs(dataset.res[0]), abs(dataset.res[1])) * factor
            if not math.isfinite(resolution) or resolution <= 0 or resolution > max_resolution_m + 0.05:
                dataset.close()
                raise RuntimeError(
                    f"source resolution {resolution:.3f}m exceeds {max_resolution_m:.3f}m: {path}"
                )
            self.datasets.append(dataset)
            self.transforms.append(Transformer.from_crs("EPSG:4326", dataset.crs, always_xy=True))
            self.resolutions_m.append(resolution)
        if not self.datasets:
            raise RuntimeError("no elevation rasters opened")

    def close(self) -> None:
        for dataset in self.datasets:
            dataset.close()

    def sample(self, lon: Any, lat: Any) -> np.ndarray:
        shape = np.shape(lon)
        lon_flat = np.asarray(lon, dtype=float).ravel()
        lat_flat = np.asarray(lat, dtype=float).ravel()
        output = np.full(lon_flat.shape, np.nan)
        missing = np.ones(lon_flat.shape, dtype=bool)
        for dataset, transformer in zip(self.datasets, self.transforms):
            indexes = np.flatnonzero(missing)
            if not len(indexes):
                break
            x, y = transformer.transform(lon_flat[indexes], lat_flat[indexes])
            x = np.asarray(x)
            y = np.asarray(y)
            inside = (
                (x >= dataset.bounds.left)
                & (x <= dataset.bounds.right)
                & (y >= dataset.bounds.bottom)
                & (y <= dataset.bounds.top)
            )
            if not np.any(inside):
                continue
            target_indexes = indexes[inside]
            values: list[float] = []
            for sample in dataset.sample(zip(x[inside].tolist(), y[inside].tolist()), indexes=1, masked=True):
                values.append(np.nan if np.ma.is_masked(sample[0]) else float(sample[0]))
            sampled = np.asarray(values)
            if dataset.nodata is not None:
                sampled[np.isclose(sampled, float(dataset.nodata), equal_nan=False)] = np.nan
            valid = np.isfinite(sampled)
            output[target_indexes[valid]] = sampled[valid]
            missing[target_indexes[valid]] = False
        return output.reshape(shape)


def encode_grid(grid_feet: np.ndarray) -> tuple[float, str, float, float, float]:
    finite = np.isfinite(grid_feet)
    if not np.any(finite):
        raise RuntimeError("terrain grid has no finite samples")
    values = grid_feet[finite]
    offset = math.floor(float(values.min()) * 10.0) / 10.0
    quantized = np.rint((grid_feet - offset) * 10.0)
    encoded = np.full(grid_feet.shape, NODATA, dtype="<u2")
    valid = finite & (quantized >= 0) & (quantized < NODATA)
    encoded[valid] = quantized[valid].astype("<u2")
    missing_fraction = 1.0 - float(np.count_nonzero(valid)) / valid.size
    blob = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode("ascii")
    return offset, blob, float(values.min()), float(values.max()), missing_fraction


def build_terrain(
    cfg: dict[str, Any],
    geometry: dict[str, Any],
    holes: list[int],
    sampler: Sampler,
    source: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    terrain_cfg = cfg.get("terrain") or {}
    spacing = float(terrain_cfg.get("runtimeSpacingYards", 10))
    padding = float(terrain_cfg.get("gridPaddingYards", 0))
    max_missing = float(terrain_cfg.get("maxGridNoDataFraction", 0.35))
    package_holes = geometry.get("holes") or {}

    terrain: dict[str, Any] = {
        "schemaVersion": SCHEMA,
        "courseId": cfg["courseId"],
        "source": {
            "provider": source["provider"],
            "dataset": source["dataset"],
            "sourceResolutionMeters": round(max(sampler.resolutions_m), 3),
            "lidarDerived": True,
            "license": source.get("license"),
        },
        "courseCoordinateSystem": {
            "projection": "per-hole-current-coordinate-frame-v1",
            "units": "yards",
        },
        "runtimeTerrain": {
            "spacingYds": spacing,
            "interpolation": "bilinear",
            "encoding": "uint16 deci-feet above per-hole offset",
            "nodata": NODATA,
            "note": "Compact runtime grid sampled directly in the package coordinateFrame.",
        },
        "holes": {},
    }
    diagnostics: list[dict[str, Any]] = []

    for number in holes:
        hole = package_holes.get(str(number))
        if not isinstance(hole, dict):
            raise RuntimeError(f"Geometry package missing Hole {number}")
        frame = frame_for_hole(hole, number)
        xs, ys, min_x, min_y = grid_spec(hole, number, spacing, padding)
        xx, yy = np.meshgrid(xs, ys)
        anchor_lat, anchor_lon = float(frame["anchorLatLon"][0]), float(frame["anchorLatLon"][1])
        lon, lat = local_xy_to_lon_lat(
            xx,
            yy,
            anchor_lat=anchor_lat,
            anchor_lon=anchor_lon,
            heading_degrees=float(frame["headingDegreesTrue"]),
        )
        grid_feet = sampler.sample(lon, lat) * M_TO_FT
        offset, blob, low, high, missing = encode_grid(grid_feet)
        if missing > max_missing:
            raise RuntimeError(
                f"Hole {number}: rectangular terrain no-data {missing:.1%} > {max_missing:.1%}"
            )

        # The anchor itself must be covered.  This is a simple, frame-specific
        # acceptance check and catches wrong-family / wrong-hemisphere errors.
        anchor_elevation = sampler.sample(np.array([anchor_lon]), np.array([anchor_lat]))[0]
        if not math.isfinite(float(anchor_elevation)):
            raise RuntimeError(f"Hole {number}: no terrain sample at coordinateFrame anchor")

        terrain["holes"][str(number)] = {
            "coordinateFrame": {
                "origin": frame["origin"],
                "anchorLatLon": [round(anchor_lat, 8), round(anchor_lon, 8)],
                "headingDegreesTrue": round(float(frame["headingDegreesTrue"]), 6),
            },
            "grid": {
                "minX": round(float(min_x), 3),
                "minY": round(float(min_y), 3),
                "spacingYds": spacing,
                "width": len(xs),
                "height": len(ys),
                "elevationOffsetFt": round(offset, 1),
                "compression": "deflate",
                "valuesBase64": blob,
            },
            "elevationRangeFt": [round(low, 1), round(high, 1)],
        }
        diagnostics.append(
            {
                "hole": number,
                "ready": True,
                "coordinateFrameOrigin": frame["origin"],
                "anchorLatLon": [round(anchor_lat, 8), round(anchor_lon, 8)],
                "headingDegreesTrue": round(float(frame["headingDegreesTrue"]), 6),
                "gridNoDataFraction": round(missing, 5),
                "elevationRangeFt": [round(low, 1), round(high, 1)],
                "anchorElevationFt": round(float(anchor_elevation) * M_TO_FT, 1),
            }
        )

    validation = {
        "schemaVersion": VALIDATION_SCHEMA,
        "courseId": cfg["courseId"],
        "provider": source["provider"],
        "dataset": source["dataset"],
        "lidarDerived": True,
        "sourceResolutionMeters": round(max(sampler.resolutions_m), 3),
        "requestedHoles": holes,
        "terrainHoleCount": len(holes),
        "readyHoleCount": len(diagnostics),
        "allRequestedHolesTerrainReady": len(diagnostics) == len(holes),
        "holes": diagnostics,
        "generatedAt": now(),
    }
    return terrain, validation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--geometry", required=True, type=Path)
    parser.add_argument("--source-out", required=True, type=Path)
    parser.add_argument("--terrain-out", required=True, type=Path)
    parser.add_argument("--validation-out", required=True, type=Path)
    parser.add_argument("--cache-out", type=Path)
    parser.add_argument("--holes", default="1-18")
    parser.add_argument("--force-refresh", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cfg = load(args.config)
    geometry = load(args.geometry)
    if geometry.get("courseId") != cfg.get("courseId"):
        raise RuntimeError(
            f"geometry courseId {geometry.get('courseId')!r} does not match config {cfg.get('courseId')!r}"
        )
    holes = parse_holes(args.holes)
    terrain_cfg = cfg.get("terrain") or {}
    provider = terrain_cfg.get("provider", "usgs-3dep-1m")
    if provider != "usgs-3dep-1m":
        raise RuntimeError(
            f"{VERSION} currently supports usgs-3dep-1m only; got {provider!r}"
        )
    spacing = float(terrain_cfg.get("runtimeSpacingYards", 10))
    padding = float(terrain_cfg.get("gridPaddingYards", 0))
    source_margin = float(terrain_cfg.get("sourceMarginMeters", 300))
    max_resolution = float(terrain_cfg.get("maxSourceResolutionMeters", 1.1))
    bounds = requested_bounds_wgs84(
        geometry,
        holes,
        spacing,
        padding,
        source_margin,
    )

    with tempfile.TemporaryDirectory(prefix="looper-terrain-") as temp:
        temp_path = Path(temp)
        rasters, source = acquire_usgs(bounds, temp_path)
        sampler = Sampler(rasters, max_resolution)
        try:
            terrain, validation = build_terrain(
                cfg,
                geometry,
                holes,
                sampler,
                source,
            )
        finally:
            sampler.close()

    write(args.source_out, source)
    write(args.terrain_out, terrain)
    write(args.validation_out, validation)
    if args.cache_out:
        cache = {
            "schemaVersion": CACHE_SCHEMA,
            "courseId": cfg["courseId"],
            "builderVersion": VERSION,
            "geometrySha256": geometry_sha(geometry),
            "sourceSha256": sha256_file(args.source_out),
            "terrainSha256": sha256_file(args.terrain_out),
            "validationSha256": sha256_file(args.validation_out),
            "holes": holes,
            "status": "partial" if len(holes) < 18 else "complete",
            "builtAt": now(),
        }
        write(args.cache_out, cache)

    print(json.dumps(validation, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
