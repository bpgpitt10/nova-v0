"""Compact, dependency-light raster grid format for the course-model prototype.

A grid is two files:
  <name>.json      header (CRS, origin, pixel size, scale, nodata, provenance)
  <name>.i16.gz    gzip of little-endian int16 rows, top row first

Values are stored as round(value / scale). Only numpy is needed to read it,
so the grid can be inspected anywhere without GDAL.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import numpy as np

NODATA_I16 = -32768


def save_grid(
    out_stem: Path,
    values: np.ndarray,
    *,
    crs: str,
    origin_x: float,
    origin_y: float,
    pixel_size: float,
    scale: float,
    nodata_mask: np.ndarray | None = None,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    arr = np.asarray(values, dtype=np.float64)
    q = np.round(arr / scale)
    bad = ~np.isfinite(arr)
    if nodata_mask is not None:
        bad |= nodata_mask
    q = np.clip(q, -32767, 32767)
    q[bad] = NODATA_I16
    q = q.astype('<i2')
    out_stem.parent.mkdir(parents=True, exist_ok=True)
    data_path = out_stem.with_suffix('.i16.gz')
    with gzip.open(data_path, 'wb', compresslevel=9) as fh:
        fh.write(q.tobytes(order='C'))
    header = {
        'schemaVersion': 'looper-course-model-grid-v1',
        'crs': crs,
        'originX': float(origin_x),
        'originY': float(origin_y),
        'originIs': 'top-left corner of top-left pixel',
        'pixelSize': float(pixel_size),
        'width': int(q.shape[1]),
        'height': int(q.shape[0]),
        'scale': float(scale),
        'nodata': NODATA_I16,
        'encoding': 'int16-le-gzip-rows-top-first',
        'dataFile': data_path.name,
        'validCells': int((~bad).sum()),
        'provenance': provenance or {},
    }
    out_stem.with_suffix('.json').write_text(json.dumps(header, indent=2) + '\n')
    return header


def load_grid(header_path: Path) -> tuple[dict[str, Any], np.ndarray]:
    header = json.loads(Path(header_path).read_text())
    data_path = Path(header_path).with_name(header['dataFile'])
    with gzip.open(data_path, 'rb') as fh:
        raw = np.frombuffer(fh.read(), dtype='<i2')
    q = raw.reshape(header['height'], header['width']).astype(np.float64)
    q[q == header['nodata']] = np.nan
    return header, q * header['scale']


def sample_bilinear(header: dict[str, Any], grid: np.ndarray, x: float, y: float) -> float:
    """Sample at projected (x, y); NaN outside the grid or next to nodata."""
    px = (x - header['originX']) / header['pixelSize'] - 0.5
    py = (header['originY'] - y) / header['pixelSize'] - 0.5
    i0, j0 = int(np.floor(py)), int(np.floor(px))
    if i0 < 0 or j0 < 0 or i0 + 1 >= grid.shape[0] or j0 + 1 >= grid.shape[1]:
        return float('nan')
    fy, fx = py - i0, px - j0
    w = grid[i0:i0 + 2, j0:j0 + 2]
    return float(
        w[0, 0] * (1 - fx) * (1 - fy) + w[0, 1] * fx * (1 - fy)
        + w[1, 0] * (1 - fx) * fy + w[1, 1] * fx * fy
    )
