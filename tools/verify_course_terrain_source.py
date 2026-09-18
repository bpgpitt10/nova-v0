#!/usr/bin/env python3
"""Verify that configured terrain sources meet Looper's source-quality contract.

For USGS courses, prefer the standard 1-meter DEM collection. If that product
has not been published for a footprint, accept the Original Product Resolution
(OPR) bare-earth DEM only when it covers the full padded course footprint.
Both are lidar-derived 3DEP source classes in CONUS; a coarse seamless DEM is
never an accepted fallback for a course marked terrain-ready.
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
USGS_OPR_DATASET = "Original Product Resolution (OPR) Digital Elevation Model (DEM)"
USGS_LPC_DATASET = "Lidar Point Cloud (LPC)"


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


def tnm_items_at_point(
    lon: float,
    lat: float,
    dataset: str,
    prod_formats: str | None = None,
) -> list[dict[str, Any]]:
    epsilon = 0.00001
    params: dict[str, Any] = {
        "datasets": dataset,
        "bbox": f"{lon - epsilon:.7f},{lat - epsilon:.7f},{lon + epsilon:.7f},{lat + epsilon:.7f}",
        "max": 50,
    }
    if prod_formats:
        params["prodFormats"] = prod_formats
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
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TNMAccess coverage query failed after retries: {last_error}")


def summarize_product(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": item.get("title"),
        "sourceId": item.get("sourceId") or item.get("id"),
        "publicationDate": item.get("publicationDate") or item.get("dateCreated"),
        "format": item.get("format"),
        "downloadURL": item.get("downloadURL"),
    }


def coverage_for_dataset(
    points: dict[str, tuple[float, float]],
    dataset: str,
    prod_formats: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    unique_products: dict[str, dict[str, Any]] = {}
    for label, (lon, lat) in points.items():
        items = tnm_items_at_point(lon, lat, dataset, prod_formats)
        checks.append({
            "point": label,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "productCount": len(items),
            "covered": bool(items),
        })
        for item in items:
            key = str(item.get("sourceId") or item.get("id") or item.get("downloadURL") or item.get("title"))
            unique_products[key] = summarize_product(item)
    return checks, list(unique_products.values())


def usgs_lidar_proof(
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

    one_m_checks, one_m_products = coverage_for_dataset(points, USGS_1M_DATASET, "GeoTIFF")
    one_m_passed = all(item["covered"] for item in one_m_checks)

    opr_checks: list[dict[str, Any]] = []
    opr_products: list[dict[str, Any]] = []
    opr_passed = False
    if not one_m_passed:
        opr_checks, opr_products = coverage_for_dataset(points, USGS_OPR_DATASET)
        opr_passed = all(item["covered"] for item in opr_checks)

    lpc_checks: list[dict[str, Any]] = []
    lpc_products: list[dict[str, Any]] = []
    if not one_m_passed and not opr_passed:
        lpc_checks, lpc_products = coverage_for_dataset(points, USGS_LPC_DATASET)

    passed = one_m_passed or opr_passed
    selected_dataset = USGS_1M_DATASET if one_m_passed else USGS_OPR_DATASET if opr_passed else None
    selected_products = one_m_products if one_m_passed else opr_products if opr_passed else []
    return {
        "schemaVersion": "looper-course-terrain-source-proof-v1",
        "courseId": course_id,
        "provider": "usgs-3dep",
        "verifiedAt": utc_now(),
        "qualityContract": "USGS 3DEP lidar-derived bare-earth DEM coverage across padded course footprint",
        "qualityBasis": "Standard 1-meter DEM is preferred; full-footprint OPR bare-earth DEM is accepted when the standard product is unavailable. Coarse seamless DEM fallback is rejected.",
        "queryEndpoint": TNM_PRODUCTS,
        "paddedBoundsWgs84": [round(value, 7) for value in padded],
        "paddingMeters": padding_m,
        "selectedDataset": selected_dataset,
        "selectedProducts": selected_products,
        "oneMeter": {"passed": one_m_passed, "sampleChecks": one_m_checks, "products": one_m_products},
        "opr": {"passed": opr_passed, "sampleChecks": opr_checks, "products": opr_products},
        "lidarPointCloudDiagnostic": {"sampleChecks": lpc_checks, "products": lpc_products},
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
        proof = usgs_lidar_proof(config["courseId"], bounds, padding)
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
        "selectedDataset": proof.get("selectedDataset"),
        "oneMeterChecks": (proof.get("oneMeter") or {}).get("sampleChecks"),
        "oprChecks": (proof.get("opr") or {}).get("sampleChecks"),
        "lidarPointCloudChecks": (proof.get("lidarPointCloudDiagnostic") or {}).get("sampleChecks"),
        "selectedProductCount": len(proof.get("selectedProducts") or []),
    }, indent=2))
    if not proof["passed"]:
        raise SystemExit("Terrain source quality gate failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
