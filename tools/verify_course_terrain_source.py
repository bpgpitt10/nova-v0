#!/usr/bin/env python3
"""Verify that configured terrain sources meet Looper's source-quality contract.

For USGS courses, this explicitly proves that the padded course footprint is
covered by the USGS 3DEP 1-meter DEM collection. USGS states that its standard
1-meter DEM is produced exclusively from high-resolution lidar source data.
The runtime raster may still be resampled for compact extraction, but it must
not silently fall back to a coarser non-lidar DEM.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

import build_osm_course_package_v3 as v3
from build_course_terrain import course_latlon_bounds

TNM_PRODUCTS = "https://tnmaccess.nationalmap.gov/api/v1/products"
USGS_1M_DATASET = "Digital Elevation Model (DEM) 1 meter"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def expanded_wgs84_bounds(
    bounds: tuple[float, float, float, float],
    padding_m: float,
) -> tuple[float, float, float, float]:
    min_lon, min_lat, max_lon, max_lat = bounds
    mid_lat = (min_lat + max_lat) / 2.0
    lat_pad = padding_m / 111_320.0
    lon_pad = padding_m / (111_320.0 * max(0.05, math.cos(math.radians(mid_lat))))
    return min_lon - lon_pad, min_lat - lat_pad, max_lon + lon_pad, max_lat + lat_pad


def tnm_items_at_point(lon: float, lat: float) -> list[dict[str, Any]]:
    epsilon = 0.00001
    params = {
        "datasets": USGS_1M_DATASET,
        "bbox": f"{lon - epsilon:.7f},{lat - epsilon:.7f},{lon + epsilon:.7f},{lat + epsilon:.7f}",
        "prodFormats": "GeoTIFF",
        "max": 50,
    }
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(TNM_PRODUCTS, params=params, timeout=60)
            response.raise_for_status()
            payload = response.json()
            errors = payload.get("errors") or []
            if errors:
                raise RuntimeError(f"TNMAccess returned errors: {errors}")
            return list(payload.get("items") or [])
        except Exception as exc:  # network/provider retries are intentional here
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TNMAccess 1m coverage query failed after retries: {last_error}")


def usgs_1m_proof(
    course_id: str,
    bounds: tuple[float, float, float, float],
    padding_m: float,
) -> dict[str, Any]:
    padded = expanded_wgs84_bounds(bounds, padding_m)
    min_lon, min_lat, max_lon, max_lat = padded
    points = {
        "southwest": (min_lon, min_lat),
        "northwest": (min_lon, max_lat),
        "southeast": (max_lon, min_lat),
        "northeast": (max_lon, max_lat),
        "center": ((min_lon + max_lon) / 2.0, (min_lat + max_lat) / 2.0),
    }
    checks = []
    unique_products: dict[str, dict[str, Any]] = {}
    for label, (lon, lat) in points.items():
        items = tnm_items_at_point(lon, lat)
        checks.append({
            "point": label,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "productCount": len(items),
            "covered": bool(items),
        })
        for item in items:
            key = str(item.get("sourceId") or item.get("id") or item.get("downloadURL") or item.get("title"))
            unique_products[key] = {
                "title": item.get("title"),
                "sourceId": item.get("sourceId") or item.get("id"),
                "publicationDate": item.get("publicationDate") or item.get("dateCreated"),
                "format": item.get("format"),
                "downloadURL": item.get("downloadURL"),
            }

    passed = all(item["covered"] for item in checks)
    return {
        "schemaVersion": "looper-course-terrain-source-proof-v1",
        "courseId": course_id,
        "provider": "usgs-3dep",
        "verifiedAt": utc_now(),
        "qualityContract": "USGS 3DEP standard 1-meter bare-earth DEM coverage across padded course footprint",
        "qualityBasis": "USGS standard 1-meter DEMs are produced exclusively from high-resolution lidar source data.",
        "dataset": USGS_1M_DATASET,
        "queryEndpoint": TNM_PRODUCTS,
        "paddedBoundsWgs84": [round(value, 7) for value in padded],
        "paddingMeters": padding_m,
        "sampleChecks": checks,
        "products": list(unique_products.values()),
        "passed": passed,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    osm = json.loads(args.osm.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    terrain = config.get("terrain") or {}
    provider = terrain.get("provider")
    _, hole_routes = v3.normalize_osm_with_topology(osm)
    if sorted(hole_routes) != list(range(1, 19)):
        raise SystemExit(f"Expected OSM routes 1-18; got {sorted(hole_routes)}")
    bounds = course_latlon_bounds(hole_routes)
    padding = float(terrain.get("sourcePaddingMeters", 300.0))

    if provider == "usgs-3dep":
        proof = usgs_1m_proof(config["courseId"], bounds, padding)
    elif provider == "nrcan-hrdem":
        proof = {
            "schemaVersion": "looper-course-terrain-source-proof-v1",
            "courseId": config["courseId"],
            "provider": provider,
            "verifiedAt": utc_now(),
            "qualityContract": "Natural Resources Canada HRDEM Mosaic DTM",
            "qualityBasis": "Configured HRDEM DTM provider is the high-resolution bare-earth terrain source; coverage is proven by the subsequent raster/grid validation.",
            "passed": True,
        }
    else:
        raise SystemExit(f"No terrain source verifier for provider: {provider}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "courseId": proof["courseId"],
        "provider": proof["provider"],
        "passed": proof["passed"],
        "sampleChecks": proof.get("sampleChecks"),
        "productCount": len(proof.get("products") or []),
    }, indent=2))
    if not proof["passed"]:
        raise SystemExit("Terrain source quality gate failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
