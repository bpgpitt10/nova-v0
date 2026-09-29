#!/usr/bin/env python3
"""Build a compact high-resolution Greywolf green-detail terrain package.

The existing whole-hole browser terrain intentionally samples at 10 yd spacing.
That is appropriate for full-shot elevation, but too coarse for short-game
landing decisions. This compiler goes back to the official 1 m LidarBC DEM and
samples a small rectangle around each OSM target green at 1 yd spacing.

The package also derives a deliberately coarse 3x3 tactical summary. It is not a
putting-break model: sectors describe meaningful high/low and downhill tendencies
for landing/roll strategy while preserving the 1 yd grid for later refinement.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import zlib
from pathlib import Path

import numpy as np
import rasterio

from build_greywolf_terrain import (
    bilinear,
    fit_course_to_pixel,
    project_latlon,
)

METERS_TO_YARDS = 1.0936133
GRID_SPACING_YDS = 1.0
MARGIN_YDS = 12.0
NODATA = 65535


def read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def target_green_polygon(raw: dict) -> np.ndarray:
    features = ((raw.get('features') or {}).get('green') or [])
    if not features:
        raise RuntimeError('local geometry has no target green')
    polygon = features[0].get('polygon') or []
    points = [
        (float(point['right_yards']), float(point['forward_yards']))
        for point in polygon
        if isinstance(point, dict)
        and point.get('right_yards') is not None
        and point.get('forward_yards') is not None
    ]
    if len(points) < 3:
        raise RuntimeError('target green polygon has fewer than three points')
    return np.asarray(points, dtype=float)


def points_inside_polygon(xx: np.ndarray, yy: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Vectorized even/odd ray cast for a local-yard polygon."""
    inside = np.zeros(xx.shape, dtype=bool)
    xj, yj = polygon[-1]
    for xi, yi in polygon:
        crosses = (yi > yy) != (yj > yy)
        x_at_y = (xj - xi) * (yy - yi) / ((yj - yi) + 1e-12) + xi
        inside ^= crosses & (xx < x_at_y)
        xj, yj = xi, yi
    return inside


def local_grid_to_course(
    xx: np.ndarray,
    yy: np.ndarray,
    tee_latlon: tuple[float, float],
    green_latlon: tuple[float, float],
):
    tee = project_latlon(*tee_latlon)
    green = project_latlon(*green_latlon)
    delta = green - tee
    distance = float(np.linalg.norm(delta))
    if distance <= 1e-9:
        raise RuntimeError('tee/green anchor vector is degenerate')
    forward = delta / distance
    right = np.asarray([forward[1], -forward[0]])
    course_x = tee[0] + right[0] * xx + forward[0] * yy
    course_y = tee[1] + right[1] * xx + forward[1] * yy
    return course_x, course_y


def plane_summary(x: np.ndarray, y: np.ndarray, z_ft: np.ndarray):
    good = np.isfinite(x) & np.isfinite(y) & np.isfinite(z_ft)
    if int(good.sum()) < 4:
        return None
    gx, gy, gz = x[good], y[good], z_ft[good]
    design = np.column_stack([gx, gy, np.ones(len(gx))])
    a, b, _c = np.linalg.lstsq(design, gz, rcond=None)[0]
    # a/b are feet of vertical change per horizontal yard. Convert ft->yd.
    slope_percent = math.hypot(float(a), float(b)) / 3.0 * 100.0
    downhill_x, downhill_y = -float(a), -float(b)
    downhill_norm = math.hypot(downhill_x, downhill_y)
    if downhill_norm > 1e-9:
        downhill_right = downhill_x / downhill_norm
        downhill_forward = downhill_y / downhill_norm
        bearing = (math.degrees(math.atan2(downhill_right, downhill_forward)) + 360.0) % 360.0
    else:
        downhill_right = 0.0
        downhill_forward = 0.0
        bearing = 0.0
    return {
        'sampleCount': int(good.sum()),
        'meanElevationFt': round(float(np.mean(gz)), 2),
        'minElevationFt': round(float(np.min(gz)), 2),
        'maxElevationFt': round(float(np.max(gz)), 2),
        'elevationRangeFt': round(float(np.max(gz) - np.min(gz)), 2),
        'planeSlopePercent': round(slope_percent, 2),
        'downhillLocalUnit': [round(downhill_right, 4), round(downhill_forward, 4)],
        'downhillBearingDeg': round(bearing, 1),
    }


def sector_summaries(
    xx: np.ndarray,
    yy: np.ndarray,
    elevation_ft: np.ndarray,
    green_mask: np.ndarray,
    bounds: tuple[float, float, float, float],
    overall_mean_ft: float,
):
    min_x, max_x, min_y, max_y = bounds
    x_edges = np.linspace(min_x, max_x, 4)
    y_edges = np.linspace(min_y, max_y, 4)
    rows = ('front', 'middle', 'back')
    columns = ('left', 'center', 'right')
    sectors = []
    for row in range(3):
        for column in range(3):
            x0, x1 = x_edges[column], x_edges[column + 1]
            y0, y1 = y_edges[row], y_edges[row + 1]
            # Include the upper edge in the last row/column so no boundary sample
            # is lost simply due to floating-point binning.
            x_ok = (xx >= x0) & ((xx <= x1) if column == 2 else (xx < x1))
            y_ok = (yy >= y0) & ((yy <= y1) if row == 2 else (yy < y1))
            mask = green_mask & x_ok & y_ok & np.isfinite(elevation_ft)
            summary = plane_summary(xx[mask], yy[mask], elevation_ft[mask])
            item = {
                'id': f'{rows[row]}-{columns[column]}',
                'row': rows[row],
                'column': columns[column],
                'boundsYds': [round(float(x0), 1), round(float(x1), 1), round(float(y0), 1), round(float(y1), 1)],
            }
            if summary:
                item.update(summary)
                item['deltaFromGreenMeanFt'] = round(summary['meanElevationFt'] - overall_mean_ft, 2)
            else:
                item['sampleCount'] = 0
            sectors.append(item)
    return sectors


def build(dem_path: Path, geometry_dir: Path, output_path: Path):
    with rasterio.open(dem_path) as ds:
        dem = ds.read(1).astype(float)
        nodata = float(ds.nodata)
        col_coeff, row_coeff, fit_error = fit_course_to_pixel(ds)

    package = {
        'schemaVersion': 'looper-greywolf-green-detail-v1',
        'source': {
            'dataset': 'BC 1m bare-earth DEM',
            'tile': dem_path.name,
            'sourceResolutionMeters': 1,
        },
        'runtimeTerrain': {
            'spacingYds': GRID_SPACING_YDS,
            'marginYds': MARGIN_YDS,
            'interpolation': 'bilinear',
            'encoding': 'uint16 deci-feet above per-hole offset',
            'nodata': NODATA,
        },
        'tacticalSummary': {
            'layout': '3x3 green bounding-box sectors',
            'rows': ['front', 'middle', 'back'],
            'columns': ['left', 'center', 'right'],
            'downhillBearingContract': '0=hole-forward, 90=right, 180=back toward tee, 270=left',
            'note': 'Coarse landing/roll context only; not a putting-break model.',
        },
        'courseToDemPixelFitMaxErrorMeters': round(fit_error, 3),
        'holes': {},
    }

    for hole_number in range(1, 19):
        path = geometry_dir / f'greywolf-hole-{hole_number:02d}.json'
        raw = read_json(path)
        anchors = raw.get('anchors') or {}
        tee_ll = anchors.get('selected_tee_latlon')
        green_ll = anchors.get('target_green_latlon')
        if not (isinstance(tee_ll, list) and len(tee_ll) >= 2 and isinstance(green_ll, list) and len(green_ll) >= 2):
            raise RuntimeError(f'H{hole_number} missing tee/green latlon anchors')
        polygon = target_green_polygon(raw)
        green_min_x, green_min_y = np.min(polygon, axis=0)
        green_max_x, green_max_y = np.max(polygon, axis=0)
        min_x = math.floor(float(green_min_x - MARGIN_YDS))
        max_x = math.ceil(float(green_max_x + MARGIN_YDS))
        min_y = math.floor(float(green_min_y - MARGIN_YDS))
        max_y = math.ceil(float(green_max_y + MARGIN_YDS))
        xs = np.arange(min_x, max_x + 1e-6, GRID_SPACING_YDS)
        ys = np.arange(min_y, max_y + 1e-6, GRID_SPACING_YDS)
        xx, yy = np.meshgrid(xs, ys)
        course_x, course_y = local_grid_to_course(
            xx,
            yy,
            (float(tee_ll[0]), float(tee_ll[1])),
            (float(green_ll[0]), float(green_ll[1])),
        )
        elevation_ft = bilinear(
            dem,
            nodata,
            col_coeff,
            row_coeff,
            course_x,
            course_y,
        ) * 3.280839895

        finite_values = elevation_ft[np.isfinite(elevation_ft)]
        if finite_values.size == 0:
            raise RuntimeError(f'H{hole_number} green detail had no valid DEM samples')
        offset = math.floor(float(finite_values.min()) * 10.0) / 10.0
        quantized = np.rint((elevation_ft - offset) * 10.0)
        encoded = np.full(elevation_ft.shape, NODATA, dtype='<u2')
        valid = np.isfinite(elevation_ft) & (quantized >= 0) & (quantized < NODATA)
        encoded[valid] = quantized[valid].astype('<u2')
        compressed = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode('ascii')

        green_mask = points_inside_polygon(xx, yy, polygon) & np.isfinite(elevation_ft)
        overall = plane_summary(xx[green_mask], yy[green_mask], elevation_ft[green_mask])
        if not overall:
            raise RuntimeError(f'H{hole_number} green polygon had too few DEM samples')
        green_bounds = (
            float(green_min_x),
            float(green_max_x),
            float(green_min_y),
            float(green_max_y),
        )
        sectors = sector_summaries(
            xx,
            yy,
            elevation_ft,
            green_mask,
            green_bounds,
            float(overall['meanElevationFt']),
        )

        package['holes'][str(hole_number)] = {
            'greenBoundsYds': [round(v, 1) for v in green_bounds],
            'greenSampleCount': int(green_mask.sum()),
            'greenSummary': overall,
            'sectors': sectors,
            'grid': {
                'minX': float(min_x),
                'minY': float(min_y),
                'spacingYds': GRID_SPACING_YDS,
                'width': int(len(xs)),
                'height': int(len(ys)),
                'elevationOffsetFt': round(offset, 1),
                'compression': 'deflate',
                'valuesBase64': compressed,
            },
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(package, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'wrote {output_path} ({output_path.stat().st_size:,} bytes); affine max error {fit_error:.3f} m')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dem', type=Path, required=True)
    parser.add_argument(
        '--geometry-dir',
        type=Path,
        default=Path('public/course-geometry/greywolf/local-geometry'),
    )
    parser.add_argument(
        '--output',
        type=Path,
        default=Path('public/course-geometry/greywolf/green-detail-v1.json'),
    )
    args = parser.parse_args()
    build(args.dem, args.geometry_dir, args.output)
