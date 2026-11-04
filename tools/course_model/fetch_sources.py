#!/usr/bin/env python3
"""Fetch UNFILTERED geographic sources for the course-model prototype.

  osm  -> every OSM node/way/relation in the course bbox (no tag allowlist,
          no route clipping), saved raw so nothing is discarded at source.
  dem  -> USGS 3DEP bare-earth DEM exported directly in UTM 16N metres at
          1 m, so pixels are true ground metres (the importer's existing
          export is EPSG:3857, where a "1 m" pixel is ~0.84 m at FarmLinks).

The course bbox is reused from the importer's existing DEM acquisition record
so both pipelines cover the same ground.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

USER_AGENT = 'the-looper-course-model-prototype/0.1 (github.com/bpgpitt10)'
OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
DEM_EXPORT = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
TARGET_CRS = 'EPSG:26916'  # NAD83 / UTM zone 16N (FarmLinks)
R_MERC = 6378137.0


def merc_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / R_MERC)
    lat = math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)
    return lon, lat


def course_bbox_lonlat(dem_source: Path) -> tuple[float, float, float, float]:
    b = json.loads(dem_source.read_text())['bbox3857']
    corners = [merc_to_lonlat(x, y) for x in (b[0], b[2]) for y in (b[1], b[3])]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    return min(lons), min(lats), max(lons), max(lats)


def http_get(url: str, data: bytes | None = None, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, data=data, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def cmd_osm(args: argparse.Namespace) -> int:
    w, s, e, n = course_bbox_lonlat(Path(args.dem_source))
    query = f'[out:json][timeout:240];(nwr({s},{w},{n},{e}););out body geom qt;'
    payload = None
    errors = []
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                t0 = time.time()
                body = http_get(url, urllib.parse.urlencode({'data': query}).encode(), timeout=300)
                payload = json.loads(body)
                print(f'overpass ok url={url} bytes={len(body)} seconds={time.time() - t0:.1f}')
                break
            except Exception as exc:  # noqa: BLE001 - record and retry
                errors.append(f'{url} attempt {attempt + 1}: {exc}')
                print(errors[-1])
                time.sleep(10 * (attempt + 1))
        if payload is not None:
            break
    if payload is None:
        print('overpass failed on all endpoints', file=sys.stderr)
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    raw_path = out / 'osm-full.json.gz'
    with gzip.open(raw_path, 'wt', encoding='utf-8', compresslevel=9) as fh:
        json.dump(payload, fh, separators=(',', ':'))

    elements = payload.get('elements', [])
    by_type = Counter(el.get('type') for el in elements)
    tag_pairs = Counter()
    for el in elements:
        for k, v in (el.get('tags') or {}).items():
            if k in {'golf', 'natural', 'landuse', 'leisure', 'highway', 'building',
                     'waterway', 'water', 'surface', 'barrier', 'man_made', 'power', 'amenity'}:
                tag_pairs[f'{k}={v if k != "building" else "*"}'] += 1
    summary = {
        'schemaVersion': 'looper-course-model-osm-summary-v1',
        'bboxLonLat': [w, s, e, n],
        'query': query,
        'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'osmBase': payload.get('osm3s', {}).get('timestamp_osm_base'),
        'elementsByType': dict(by_type),
        'taggedElements': sum(1 for el in elements if el.get('tags')),
        'tagCounts': dict(sorted(tag_pairs.items(), key=lambda kv: (-kv[1], kv[0]))),
        'compressedBytes': raw_path.stat().st_size,
        'license': 'ODbL 1.0, (c) OpenStreetMap contributors',
        'errorsBeforeSuccess': errors,
    }
    (out / 'osm-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k: summary[k] for k in ('elementsByType', 'taggedElements', 'compressedBytes')}))
    return 0


TILE_M = 1500


def cmd_dem(args: argparse.Namespace) -> int:
    import numpy as np
    import rasterio
    from pyproj import Transformer
    from grid_io import save_grid

    w, s, e, n = course_bbox_lonlat(Path(args.dem_source))
    crs = args.crs or TARGET_CRS
    epsg = crs.split(':')[1]
    to_utm = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    xs, ys = zip(*[to_utm.transform(lon, lat) for lon in (w, e) for lat in (s, n)])
    minx, miny = math.floor(min(xs)), math.floor(min(ys))
    maxx, maxy = math.ceil(max(xs)), math.ceil(max(ys))
    width, height = int(maxx - minx), int(maxy - miny)
    source = json.loads(Path(args.dem_source).read_text())
    if source.get('demProvider') == 'nrcan-hrdem':
        return _dem_from_hrdem(args, source, crs, minx, maxy, width, height)
    # The 3DEP ImageServer returns HTTP 500 for large exports (Muirfield's
    # 3.3 x 3.6 km box), so fetch <= TILE_M tiles and mosaic them.
    tmp = Path(args.tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    arr = np.full((height, width), np.nan, dtype='float64')
    urls = []
    t0 = time.time()
    for ty in range(0, height, TILE_M):
        for tx in range(0, width, TILE_M):
            tw, th = min(TILE_M, width - tx), min(TILE_M, height - ty)
            bx0, by1 = minx + tx, maxy - ty
            params = {
                'bbox': f'{bx0},{by1 - th},{bx0 + tw},{by1}', 'bboxSR': epsg, 'imageSR': epsg,
                'size': f'{tw},{th}', 'format': 'tiff', 'pixelType': 'F32',
                'noDataInterpretation': 'esriNoDataMatchAny',
                'interpolation': 'RSP_BilinearInterpolation', 'f': 'image',
            }
            url = DEM_EXPORT + '?' + urllib.parse.urlencode(params)
            urls.append(url)
            tif = tmp / f'dem-{tx}-{ty}.tif'
            for attempt in range(4):
                try:
                    tif.write_bytes(http_get(url, timeout=600))
                    break
                except Exception as exc:  # noqa: BLE001
                    if attempt == 3:
                        raise
                    print(f'dem tile {tx},{ty} attempt {attempt + 1}: {exc}')
                    time.sleep(10 * (attempt + 1))
            with rasterio.open(tif) as ds:
                tile = ds.read(1).astype('float64')
                if ds.nodata is not None:
                    tile[tile == ds.nodata] = np.nan
                if tile.shape != (th, tw) or abs(ds.transform.c - bx0) > 0.01 or abs(ds.transform.f - by1) > 0.01:
                    raise RuntimeError(f'dem tile {tx},{ty} came back {tile.shape} at {ds.transform}')
                crs = ds.crs.to_string() if ds.crs else crs
            arr[ty:ty + th, tx:tx + tw] = tile
    print(f'dem tiles={len(urls)} seconds={time.time() - t0:.1f} size={width}x{height}')
    from affine import Affine
    transform = Affine(1.0, 0.0, float(minx), 0.0, -1.0, float(maxy))
    nodata = None
    url = urls[0] if len(urls) == 1 else f'{len(urls)} tiles of <= {TILE_M} m; first: {urls[0]}'
    bad = ~np.isfinite(arr) | (arr < -1000) | (arr > 9000)
    if nodata is not None:
        bad |= arr == nodata
    pixel = float(transform.a)
    header = save_grid(
        Path(args.out) / 'dem-utm-1m', arr, crs=crs,
        origin_x=transform.c, origin_y=transform.f, pixel_size=pixel,
        scale=0.01, nodata_mask=bad,
        provenance={
            'dataset': 'USGS 3DEP Bare Earth DEM (dynamic service, best available source)',
            'exportUrl': url, 'requestedPixelMeters': 1.0, 'license': 'Public domain (USGS)',
            'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'rasterioTransform': list(transform)[:6],
        },
    )
    valid = arr[~bad]
    print(json.dumps({'width': header['width'], 'height': header['height'], 'pixel': pixel,
                      'validCells': header['validCells'],
                      'elevMin': float(valid.min()) if valid.size else None,
                      'elevMax': float(valid.max()) if valid.size else None}))
    return 0


def _hrdem_grid(source: dict, kind: str, crs: str, minx: float, maxy: float, width: int, height: int):
    """NRCan HRDEM `kind` ('dtm' or 'dsm') on the course's UTM 1 m grid."""
    from affine import Affine
    import nrcan_hrdem  # noqa: E402  (same folder)

    hrefs = [i[kind] for i in (source.get('hrdem') or {}).get('items') or [] if i.get(kind)]
    transform = Affine(1.0, 0.0, float(minx), 0.0, -1.0, float(maxy))
    return nrcan_hrdem.read_to_grid(hrefs, crs, transform, width, height), transform, hrefs


def _dem_from_hrdem(args, source: dict, crs: str, minx: float, maxy: float, width: int, height: int) -> int:
    """Canada: the bare-earth 1 m DEM from NRCan HRDEM's DTM (find stage chose it)."""
    import numpy as np
    from grid_io import save_grid

    t0 = time.time()
    arr, transform, hrefs = _hrdem_grid(source, 'dtm', crs, minx, maxy, width, height)
    bad = ~np.isfinite(arr) | (arr < -1000) | (arr > 9000)
    if bad.mean() > 0.5:
        raise SystemExit(f'NRCan HRDEM covers only {1 - bad.mean():.0%} of the course box')
    collection = (source.get('hrdem') or {}).get('collection')
    header = save_grid(
        Path(args.out) / 'dem-utm-1m', arr, crs=crs,
        origin_x=transform.c, origin_y=transform.f, pixel_size=1.0,
        scale=0.01, nodata_mask=bad,
        provenance={
            'dataset': f'NRCan HRDEM ({collection}) bare-earth DTM',
            'sources': hrefs, 'requestedPixelMeters': 1.0,
            'license': 'Open Government Licence - Canada',
            'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'rasterioTransform': list(transform)[:6],
        },
    )
    valid = arr[~bad]
    print(json.dumps({'provider': 'nrcan-hrdem', 'collection': collection, 'tiles': len(hrefs),
                      'width': header['width'], 'height': header['height'], 'validCells': header['validCells'],
                      'elevMin': float(valid.min()) if valid.size else None,
                      'elevMax': float(valid.max()) if valid.size else None,
                      'seconds': round(time.time() - t0, 1)}))
    return 0


def cmd_chm(args: argparse.Namespace) -> int:
    """Canada: canopy heights from NRCan HRDEM's DSM minus the DTM grid,
    aligned to dem-utm-1m (stands in for the USGS point-cloud lidar stage)."""
    import numpy as np
    from grid_io import load_grid, save_grid

    source = json.loads(Path(args.dem_source).read_text())
    dem_h, dem = load_grid(Path(args.dem))
    height, width = dem.shape
    t0 = time.time()
    dsm, _, hrefs = _hrdem_grid(source, 'dsm', dem_h['crs'], dem_h['originX'], dem_h['originY'], width, height)
    if not hrefs:
        raise SystemExit('NRCan HRDEM has no DSM over this course, so no tree heights (needs the surface model)')
    chm = np.clip(dsm - dem, 0, None)
    chm[chm > 70] = np.nan  # birds, wires, artefacts
    empty = ~np.isfinite(chm)
    out = Path(args.out)
    save_grid(out / 'chm-utm-1m', chm, crs=dem_h['crs'], origin_x=dem_h['originX'],
              origin_y=dem_h['originY'], pixel_size=dem_h['pixelSize'], scale=0.1, nodata_mask=empty,
              provenance={'source': hrefs, 'method': 'NRCan HRDEM DSM minus DTM (both LiDAR-derived), clipped at 0',
                          'license': 'Open Government Licence - Canada', 'alignedTo': 'dem-utm-1m'})
    valid = chm[~empty]
    report = {
        'schemaVersion': 'looper-course-model-lidar-stats-v1',
        'source': 'nrcan-hrdem-dsm-minus-dtm',
        'collection': (source.get('hrdem') or {}).get('collection'),
        'chm': {
            'width': width, 'height': height, 'pixelMeters': dem_h['pixelSize'],
            'cellsWithReturns': int((~empty).sum()), 'emptyCells': int(empty.sum()),
            'cellsOver3m': int((valid >= 3).sum()), 'cellsOver10m': int((valid >= 10).sum()),
            'p50': float(np.percentile(valid, 50)) if valid.size else None,
            'p95': float(np.percentile(valid, 95)) if valid.size else None,
            'max': float(valid.max()) if valid.size else None,
        },
        'seconds': round(time.time() - t0, 1),
    }
    (out / 'lidar-stats.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p_osm = sub.add_parser('osm')
    p_osm.add_argument('--dem-source', required=True)
    p_osm.add_argument('--out', required=True)
    p_dem = sub.add_parser('dem')
    p_dem.add_argument('--dem-source', required=True)
    p_dem.add_argument('--tmp', required=True)
    p_dem.add_argument('--out', required=True)
    p_dem.add_argument('--crs', help='target UTM CRS, e.g. EPSG:26917 (default zone 16)')
    p_chm = sub.add_parser('chm', help='Canada: canopy heights from NRCan HRDEM DSM - DTM')
    p_chm.add_argument('--dem-source', required=True)
    p_chm.add_argument('--dem', required=True, help='dem-utm-1m.json from the dem stage')
    p_chm.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.cmd == 'osm':
        return cmd_osm(args)
    return cmd_chm(args) if args.cmd == 'chm' else cmd_dem(args)


if __name__ == '__main__':
    sys.exit(main())
