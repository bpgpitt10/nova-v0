#!/usr/bin/env python3
"""Build the browser Greywolf terrain package from the official 1 m LidarBC DEM.

The 1 m DEM is the source of truth. Runtime elevation grids are compact derived
samples for browser delivery; topo lines are a separate visualization derived
from the same raster.
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
from pyproj import Transformer
from skimage import measure

EARTH_RADIUS_M = 6_371_008.8
METERS_TO_YARDS = 1.0936133
ORIGIN_LAT = 50.44775
ORIGIN_LON = -116.24877
RUNTIME_SPACING_YDS = 10.0
CONTOUR_WORKING_SPACING_YDS = 2.0
VIEW_HALF_WIDTH_YDS = 115.0
VIEW_BEHIND_TEE_YDS = 28.0
VIEW_PAST_GREEN_YDS = 44.0

# Canonical selected-tee / target-green anchors from CourseGeometryPackage v1.
HOLES = [
    (1,(50.446423107692304,-116.24757067692309),(50.443634984615386,-116.24856764615384)),
    (2,(50.44322640769231,-116.24920309230768),(50.44033083214286,-116.24789634642856)),
    (3,(50.43978042727272,-116.24675434545453),(50.436419093103446,-116.24581563793103)),
    (4,(50.43699414545454,-116.24737101818182),(50.43997947083333,-116.24905765416666)),
    (5,(50.4405376,-116.24936657272728),(50.444703978125,-116.250551296875)),
    (6,(50.44472585,-116.25251108333333),(50.445646121428574,-116.25378020000001)),
    (7,(50.446577285714284,-116.25304951428572),(50.44947869655173,-116.25312067586206)),
    (8,(50.44952665833333,-116.25239198333334),(50.44635184137931,-116.25239717241378)),
    (9,(50.44535647692308,-116.25007964615385),(50.44610552941177,-116.24891983235295)),
    (10,(50.44775794545455,-116.2461714),(50.4520246875,-116.24378773333332)),
    (11,(50.45284434285714,-116.24272422857143),(50.455223399999994,-116.24216032307693)),
    (12,(50.45624918181818,-116.24561097272726),(50.456569800000004,-116.24719676060606)),
    (13,(50.4553650125,-116.2496866375),(50.45342418,-116.252494405)),
    (14,(50.45174230769231,-116.25079121538462),(50.448258894999995,-116.25077065999999)),
    (15,(50.44840396,-116.24989222),(50.44931125185185,-116.24916648888887)),
    (16,(50.45037550666667,-116.24915923333333),(50.45314451851851,-116.24939478148147)),
    (17,(50.45375772,-116.24873034000001),(50.450821117241375,-116.24691193793103)),
    (18,(50.45033664166667,-116.2453743),(50.44752355,-116.24729782727273)),
]


def project_latlon(lat: float, lon: float) -> np.ndarray:
    north_m = EARTH_RADIUS_M * math.radians(lat - ORIGIN_LAT)
    east_m = EARTH_RADIUS_M * math.radians(lon - ORIGIN_LON) * math.cos(math.radians(ORIGIN_LAT))
    return np.array([east_m * METERS_TO_YARDS, north_m * METERS_TO_YARDS])


def inverse_course_xy(x: float, y: float) -> tuple[float, float]:
    lat = ORIGIN_LAT + math.degrees((y / METERS_TO_YARDS) / EARTH_RADIUS_M)
    lon = ORIGIN_LON + math.degrees((x / METERS_TO_YARDS) / (EARTH_RADIUS_M * math.cos(math.radians(ORIGIN_LAT))))
    return lat, lon


def fit_course_to_pixel(ds: rasterio.DatasetReader) -> tuple[np.ndarray, np.ndarray, float]:
    transformer = Transformer.from_crs('EPSG:4326', ds.crs, always_xy=True)
    samples = []
    for x in np.linspace(-800, 800, 9):
        for y in np.linspace(-1200, 1200, 13):
            lat, lon = inverse_course_xy(float(x), float(y))
            east, north = transformer.transform(lon, lat)
            col = (east - ds.transform.c) / ds.transform.a
            row = (north - ds.transform.f) / ds.transform.e
            samples.append((x, y, col, row))
    matrix = np.array([[x, y, 1.0] for x, y, _, _ in samples])
    cols = np.array([col for _, _, col, _ in samples])
    rows = np.array([row for _, _, _, row in samples])
    col_coeff = np.linalg.lstsq(matrix, cols, rcond=None)[0]
    row_coeff = np.linalg.lstsq(matrix, rows, rcond=None)[0]
    errors = np.hypot(matrix @ col_coeff - cols, matrix @ row_coeff - rows)
    return col_coeff, row_coeff, float(np.max(errors))


def bilinear(dem: np.ndarray, nodata: float, col_coeff: np.ndarray, row_coeff: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    cols = col_coeff[0] * x + col_coeff[1] * y + col_coeff[2]
    rows = row_coeff[0] * x + row_coeff[1] * y + row_coeff[2]
    c0 = np.floor(cols).astype(int)
    r0 = np.floor(rows).astype(int)
    dc = cols - c0
    dr = rows - r0
    inside = (r0 >= 0) & (r0 < dem.shape[0] - 1) & (c0 >= 0) & (c0 < dem.shape[1] - 1)
    output = np.full(cols.shape, np.nan)
    ri, ci = r0[inside], c0[inside]
    values = np.stack([dem[ri,ci], dem[ri,ci+1], dem[ri+1,ci], dem[ri+1,ci+1]])
    valid = np.all(values != nodata, axis=0)
    sampled = values[0]*(1-dc[inside])*(1-dr[inside]) + values[1]*dc[inside]*(1-dr[inside]) + values[2]*(1-dc[inside])*dr[inside] + values[3]*dc[inside]*dr[inside]
    partial = np.full(len(ri), np.nan)
    partial[valid] = sampled[valid]
    output[inside] = partial
    return output


def hole_grid(dem, nodata, col_coeff, row_coeff, tee, forward, right, distance, spacing):
    min_x, max_x = -VIEW_HALF_WIDTH_YDS, VIEW_HALF_WIDTH_YDS
    min_y, max_y = -VIEW_BEHIND_TEE_YDS, distance + VIEW_PAST_GREEN_YDS
    xs = np.arange(min_x, max_x + 1e-6, spacing)
    ys = np.arange(min_y, max_y + 1e-6, spacing)
    xx, yy = np.meshgrid(xs, ys)
    course_x = tee[0] + right[0]*xx + forward[0]*yy
    course_y = tee[1] + right[1]*xx + forward[1]*yy
    elevation_ft = bilinear(dem, nodata, col_coeff, row_coeff, course_x, course_y) * 3.280839895
    return min_x, min_y, xs, ys, elevation_ft


def simplify_segment(points: np.ndarray) -> list[list[float]]:
    # Contours are visual context. Keep roughly 4 yd between stored vertices.
    output = []
    last = None
    for point in points:
        if last is None or np.linalg.norm(point - last) >= 4.0:
            output.append([round(float(point[0]), 1), round(float(point[1]), 1)])
            last = point
    return output if len(output) >= 2 else []


def build(dem_path: Path, output_path: Path) -> None:
    with rasterio.open(dem_path) as ds:
        dem = ds.read(1).astype(float)
        nodata = float(ds.nodata)
        col_coeff, row_coeff, fit_error = fit_course_to_pixel(ds)

    package = {
        'schemaVersion': 'looper-greywolf-terrain-v1',
        'source': {'dataset': 'BC 1m bare-earth DEM', 'tile': 'bc_082k049_xli1m_utm11_2015.tif', 'crs': 'EPSG:2955', 'sourceResolutionMeters': 1},
        'courseCoordinateSystem': {'originLatLon': [ORIGIN_LAT, ORIGIN_LON], 'projection': 'local-equirectangular-v1', 'units': 'yards'},
        'runtimeTerrain': {'spacingYds': RUNTIME_SPACING_YDS, 'interpolation': 'bilinear', 'encoding': 'uint16 deci-feet above per-hole offset', 'nodata': 65535, 'note': 'Compact browser delivery grid derived from the official 1 m DEM; source terrain authority remains the 1 m raster.'},
        'courseToDemPixelFitMaxErrorMeters': round(fit_error, 3),
        'holes': {},
    }

    for number, tee_ll, green_ll in HOLES:
        tee = project_latlon(*tee_ll)
        green = project_latlon(*green_ll)
        delta = green - tee
        distance = float(np.linalg.norm(delta))
        forward = delta / distance
        right = np.array([forward[1], -forward[0]])

        min_x, min_y, xs, ys, runtime = hole_grid(dem, nodata, col_coeff, row_coeff, tee, forward, right, distance, RUNTIME_SPACING_YDS)
        values = runtime[np.isfinite(runtime)]
        offset = math.floor(float(values.min()) * 10.0) / 10.0
        quantized = np.rint((runtime - offset) * 10.0)
        encoded = np.full(runtime.shape, 65535, dtype='<u2')
        good = np.isfinite(runtime) & (quantized >= 0) & (quantized < 65535)
        encoded[good] = quantized[good].astype('<u2')
        compressed = base64.b64encode(zlib.compress(encoded.tobytes(), 9)).decode('ascii')

        cmin_x, cmin_y, cxs, cys, contour_grid = hole_grid(dem, nodata, col_coeff, row_coeff, tee, forward, right, distance, CONTOUR_WORKING_SPACING_YDS)
        contour_values = contour_grid[np.isfinite(contour_grid)]
        contours = []
        start = math.ceil(float(contour_values.min()) / 10.0) * 10
        stop = math.floor(float(contour_values.max()) / 10.0) * 10
        for level in np.arange(start, stop + 0.1, 10):
            for segment in measure.find_contours(contour_grid, level):
                if len(segment) < 3:
                    continue
                local = np.column_stack((cmin_x + segment[:,1] * CONTOUR_WORKING_SPACING_YDS, cmin_y + segment[:,0] * CONTOUR_WORKING_SPACING_YDS))
                points = simplify_segment(local)
                if points:
                    contours.append({'elevationFt': int(round(level)), 'points': points})

        package['holes'][str(number)] = {
            'grid': {'minX': min_x, 'minY': min_y, 'spacingYds': RUNTIME_SPACING_YDS, 'width': len(xs), 'height': len(ys), 'elevationOffsetFt': round(offset, 1), 'compression': 'deflate', 'valuesBase64': compressed},
            'contours': contours,
            'elevationRangeFt': [round(float(values.min()), 1), round(float(values.max()), 1)],
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(package, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'wrote {output_path} ({output_path.stat().st_size:,} bytes); affine max error {fit_error:.3f} m')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dem', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('public/course-geometry/greywolf-terrain-v1.json'))
    args = parser.parse_args()
    build(args.dem, args.output)
