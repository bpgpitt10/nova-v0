#!/usr/bin/env python3
"""Canopy height model -> individual trees and woodland outlines.

Trees:    local maxima of a lightly smoothed CHM, with a search window that
          grows with height (taller trees have wider crowns), minimum 3 m.
          Crowns come from a watershed on the inverted CHM seeded at the tops;
          crown radius = sqrt(crown area / pi). Shapes are not modelled.
Woodland: CHM >= 3 m, morphologically opened, polygons >= 25 m2.

Buildings and power lines from the unfiltered OSM snapshot are masked first so
roofs and wires are not reported as trees.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid_io import load_grid  # noqa: E402

MIN_TREE_M = 3.0
MIN_CROWN_M = 2.0
MIN_WOOD_AREA_M2 = 25.0


def osm_mask_shapes(osm_path: Path, to_utm) -> list:
    from shapely.geometry import LineString, Polygon
    from shapely.geometry import Point
    payload = json.loads(gzip.open(osm_path, 'rt', encoding='utf-8').read())
    shapes = []
    for el in payload.get('elements', []):
        tags = el.get('tags') or {}
        if el.get('type') == 'node' and tags.get('power') in {'tower', 'pole'} and 'lat' in el:
            shapes.append(Point(to_utm.transform(el['lon'], el['lat'])).buffer(8.0))
            continue
        geom = el.get('geometry')
        if el.get('type') != 'way' or not geom:
            continue
        pts = [to_utm.transform(p['lon'], p['lat']) for p in geom]
        if 'building' in tags and len(pts) >= 4:
            try:
                shapes.append(Polygon(pts).buffer(2.0))
            except Exception:  # noqa: BLE001 - skip broken rings
                pass
        elif tags.get('power') in {'line', 'minor_line', 'cable'} and len(pts) >= 2:
            shapes.append(LineString(pts).buffer(power_corridor_half_width_m(tags)))
    return shapes


def power_corridor_half_width_m(tags: dict) -> float:
    """Half-width of the wire corridor to mask. Transmission lines carry several
    conductors spread across a cleared right-of-way: at FarmLinks (230 kV) the
    false 'trees' sat between -10 m and +15 m of the OSM centreline, and real
    trees resumed beyond about 15-20 m."""
    try:
        kv = max(float(v) for v in str(tags.get('voltage', '')).split(';') if v.strip()) / 1000
    except ValueError:
        kv = 0.0
    if tags.get('power') == 'line' and (kv >= 100 or not kv):
        return 16.0
    if kv >= 35:
        return 10.0
    return 5.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--chm', required=True, help='chm-utm-1m.json grid header')
    ap.add_argument('--osm', required=True, help='osm-full.json.gz')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    from affine import Affine
    from pyproj import Transformer
    from rasterio import features
    from scipy import ndimage as ndi
    from shapely.geometry import shape, mapping
    from shapely.ops import transform as shp_transform
    from skimage.segmentation import watershed

    t0 = time.time()
    header, chm = load_grid(Path(args.chm))
    px = header['pixelSize']
    aff = Affine(px, 0, header['originX'], 0, -px, header['originY'])
    crs = header['crs']
    to_utm = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)

    chm = np.nan_to_num(chm, nan=0.0)
    masks = osm_mask_shapes(Path(args.osm), to_utm)
    masked_cells = 0
    if masks:
        m = features.rasterize(((g, 1) for g in masks), out_shape=chm.shape, transform=aff,
                               fill=0, dtype='uint8').astype(bool)
        masked_cells = int(m.sum())
        chm[m] = 0.0

    smooth = ndi.gaussian_filter(chm, sigma=0.8)
    # Height-dependent window radius (pixels at 1 m): crowns widen with height.
    is_top = np.zeros(chm.shape, dtype=bool)
    bands = [(MIN_TREE_M, 6.0, 1), (6.0, 12.0, 2), (12.0, 20.0, 3), (20.0, 99.0, 4)]
    for lo, hi, r in bands:
        yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
        disk = (xx * xx + yy * yy) <= r * r
        local_max = ndi.maximum_filter(smooth, footprint=disk, mode='nearest')
        is_top |= (smooth == local_max) & (smooth >= lo) & (smooth < hi)
    markers, n_tops = ndi.label(is_top)
    # Merge plateau duplicates: one marker per connected top region.
    crowns = watershed(-smooth, markers, mask=smooth >= MIN_CROWN_M)
    labels = np.arange(1, n_tops + 1)
    areas = ndi.sum(np.ones_like(chm), crowns, labels) * px * px
    heights = ndi.maximum(chm, markers, labels)
    centers = ndi.center_of_mass(is_top, markers, labels)

    trees = []
    for lab, (cy, cx), h, a in zip(labels, centers, heights, areas):
        if h < MIN_TREE_M:
            continue
        x, y = aff * (cx + 0.5, cy + 0.5)
        lon, lat = to_ll.transform(x, y)
        trees.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [round(lon, 7), round(lat, 7)]},
            'properties': {'height_m': round(float(h), 1),
                           'crown_radius_m': round(float(np.sqrt(max(a, px * px) / np.pi)), 1),
                           'utm': [round(x, 2), round(y, 2)]},
        })

    wood = ndi.binary_opening(chm >= MIN_TREE_M, structure=np.ones((3, 3)))
    woods = []
    proj = lambda xx, yy, zz=None: to_ll.transform(xx, yy)  # noqa: E731
    for geom, val in features.shapes(wood.astype('uint8'), mask=wood, transform=aff):
        poly = shape(geom)
        if poly.area < MIN_WOOD_AREA_M2:
            continue
        poly = poly.simplify(0.75, preserve_topology=True)
        woods.append({'type': 'Feature', 'geometry': mapping(shp_transform(proj, poly)),
                      'properties': {'area_m2': round(poly.area, 1)}})

    out = Path(args.out)
    attribution = 'Derived from USGS 3DEP LiDAR AL_17Co_2_2020 (public domain)'
    (out / 'trees.geojson').write_text(json.dumps(
        {'type': 'FeatureCollection', 'attribution': attribution, 'features': trees},
        separators=(',', ':')))
    (out / 'woods.geojson').write_text(json.dumps(
        {'type': 'FeatureCollection', 'attribution': attribution, 'features': woods},
        separators=(',', ':')))
    hs = np.array([f['properties']['height_m'] for f in trees]) if trees else np.array([0.0])
    cr = np.array([f['properties']['crown_radius_m'] for f in trees]) if trees else np.array([0.0])
    summary = {
        'schemaVersion': 'looper-course-model-trees-v1',
        'crs': crs,
        'treeCount': len(trees),
        'heightM': {'p10': float(np.percentile(hs, 10)), 'p50': float(np.percentile(hs, 50)),
                    'p90': float(np.percentile(hs, 90)), 'max': float(hs.max())},
        'crownRadiusM': {'p10': float(np.percentile(cr, 10)), 'p50': float(np.percentile(cr, 50)),
                         'p90': float(np.percentile(cr, 90))},
        'woodlandPolygons': len(woods),
        'woodlandAreaHa': round(sum(f['properties']['area_m2'] for f in woods) / 1e4, 2),
        'maskedCellsBuildingsAndPower': masked_cells,
        'parameters': {'minTreeM': MIN_TREE_M, 'minCrownM': MIN_CROWN_M,
                       'smoothingSigmaPx': 0.8, 'windowBands': bands,
                       'minWoodAreaM2': MIN_WOOD_AREA_M2},
        'seconds': round(time.time() - t0, 1),
    }
    (out / 'trees-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    sys.exit(main())
