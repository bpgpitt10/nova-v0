#!/usr/bin/env python3
"""LINZ New Zealand 1 m LiDAR elevation for the course loader.

New Zealand has national LiDAR coverage, published by Toitū Te Whenua LINZ as
cloud-optimized GeoTIFFs on AWS open data with a static STAC catalog:

  https://nz-elevation.s3.ap-southeast-2.amazonaws.com/catalog.json
    <region>/<survey>/dem_1m/2193/collection.json   bare earth (DEM)
    <region>/<survey>/dsm_1m/2193/collection.json   surface (DSM), same tiles
  items: one 1:10k map tile each (WGS84 bbox), asset 'visual' = the COG

This finds the newest survey that covers a course and returns its tiles in
the shape nrcan_hrdem.search returns ({collection, items: [{id, dtm, dsm}]}),
so the same COG reader builds the 1 m DEM and the DSM - DEM canopy heights.

Licence: CC BY 4.0, Toitū Te Whenua Land Information New Zealand.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Iterable

ROOT = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/'
USER_AGENT = 'the-looper-course-loader/1.0'
LICENCE = 'CC BY 4.0, Toitū Te Whenua Land Information New Zealand (LINZ)'
MIN_COVER = 0.95


def in_nz(w: float, s: float, e: float, n: float) -> bool:
    return -47.6 <= s and n <= -34.0 and 166.0 <= w and e <= 179.0


def _get_json(url: str, tries: int = 3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=40) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            last = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code == 404:
                return None
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'LINZ elevation catalog: {url}: {last}')


def _join(base: str, href: str) -> str:
    if href.startswith('http'):
        return href
    return base.rsplit('/', 1)[0] + '/' + href.removeprefix('./')


def _overlap(a, b) -> float:
    """Area of the intersection of two lon/lat boxes (degrees squared)."""
    w, s = max(a[0], b[0]), max(a[1], b[1])
    e, n = min(a[2], b[2]), min(a[3], b[3])
    return max(0.0, e - w) * max(0.0, n - s)


def _cover(box, tiles) -> float:
    """Share of the box covered by the tiles (sampled on a 20x20 lattice)."""
    w, s, e, n = box
    hit = 0
    for i in range(20):
        for j in range(20):
            x, y = w + (i + 0.5) * (e - w) / 20, s + (j + 0.5) * (n - s) / 20
            hit += any(t[0] <= x <= t[2] and t[1] <= y <= t[3] for t in tiles)
    return hit / 400


def search(bbox_lonlat: Iterable[float]) -> dict | None:
    """Newest 1 m DEM survey covering the course: {collection, items: [{id, dtm, dsm}]}."""
    box = [float(v) for v in bbox_lonlat]
    if not in_nz(*box):
        return None
    catalog = _get_json(ROOT + 'catalog.json') or {}
    dem_links = [_join(ROOT + 'catalog.json', link['href']) for link in catalog.get('links', [])
                 if link.get('rel') == 'child' and '/dem_1m/' in link.get('href', '')]
    with ThreadPoolExecutor(16) as pool:
        collections = list(zip(dem_links, pool.map(_get_json, dem_links)))
    candidates = []
    for url, col in collections:
        if not col:
            continue
        bboxes = ((col.get('extent') or {}).get('spatial') or {}).get('bbox') or []
        if not any(_overlap(box, b) > 0 for b in bboxes):
            continue
        interval = (((col.get('extent') or {}).get('temporal') or {}).get('interval') or [[None, None]])[0]
        candidates.append((interval[-1] or interval[0] or '', url, col))
    for _, url, col in sorted(candidates, key=lambda c: c[0], reverse=True):
        item_urls = [_join(url, link['href']) for link in col.get('links', []) if link.get('rel') == 'item']
        with ThreadPoolExecutor(32) as pool:
            items = [i for i in pool.map(_get_json, item_urls) if i]
        hits = []
        for item in items:
            b = item.get('bbox')
            asset = (item.get('assets') or {}).get('visual') or {}
            if not b or not asset.get('href') or _overlap(box, b) <= 0:
                continue
            self_url = next((_join(url, link['href']) for link in item.get('links', []) if link.get('rel') == 'self'),
                            _join(url, f"./{item.get('id')}.json"))
            dtm = _join(self_url, asset['href'])
            hits.append({'id': item.get('id'), 'bbox': b, 'dtm': dtm,
                         'dsm': dtm.replace('/dem_1m/', '/dsm_1m/')})
        if hits and _cover(box, [h['bbox'] for h in hits]) >= MIN_COVER:
            # The DSM collection of the same survey has the same tiles.
            dsm_col = _get_json(url.replace('/dem_1m/', '/dsm_1m/'))
            if not dsm_col:
                for h in hits:
                    h['dsm'] = None
            return {'collection': col.get('title') or url, 'collectionUrl': url, 'items': hits,
                    'stacRoot': ROOT + 'catalog.json', 'licence': LICENCE, 'provider': 'linz-1m'}
    return None


if __name__ == '__main__':
    import sys
    found = search([float(v) for v in sys.argv[1:5]])
    print(json.dumps(found, indent=1)[:4000] if found else 'none')
