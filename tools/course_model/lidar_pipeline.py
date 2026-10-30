#!/usr/bin/env python3
"""Point cloud -> canopy height model, via the PDAL command line.

  fetch  Read the USGS EPT point cloud for the course bbox (EPT SRS is
         EPSG:3857), drop noise classes, reproject to UTM 16N, write LAZ.
  chm    Height above ground (nearest ground neighbours) for every return,
         rasterised as the per-cell MAXIMUM at 1 m = canopy height model.
         Also records a classification histogram and return counts.

FarmLinks note: AL_17Co_2_2020 was flown leaf-off (Dec 2020 - Feb 2021) and
publishes no vegetation classes (3/4/5); vegetation sits in class 1.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def run_pipeline(stages: list, tmp: Path, name: str, metadata: bool = False) -> Path | None:
    pipe = tmp / f'{name}.pipeline.json'
    pipe.write_text(json.dumps({'pipeline': stages}, indent=2))
    cmd = ['pdal', 'pipeline', str(pipe)]
    meta = None
    if metadata:
        meta = tmp / f'{name}.metadata.json'
        cmd += ['--metadata', str(meta)]
    t0 = time.time()
    print('running', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    print(f'{name} seconds={time.time() - t0:.1f}', flush=True)
    return meta


def cmd_fetch(args: argparse.Namespace) -> int:
    b = json.loads(Path(args.dem_source).read_text())['bbox3857']
    tmp = Path(args.tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    laz = tmp / 'course-utm16n.laz'
    stages = [
        {'type': 'readers.ept', 'filename': args.ept,
         'bounds': f'([{b[0]}, {b[2]}], [{b[1]}, {b[3]}])', 'threads': 8},
        {'type': 'filters.range', 'limits': 'Classification![7:7],Classification![18:18]'},
        {'type': 'filters.reprojection', 'out_srs': 'EPSG:26916'},
        {'type': 'writers.las', 'filename': str(laz), 'compression': 'laszip',
         'a_srs': 'EPSG:26916', 'forward': 'all'},
    ]
    run_pipeline(stages, tmp, 'fetch')
    print(f'laz bytes={laz.stat().st_size}')
    return 0


def parse_stats(meta_path: Path) -> dict:
    meta = json.loads(meta_path.read_text())
    stages = meta.get('stages') or meta.get('metadata') or meta
    found = {}

    def walk(node):
        if isinstance(node, dict):
            if 'statistic' in node and isinstance(node['statistic'], list):
                for st in node['statistic']:
                    found[st.get('name')] = st
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(stages)
    out = {}
    for name, st in found.items():
        entry = {k: st.get(k) for k in ('count', 'minimum', 'maximum', 'average') if k in st}
        if 'counts' in st:
            entry['histogram'] = {
                str(c).split('/')[0].split('.')[0]: int(str(c).split('/')[1]) for c in st['counts']
            }
        out[name] = entry
    return out


def cmd_chm(args: argparse.Namespace) -> int:
    import numpy as np
    import rasterio
    from grid_io import save_grid

    tmp = Path(args.tmp)
    laz = tmp / 'course-utm16n.laz'
    chm_tif = tmp / 'chm-1m.tif'
    stages = [
        {'type': 'readers.las', 'filename': str(laz)},
        {'type': 'filters.stats', 'dimensions': 'Classification,ReturnNumber,NumberOfReturns',
         'enumerate': 'Classification,ReturnNumber'},
        {'type': 'filters.hag_nn', 'count': 2},
        {'type': 'filters.range', 'limits': 'HeightAboveGround[-2:70]'},
        {'type': 'writers.gdal', 'filename': str(chm_tif), 'dimension': 'HeightAboveGround',
         'output_type': 'max', 'resolution': 1.0, 'data_type': 'float32',
         'nodata': -9999, 'gdaldriver': 'GTiff', 'override_srs': 'EPSG:26916'},
    ]
    meta = run_pipeline(stages, tmp, 'chm', metadata=True)
    stats = parse_stats(meta) if meta and meta.exists() else {}

    with rasterio.open(chm_tif) as ds:
        arr = ds.read(1).astype('float64')
        t = ds.transform
    bad = (arr == -9999) | ~np.isfinite(arr)
    arr = np.where(bad, np.nan, np.clip(arr, 0, None))
    out = Path(args.out)
    save_grid(out / 'chm-utm16n-1m', arr, crs='EPSG:26916', origin_x=t.c, origin_y=t.f,
              pixel_size=float(t.a), scale=0.1, nodata_mask=bad,
              provenance={'source': args.ept, 'method': 'PDAL hag_nn (count=2), per-cell max',
                          'acquisition': 'AL_17Co_2_2020, leaf-off Dec 2020 - Feb 2021',
                          'license': 'Public domain (USGS 3DEP)'})
    valid = arr[~bad]
    report = {
        'schemaVersion': 'looper-course-model-lidar-stats-v1',
        'eptSource': args.ept,
        'lazBytes': laz.stat().st_size if laz.exists() else None,
        'pointStats': stats,
        'chm': {
            'width': int(arr.shape[1]), 'height': int(arr.shape[0]), 'pixelMeters': float(t.a),
            'validCells': int((~bad).sum()), 'emptyCells': int(bad.sum()),
            'cellsOver3m': int((valid >= 3).sum()), 'cellsOver10m': int((valid >= 10).sum()),
            'p50': float(np.percentile(valid, 50)) if valid.size else None,
            'p95': float(np.percentile(valid, 95)) if valid.size else None,
            'max': float(valid.max()) if valid.size else None,
        },
    }
    (out / 'lidar-stats.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['chm']))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p_fetch = sub.add_parser('fetch')
    p_fetch.add_argument('--dem-source', required=True)
    p_fetch.add_argument('--ept', required=True)
    p_fetch.add_argument('--tmp', required=True)
    p_chm = sub.add_parser('chm')
    p_chm.add_argument('--ept', required=True)
    p_chm.add_argument('--tmp', required=True)
    p_chm.add_argument('--out', required=True)
    args = parser.parse_args()
    return cmd_fetch(args) if args.cmd == 'fetch' else cmd_chm(args)


if __name__ == '__main__':
    sys.exit(main())
