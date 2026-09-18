#!/usr/bin/env python3
"""Generic terrain importer entrypoint with efficient NRCan COG window acquisition.

The core compiler/cache contract lives in import_course_terrain.py. This entrypoint
replaces only NRCan source acquisition: the official hrdem-lidar STAC `dtm` COG
is window-read to the course bbox instead of downloading whole project rasters.
"""
from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

import rasterio
from rasterio.windows import Window, from_bounds
from rasterio.warp import transform_bounds

import import_course_terrain as core


def discover_nrcan(bbox: tuple[float, float, float, float]):
    query = urllib.parse.urlencode({
        "collections": "hrdem-lidar",
        "bbox": ",".join(f"{value:.7f}" for value in bbox),
        "limit": 100,
    })
    url = f"{core.NRCAN_API}?{query}"
    catalog = core.get_json(url)
    products = []
    for feature in catalog.get("features") or []:
        if not isinstance(feature, dict):
            continue
        assets = feature.get("assets") or {}
        if not isinstance(assets, dict):
            continue
        asset = assets.get("dtm")
        key = "dtm"
        if not isinstance(asset, dict):
            candidates = []
            for candidate_key, candidate in assets.items():
                if not isinstance(candidate, dict):
                    continue
                text = f"{candidate_key} {candidate.get('title', '')} {candidate.get('description', '')}".lower()
                if any(token in text for token in ("dsm", "mns", "surface model", "hillshade", "slope", "aspect")):
                    continue
                if any(token in text for token in ("dtm", "mnt", "digital terrain model", "terrain model")):
                    candidates.append((candidate_key, candidate))
            if candidates:
                key, asset = candidates[0]
        if not isinstance(asset, dict):
            continue
        href = asset.get("href")
        if not isinstance(href, str) or not href.startswith("http"):
            continue
        products.append({
            "id": f"{feature.get('id')}:{key}",
            "itemId": feature.get("id"),
            "assetKey": key,
            "url": href,
            "title": asset.get("title") or "Digital Terrain Model (COG)",
            "datetime": (feature.get("properties") or {}).get("datetime"),
        })
    seen = set()
    products = [item for item in products if not (item["url"] in seen or seen.add(item["url"]))]
    if not products:
        raise RuntimeError("nrcan-hrdem-lidar returned no DTM COG assets")
    return {
        "provider": "nrcan-hrdem-lidar",
        "dataset": "NRCan HRDEM LiDAR DTM",
        "lidarDerived": True,
        "license": "Open Government Licence - Canada",
        "catalogQueryUrl": url,
    }, products


def clip_remote_cog(url: str, bbox: tuple[float, float, float, float], output: Path) -> None:
    env = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "GDAL_HTTP_MULTIRANGE": "YES",
        "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff",
    }
    with rasterio.Env(**env):
        with rasterio.open(url) as src:
            if not src.crs:
                raise RuntimeError(f"NRCan DTM has no CRS: {url}")
            left, bottom, right, top = transform_bounds(
                "EPSG:4326", src.crs, *bbox, densify_pts=21
            )
            raw = from_bounds(left, bottom, right, top, transform=src.transform)
            full = Window(0, 0, src.width, src.height)
            try:
                window = raw.round_offsets().round_lengths().intersection(full)
            except Exception as exc:
                raise RuntimeError(f"NRCan DTM does not overlap course bbox: {url}") from exc
            if window.width <= 0 or window.height <= 0:
                raise RuntimeError(f"NRCan DTM has empty course window: {url}")
            data = src.read(1, window=window)
            profile = src.profile.copy()
            profile.update(
                driver="GTiff",
                width=data.shape[1],
                height=data.shape[0],
                count=1,
                transform=src.window_transform(window),
                compress="deflate",
                tiled=True,
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(output, "w", **profile) as dst:
                dst.write(data, 1)


def acquire(provider, bbox, tmp):
    if provider != "nrcan-hrdem-lidar":
        return core.acquire(provider, bbox, tmp)

    meta, products = discover_nrcan(bbox)
    rasters = []
    records = []
    errors = []
    for index, product in enumerate(products):
        path = tmp / f"nrcan-dtm-window-{index:03d}.tif"
        try:
            clip_remote_cog(product["url"], bbox, path)
        except Exception as exc:
            errors.append({"id": product["id"], "error": str(exc)})
            continue
        rasters.append(path)
        records.append({
            **product,
            "accessMode": "cloud-optimized-geotiff-course-window",
            "courseWindowSha256": core.sha(path),
            "courseWindowBytes": path.stat().st_size,
        })

    if not rasters:
        raise RuntimeError(f"No NRCan DTM COG covered the course bbox; errors={json.dumps(errors)[:2000]}")
    source = {
        "schemaVersion": "looper-course-terrain-source-v1",
        **meta,
        "sourceBoundsWgs84": [round(value, 7) for value in bbox],
        "products": records,
        "rejectedProducts": errors,
        "retrievedAt": core.now(),
    }
    return rasters, source


core.acquire = acquire

if __name__ == "__main__":
    raise SystemExit(core.main())
