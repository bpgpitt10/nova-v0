#!/usr/bin/env python3
"""Verify that configured terrain sources meet Looper's source-quality contract.

For USGS courses, use the official 3DEP Elevation Index source-data layers.
Proof is route-aware: it samples tee, middle, and green-route positions for all
18 holes instead of rectangular course-bounds corners, which can legitimately
fall in oceans/lakes at coastal courses. A US course passes only when every
playable-route sample is covered by a published high-resolution source DEM
(<=2 m) or the standard 1-meter product. LPC-only coverage remains diagnostic.
"""
from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

import build_osm_course_package_v3 as v3

INDEX_BASE = "https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer"
LAYER_1M = 1
LAYER_LPC = 8
LAYER_SOURCE_DEM = 11
MAX_SOURCE_DEM_GSD_M = 2.0
ROUTE_SAMPLE_POSITIONS = ("tee", "middle", "green")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
                time.sleep(1.0 * (attempt + 1))
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
        "workunit", "workunit_id", "project", "project_id", "collect_start", "collect_end",
        "ql", "spec", "p_method", "dem_gsd_meters", "horiz_crs", "vert_crs", "geoid",
        "lpc_pub_date", "lpc_category", "sourcedem_pub_date", "sourcedem_category",
        "onemeter_category", "onemeter_reason", "seamless_category", "seamless_reason",
        "lpc_link", "sourcedem_link", "metadata_link",
    )
    return {key: attrs.get(key) for key in keep if attrs.get(key) is not None}


def high_res_source_dems(source_dem: list[dict[str, Any]]) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for attrs in source_dem:
        try:
            gsd = float(attrs.get("dem_gsd_meters"))
        except (TypeError, ValueError):
            continue
        category = str(attrs.get("sourcedem_category") or "").strip().lower()
        available = bool(attrs.get("sourcedem_link")) or category in {"available", "published", "production"}
        if gsd <= MAX_SOURCE_DEM_GSD_M and available:
            accepted.append(attrs)
    return accepted


def point_contract(label: str, hole: int, position: str, lat: float, lon: float) -> dict[str, Any]:
    source_dem = index_features_at_point(LAYER_SOURCE_DEM, lon, lat)
    high_res_source = high_res_source_dems(source_dem)
    if high_res_source:
        one_m: list[dict[str, Any]] = []
        lpc: list[dict[str, Any]] = []
        accepted = True
        reason = "high-resolution-source-dem"
    else:
        one_m = index_features_at_point(LAYER_1M, lon, lat)
        accepted = bool(one_m)
        reason = "standard-one-meter" if accepted else None
        lpc = [] if accepted else index_features_at_point(LAYER_LPC, lon, lat)

    return {
        "label": label,
        "hole": hole,
        "position": position,
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "accepted": accepted,
        "acceptedBy": reason,
        "standardOneMeterCovered": bool(one_m),
        "highResolutionSourceDemCovered": bool(high_res_source),
        "lidarPointCloudCovered": bool(lpc),
        "sourceDemWorkUnits": [compact_source_feature(item) for item in high_res_source],
        "lidarWorkUnits": [compact_source_feature(item) for item in lpc],
    }


def route_samples(hole_routes: dict[int, dict[str, Any]]) -> list[tuple[str, int, str, float, float]]:
    samples: list[tuple[str, int, str, float, float]] = []
    for hole in range(1, 19):
        route = hole_routes[hole]["geometry"]
        if len(route) < 2:
            raise ValueError(f"Hole {hole} route is too short for source verification")
        indices = (0, len(route) // 2, len(route) - 1)
        for position, index in zip(ROUTE_SAMPLE_POSITIONS, indices):
            lat, lon = route[index]
            samples.append((f"h{hole}-{position}", hole, position, float(lat), float(lon)))
    return samples


def usgs_source_proof(course_id: str, hole_routes: dict[int, dict[str, Any]]) -> dict[str, Any]:
    samples = route_samples(hole_routes)
    checks_by_label: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {
            pool.submit(point_contract, label, hole, position, lat, lon): label
            for label, hole, position, lat, lon in samples
        }
        for future in as_completed(futures):
            result = future.result()
            checks_by_label[result["label"]] = result

    checks = [checks_by_label[label] for label, *_ in samples]
    unique_source_workunits: dict[str, dict[str, Any]] = {}
    unique_lpc_workunits: dict[str, dict[str, Any]] = {}
    for check in checks:
        for item in check["sourceDemWorkUnits"]:
            key = str(item.get("workunit_id") or item.get("workunit") or item.get("sourcedem_link"))
            unique_source_workunits[key] = item
        for item in check["lidarWorkUnits"]:
            key = str(item.get("workunit_id") or item.get("workunit") or item.get("lpc_link"))
            unique_lpc_workunits[key] = item

    failed = [item["label"] for item in checks if not item["accepted"]]
    passed = not failed
    gsd_values = [
        float(unit["dem_gsd_meters"])
        for unit in unique_source_workunits.values()
        if unit.get("dem_gsd_meters") is not None
    ]
    return {
        "schemaVersion": "looper-course-terrain-source-proof-v1",
        "courseId": course_id,
        "provider": "usgs-3dep",
        "verifiedAt": utc_now(),
        "qualityContract": "Official USGS 3DEP <=2 m published source DEM or standard 1-meter product at tee/mid-route/green samples for all 18 holes",
        "qualityBasis": "3DEP source DEM/LPC work units are lidar-source products in CONUS. Route-aware sampling avoids requiring land LiDAR outside the playable course footprint at coastal courses.",
        "indexService": INDEX_BASE,
        "sampleStrategy": "tee, middle OSM route vertex, and final OSM route vertex for each of 18 holes",
        "sampleCount": len(checks),
        "maximumAcceptedSourceDemGsdMeters": MAX_SOURCE_DEM_GSD_M,
        "failedSamples": failed,
        "sampleChecks": checks,
        "sourceDemWorkUnits": list(unique_source_workunits.values()),
        "lidarWorkUnits": list(unique_lpc_workunits.values()),
        "minimumObservedSourceDemGsdMeters": min(gsd_values) if gsd_values else None,
        "maximumObservedSourceDemGsdMeters": max(gsd_values) if gsd_values else None,
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

    if provider == "usgs-3dep":
        proof = usgs_source_proof(config["courseId"], hole_routes)
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
        "sampleCount": proof.get("sampleCount"),
        "failedSamples": proof.get("failedSamples"),
        "sourceDemWorkUnitCount": len(proof.get("sourceDemWorkUnits") or []),
        "sourceDemGsdMeters": [proof.get("minimumObservedSourceDemGsdMeters"), proof.get("maximumObservedSourceDemGsdMeters")],
        "workUnits": [
            {
                "workunit": unit.get("workunit"),
                "project": unit.get("project"),
                "ql": unit.get("ql"),
                "dem_gsd_meters": unit.get("dem_gsd_meters"),
            }
            for unit in proof.get("sourceDemWorkUnits") or []
        ],
    }, indent=2))
    if not proof["passed"]:
        raise SystemExit("Terrain source quality gate failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
