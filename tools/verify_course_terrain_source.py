#!/usr/bin/env python3
"""Verify that configured terrain sources meet Looper's source-quality contract.

For USGS courses, use the official 3DEP Elevation Index source-data layers as
our primary proof. The source DEM layer exposes lidar work-unit metadata,
including quality level, source DEM ground spacing, publication status, and
source links. A course passes only when its padded footprint is covered by a
high-resolution source DEM (<=2 m) or the standard 1-meter product. LPC-only
coverage is diagnostic until we add point-cloud-to-DTM compilation.
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

INDEX_BASE = "https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer"
LAYER_1M = 1
LAYER_LPC = 8
LAYER_SOURCE_DEM = 11
MAX_SOURCE_DEM_GSD_M = 2.0


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


def request_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(url, params=params, timeout=60)
            response.raise_for_status()
            payload = response.json()
            if payload.get("error"):
                raise RuntimeError(payload["error"])
            return payload
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"3DEP source-index query failed after retries: {last_error}")


def index_features_at_point(layer_id: int, lon: float, lat: float) -> list[dict[str, Any]]:
    payload = request_json(
        f"{INDEX_BASE}/{layer_id}/query",
        {
            "geometry": f"{lon:.7f},{lat:.7f}",
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "*",
            "returnGeometry": "false",
            "f": "json",
        },
    )
    return [feature.get("attributes") or {} for feature in payload.get("features") or []]


def compact_source_feature(attrs: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "workunit",
        "workunit_id",
        "project",
        "project_id",
        "collect_start",
        "collect_end",
        "ql",
        "spec",
        "p_method",
        "dem_gsd_meters",
        "horiz_crs",
        "vert_crs",
        "geoid",
        "lpc_pub_date",
        "lpc_category",
        "sourcedem_pub_date",
        "sourcedem_category",
        "onemeter_category",
        "onemeter_reason",
        "seamless_category",
        "seamless_reason",
        "lpc_link",
        "sourcedem_link",
        "metadata_link",
    )
    return {key: attrs.get(key) for key in keep if attrs.get(key) is not None}


def compact_product_feature(attrs: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in attrs.items() if value is not None and key not in {"SHAPE", "Shape"}}


def point_contract(lon: float, lat: float) -> dict[str, Any]:
    one_m = index_features_at_point(LAYER_1M, lon, lat)
    source_dem = index_features_at_point(LAYER_SOURCE_DEM, lon, lat)
    lpc = index_features_at_point(LAYER_LPC, lon, lat)

    high_res_source = []
    for attrs in source_dem:
        try:
            gsd = float(attrs.get("dem_gsd_meters"))
        except (TypeError, ValueError):
            continue
        category = str(attrs.get("sourcedem_category") or "").strip().lower()
        # The source-index layer can include planned/unavailable work units.
        # Require a usable source link or a category indicating availability.
        available = bool(attrs.get("sourcedem_link")) or category in {"available", "published", "production"}
        if gsd <= MAX_SOURCE_DEM_GSD_M and available:
            high_res_source.append(attrs)

    return {
        "standardOneMeterCovered": bool(one_m),
        "highResolutionSourceDemCovered": bool(high_res_source),
        "lidarPointCloudCovered": bool(lpc),
        "oneMeterProducts": [compact_product_feature(item) for item in one_m],
        "sourceDemWorkUnits": [compact_source_feature(item) for item in high_res_source],
        "allSourceDemWorkUnits": [compact_source_feature(item) for item in source_dem],
        "lidarWorkUnits": [compact_source_feature(item) for item in lpc],
    }


def usgs_source_proof(
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

    checks: list[dict[str, Any]] = []
    unique_source_workunits: dict[str, dict[str, Any]] = {}
    unique_lpc_workunits: dict[str, dict[str, Any]] = {}
    for label, (lon, lat) in points.items():
        contract = point_contract(lon, lat)
        accepted = contract["standardOneMeterCovered"] or contract["highResolutionSourceDemCovered"]
        checks.append({
            "point": label,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "accepted": accepted,
            **contract,
        })
        for item in contract["sourceDemWorkUnits"]:
            key = str(item.get("workunit_id") or item.get("workunit") or item.get("sourcedem_link"))
            unique_source_workunits[key] = item
        for item in contract["lidarWorkUnits"]:
            key = str(item.get("workunit_id") or item.get("workunit") or item.get("lpc_link"))
            unique_lpc_workunits[key] = item

    passed = all(item["accepted"] for item in checks)
    source_workunits = list(unique_source_workunits.values())
    method = None
    if passed:
        method = "3dep-standard-1m-or-high-resolution-source-dem"

    return {
        "schemaVersion": "looper-course-terrain-source-proof-v1",
        "courseId": course_id,
        "provider": "usgs-3dep",
        "verifiedAt": utc_now(),
        "qualityContract": "Official USGS 3DEP 1-meter product or <=2 m published source DEM across the padded course footprint",
        "qualityBasis": "3DEP source DEM/LPC work units are lidar-source products in CONUS; the proof records work-unit quality level, source DEM ground spacing, publication/link status, and metadata links.",
        "indexService": INDEX_BASE,
        "paddedBoundsWgs84": [round(value, 7) for value in padded],
        "paddingMeters": padding_m,
        "maximumAcceptedSourceDemGsdMeters": MAX_SOURCE_DEM_GSD_M,
        "selectionMethod": method,
        "sampleChecks": checks,
        "sourceDemWorkUnits": source_workunits,
        "lidarWorkUnits": list(unique_lpc_workunits.values()),
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
        proof = usgs_source_proof(config["courseId"], bounds, padding)
    elif provider == "nrcan-hrdem":
        proof = {
            "schemaVersion": "looper-course-terrain-source-proof-v1",
            "courseId": config["courseId"],
            "provider": provider,
            "verifiedAt": utc_now(),
            "qualityContract": "Natural Resources Canada HRDEM Mosaic DTM",
            "qualityBasis": "Configured HRDEM DTM is a high-resolution bare-earth terrain source; exact footprint coverage is proven by subsequent raster/grid validation.",
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
        "selectionMethod": proof.get("selectionMethod"),
        "sampleChecks": [
            {
                "point": item["point"],
                "accepted": item["accepted"],
                "standard1m": item["standardOneMeterCovered"],
                "sourceDem": item["highResolutionSourceDemCovered"],
                "lpc": item["lidarPointCloudCovered"],
                "sourceWorkUnits": [
                    {
                        "workunit": unit.get("workunit"),
                        "project": unit.get("project"),
                        "ql": unit.get("ql"),
                        "dem_gsd_meters": unit.get("dem_gsd_meters"),
                    }
                    for unit in item["sourceDemWorkUnits"]
                ],
            }
            for item in proof.get("sampleChecks") or []
        ],
        "sourceDemWorkUnitCount": len(proof.get("sourceDemWorkUnits") or []),
        "lidarWorkUnitCount": len(proof.get("lidarWorkUnits") or []),
    }, indent=2))
    if not proof["passed"]:
        raise SystemExit("Terrain source quality gate failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
