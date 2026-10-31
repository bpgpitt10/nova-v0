#!/usr/bin/env python3
"""USGS EPT point cloud -> 1 m canopy height model, in pure Python (no PDAL).

EPT is an octree of LAZ tiles. We walk the hierarchy, download every tile at
every depth that intersects the course bbox, read it with laspy (lazrs
backend), keep points inside the bbox, drop noise classes (7, 18), reproject to
the course UTM zone, and compute height above ground against the 3DEP bare-earth DEM that
the dem stage already fetched (same grid, same origin). The canopy height
model is the per-cell MAXIMUM height above ground, aligned to the DEM grid.

FarmLinks note: AL_17Co_2_2020 was flown leaf-off (Dec 2020 - Feb 2021) and
publishes no vegetation classes (3/4/5); vegetation sits in class 1.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid_io import load_grid, save_grid  # noqa: E402

USER_AGENT = 'the-looper-course-model-prototype/0.1'
NOISE_CLASSES = (7, 18)


def get(url: str, timeout: int = 120, tries: int = 4) -> bytes:
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'GET failed {url}: {last}')


def node_bounds(root: list[float], key: str) -> tuple[float, float, float, float]:
    d, x, y, _z = (int(v) for v in key.split('-'))
    size = (root[3] - root[0]) / (2 ** d)
    sy = (root[4] - root[1]) / (2 ** d)
    return root[0] + x * size, root[1] + y * sy, root[0] + (x + 1) * size, root[1] + (y + 1) * sy


def intersects(a, b) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def collect_nodes(base: str, root: list[float], bbox: tuple) -> list[tuple[str, int]]:
    """All non-empty octree nodes whose XY footprint intersects bbox."""
    wanted, pending = [], ['0-0-0-0']
    while pending:
        hkey = pending.pop()
        hier = json.loads(get(f'{base}/ept-hierarchy/{hkey}.json'))
        for key, count in hier.items():
            if not intersects(node_bounds(root, key), bbox):
                continue
            if count == -1:
                if key != hkey:
                    pending.append(key)
            elif count > 0:
                wanted.append((key, count))
    return wanted


def cmd_chm(args: argparse.Namespace) -> int:
    import laspy
    from pyproj import Transformer

    t_start = time.time()
    ept_url = args.ept
    base = ept_url.rsplit('/', 1)[0]
    meta = json.loads(get(ept_url))
    root = meta['bounds']  # [xmin, ymin, zmin, xmax, ymax, zmax] in EPT SRS (EPSG:3857)
    b = json.loads(Path(args.dem_source).read_text())['bbox3857']
    bbox = (b[0], b[1], b[2], b[3])

    nodes = collect_nodes(base, root, bbox)
    expected_points = sum(c for _, c in nodes)
    print(f'nodes={len(nodes)} pointsInIntersectingNodes={expected_points} '
          f'hierarchySeconds={time.time() - t_start:.1f}', flush=True)

    dem_h, dem = load_grid(Path(args.dem))
    px = dem_h['pixelSize']
    H, W = dem.shape
    chm = np.full((H, W), np.nan)
    returns = np.zeros((H, W), dtype=np.int32)
    to_utm = Transformer.from_crs('EPSG:3857', dem_h['crs'], always_xy=True)
    classes, first_returns, kept, downloaded_bytes = Counter(), 0, 0, 0

    def fetch(key):
        return key, get(f'{base}/ept-data/{key}.laz', timeout=180)

    with ThreadPoolExecutor(max_workers=12) as pool:
        for i, (key, blob) in enumerate(pool.map(fetch, [k for k, _ in nodes])):
            downloaded_bytes += len(blob)
            las = laspy.read(io.BytesIO(blob))
            x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
            cls = np.asarray(las.classification)
            inside = (x >= bbox[0]) & (x <= bbox[2]) & (y >= bbox[1]) & (y <= bbox[3])
            inside &= ~np.isin(cls, NOISE_CLASSES)
            if not inside.any():
                continue
            x, y, z, cls = x[inside], y[inside], z[inside], cls[inside]
            rn = np.asarray(las.return_number)[inside]
            classes.update(cls.tolist())
            first_returns += int((rn == 1).sum())
            e, n = to_utm.transform(x, y)
            col = np.floor((e - dem_h['originX']) / px).astype(np.int64)
            row = np.floor((dem_h['originY'] - n) / px).astype(np.int64)
            ok = (col >= 0) & (col < W) & (row >= 0) & (row < H)
            col, row, z = col[ok], row[ok], z[ok]
            ground = dem[row, col]
            hag = z - ground
            good = np.isfinite(hag) & (hag > -2) & (hag < 70)
            col, row, hag = col[good], row[good], hag[good]
            kept += int(hag.size)
            flat = row * W + col
            cur = chm.reshape(-1)
            np.fmax.at(cur, flat, hag)
            np.add.at(returns.reshape(-1), flat, 1)
            if (i + 1) % 25 == 0:
                print(f'tiles {i + 1}/{len(nodes)} kept={kept} MB={downloaded_bytes / 1e6:.0f} '
                      f'seconds={time.time() - t_start:.0f}', flush=True)

    chm = np.clip(chm, 0, None)
    empty = ~np.isfinite(chm)
    out = Path(args.out)
    save_grid(out / 'chm-utm-1m', chm, crs=dem_h['crs'], origin_x=dem_h['originX'],
              origin_y=dem_h['originY'], pixel_size=px, scale=0.1, nodata_mask=empty,
              provenance={'source': ept_url,
                          'method': 'height above 3DEP bare-earth DEM, per-cell max, noise 7/18 dropped',
                          'acquisition': 'AL_17Co_2_2020, leaf-off Dec 2020 - Feb 2021',
                          'license': 'Public domain (USGS 3DEP)', 'alignedTo': 'dem-utm-1m'})
    valid = chm[~empty]
    area = H * W * px * px
    report = {
        'schemaVersion': 'looper-course-model-lidar-stats-v1',
        'eptSource': ept_url,
        'eptSrs': meta.get('srs', {}).get('horizontal') or meta.get('srs'),
        'octreeNodesRead': len(nodes),
        'downloadedMB': round(downloaded_bytes / 1e6, 1),
        'pointsKeptInBbox': kept,
        'pointsPerSquareMetre': round(kept / area, 2),
        'firstReturnsPerSquareMetre': round(first_returns / area, 2),
        'classificationHistogram': {str(k): v for k, v in sorted(classes.items())},
        'chm': {
            'width': W, 'height': H, 'pixelMeters': px,
            'cellsWithReturns': int((~empty).sum()), 'emptyCells': int(empty.sum()),
            'cellsOver3m': int((valid >= 3).sum()), 'cellsOver10m': int((valid >= 10).sum()),
            'p50': float(np.percentile(valid, 50)) if valid.size else None,
            'p95': float(np.percentile(valid, 95)) if valid.size else None,
            'max': float(valid.max()) if valid.size else None,
        },
        'seconds': round(time.time() - t_start, 1),
    }
    (out / 'lidar-stats.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--ept', required=True)
    ap.add_argument('--dem-source', required=True, help='file with bbox3857 (importer dem-source or course-bbox.json)')
    ap.add_argument('--dem', required=True, help='dem-utm-1m.json grid from the dem stage')
    ap.add_argument('--out', required=True)
    return cmd_chm(ap.parse_args())


if __name__ == '__main__':
    sys.exit(main())
