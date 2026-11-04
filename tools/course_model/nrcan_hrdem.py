#!/usr/bin/env python3
"""NRCan HRDEM (Canada) elevation for the course loader.

USGS 3DEP and the USGS LiDAR point clouds stop at the border, so Canadian
courses (Cabot Cliffs, 11/3) failed at the find stage. Natural Resources
Canada publishes the High Resolution Digital Elevation Model (HRDEM, from
LiDAR) as cloud-optimized GeoTIFFs behind a STAC API:

  https://datacube.services.geo.ca/stac/api/
  collections hrdem-mosaic-1m, hrdem-lidar (per acquisition project), hrdem-mosaic-2m
  assets: dtm (bare earth), dsm (surface, where published)

This module finds the tiles covering a course and reads just the needed
window of each COG into a target grid (any CRS), mosaicking tiles and
leaving NaN where nothing covers. The DSM - DTM difference gives a canopy
height model where the DSM exists, standing in for the USGS point cloud.

Licence: Open Government Licence - Canada.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Iterable

STAC_ROOT = 'https://datacube.services.geo.ca/stac/api'
COLLECTIONS = ('hrdem-mosaic-1m', 'hrdem-lidar', 'hrdem-mosaic-2m')
USER_AGENT = 'the-looper-course-loader/1.0'
LICENCE = 'Open Government Licence - Canada (NRCan HRDEM)'

# GDAL reads remote COGs by HTTP range requests; don't list directories.
os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('CPL_VSIL_CURL_ALLOWED_EXTENSIONS', '.tif,.tiff')
os.environ.setdefault('GDAL_HTTP_MAX_RETRY', '4')
os.environ.setdefault('GDAL_HTTP_RETRY_DELAY', '5')


def _post_json(url: str, body: dict, timeout: int = 60, tries: int = 4) -> dict:
    last: Exception | None = None
    data = json.dumps(body).encode()
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={
                'User-Agent': USER_AGENT, 'Content-Type': 'application/json', 'Accept': 'application/geo+json'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            last = exc
            if isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500 and exc.code != 429:
                break
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'NRCan STAC search failed: {last}')


def _asset_href(assets: dict, kind: str) -> str | None:
    """'dtm' / 'dsm' asset href; tolerant of key variants ("dtm-cog", "DSM")."""
    if not isinstance(assets, dict):
        return None
    for key, asset in assets.items():
        if not isinstance(asset, dict):
            continue
        k = key.lower()
        if k == kind or k.startswith(kind + '-') or k.startswith(kind + '_') or k.endswith('-' + kind):
            href = asset.get('href')
            if isinstance(href, str) and href.startswith('http'):
                return href
    return None


def search(bbox_lonlat: Iterable[float], collections: Iterable[str] = COLLECTIONS) -> dict | None:
    """First collection with DTM tiles over the bbox: {collection, items: [{id, dtm, dsm}]}."""
    w, s, e, n = [float(v) for v in bbox_lonlat]
    for collection in collections:
        payload = _post_json(f'{STAC_ROOT}/search', {'collections': [collection], 'bbox': [w, s, e, n], 'limit': 50})
        items = []
        for feature in payload.get('features') or []:
            dtm = _asset_href(feature.get('assets') or {}, 'dtm')
            if dtm:
                items.append({'id': feature.get('id'), 'dtm': dtm, 'dsm': _asset_href(feature.get('assets') or {}, 'dsm')})
        if items:
            return {'collection': collection, 'items': items, 'stacRoot': STAC_ROOT, 'licence': LICENCE}
    return None


def read_to_grid(hrefs: Iterable[str], dst_crs: str, dst_transform: Any, width: int, height: int):
    """Mosaic the COGs into a float64 (height, width) array on the target grid
    (bilinear). Only each source's window over the target is read. NaN where
    no source covers or the source is nodata."""
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, reproject, transform_bounds
    from rasterio.windows import from_bounds

    out = np.full((height, width), np.nan, dtype='float64')
    left = dst_transform.c
    top = dst_transform.f
    right = left + dst_transform.a * width
    bottom = top + dst_transform.e * height
    for href in hrefs:
        with rasterio.open(href) as src:
            sb = transform_bounds(dst_crs, src.crs, left, bottom, right, top, densify_pts=21)
            # Pad by a few source pixels so bilinear edges have neighbours.
            pad = 4 * abs(src.transform.a)
            sb = (sb[0] - pad, sb[1] - pad, sb[2] + pad, sb[3] + pad)
            sl, sbm, sr, st = src.bounds
            if sb[2] <= sl or sb[0] >= sr or sb[3] <= sbm or sb[1] >= st:
                continue
            window = from_bounds(max(sb[0], sl), max(sb[1], sbm), min(sb[2], sr), min(sb[3], st), src.transform)
            window = window.round_offsets().round_lengths()
            if window.width < 2 or window.height < 2:
                continue
            data = src.read(1, window=window, masked=True).astype('float64').filled(np.nan)
            tile = np.full((height, width), np.nan, dtype='float64')
            reproject(
                source=data, destination=tile,
                src_transform=src.window_transform(window), src_crs=src.crs, src_nodata=np.nan,
                dst_transform=dst_transform, dst_crs=dst_crs, dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
            fill = np.isnan(out) & np.isfinite(tile)
            out[fill] = tile[fill]
    return out


def describe(found: dict) -> dict:
    return {
        'provider': 'NRCan HRDEM',
        'providerKey': 'nrcan-hrdem',
        'collection': found['collection'],
        'items': [i['id'] for i in found['items']],
        'hasDsm': any(i.get('dsm') for i in found['items']),
        'stacRoot': found.get('stacRoot', STAC_ROOT),
        'licence': found.get('licence', LICENCE),
    }
