#!/usr/bin/env python3
"""Top-down preview of the layered course model (diagnostic only, not runtime).

Hillshaded LiDAR terrain + every OSM golf/water/path/building feature +
LiDAR-detected trees, for the whole course and a Hole 1 crop. Used to compare
source completeness against the external Manele reference by eye.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid_io import load_grid  # noqa: E402

FILL = {  # draw order = dict order
    'golf_course': ('#dfe8d2', None), 'rough': ('#a9c98a', None), 'first_cut': ('#93c26f', None),
    'fairway': ('#6fb24f', None), 'driving_range': ('#8cbf6a', None), 'tee': ('#5aa043', '#2f6b22'),
    'green': ('#47c25a', '#1f7a2f'), 'bunker': ('#eadcae', '#b59f62'), 'sand': ('#eadcae', None),
    'water': ('#7fb6e6', '#3d7fbf'), 'wetland': ('#a5c9c0', None), 'building': ('#8a7f78', '#4d4540'),
}


def classify(tags: dict) -> str | None:
    golf = tags.get('golf')
    if golf in {'fairway', 'green', 'bunker', 'tee', 'rough', 'first_cut', 'driving_range'}:
        return golf
    if golf in {'water_hazard', 'lateral_water_hazard'} or tags.get('natural') == 'water' \
            or tags.get('water') or tags.get('waterway') == 'riverbank':
        return 'water'
    if tags.get('natural') == 'sand':
        return 'sand'
    if tags.get('natural') == 'wetland':
        return 'wetland'
    if tags.get('leisure') == 'golf_course':
        return 'golf_course'
    if 'building' in tags:
        return 'building'
    return None


def load_osm(path: Path, to_utm):
    payload = json.loads(gzip.open(path, 'rt', encoding='utf-8').read())
    polys = {k: [] for k in FILL}
    lines = []
    golf_values = {}
    for el in payload.get('elements', []):
        tags = el.get('tags') or {}
        if 'golf' in tags:
            golf_values[tags['golf']] = golf_values.get(tags['golf'], 0) + 1
        rings = []
        if el.get('type') == 'way' and el.get('geometry'):
            rings = [el['geometry']]
        elif el.get('type') == 'relation':
            rings = [m['geometry'] for m in el.get('members', [])
                     if m.get('role') == 'outer' and m.get('geometry')]
        kind = classify(tags)
        for ring in rings:
            pts = np.array([to_utm.transform(p['lon'], p['lat']) for p in ring])
            closed = len(pts) >= 4 and np.allclose(pts[0], pts[-1])
            if kind and closed:
                polys[kind].append(pts)
            elif el.get('type') == 'way' and (tags.get('highway') or tags.get('golf') == 'cartpath'
                                             or tags.get('waterway')):
                lines.append((pts, 'water' if tags.get('waterway') else 'path'))
    return polys, lines, golf_values


def hillshade(z: np.ndarray, px: float) -> np.ndarray:
    z = np.nan_to_num(z, nan=np.nanmedian(z))
    dy, dx = np.gradient(z, px)
    slope = np.pi / 2 - np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az, alt = np.radians(315), np.radians(45)
    hs = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def render(ax, extent_xy, dem_h, dem, polys, lines, trees, woods_polys):
    from matplotlib.collections import PatchCollection, LineCollection
    from matplotlib.patches import Circle, Polygon as MplPolygon
    px = dem_h['pixelSize']
    x0, y0 = dem_h['originX'], dem_h['originY']
    ext = [x0, x0 + dem.shape[1] * px, y0 - dem.shape[0] * px, y0]
    ax.imshow(hillshade(dem, px), cmap='gray', extent=ext, vmin=0, vmax=1, alpha=0.9)
    for wp in woods_polys:
        ax.add_patch(MplPolygon(wp, closed=True, facecolor='#2f5d34', edgecolor='none', alpha=0.25))
    for kind, (face, edge) in FILL.items():
        for pts in polys[kind]:
            ax.add_patch(MplPolygon(pts, closed=True, facecolor=face, edgecolor=edge or 'none',
                                    linewidth=0.4, alpha=0.85 if kind != 'golf_course' else 0.35))
    segs_p = [p for p, k in lines if k == 'path']
    segs_w = [p for p, k in lines if k == 'water']
    ax.add_collection(LineCollection(segs_p, colors='#d9d4cc', linewidths=1.2))
    ax.add_collection(LineCollection(segs_w, colors='#3d7fbf', linewidths=1.0))
    circles = [Circle((x, y), r) for x, y, r, _ in trees]
    ax.add_collection(PatchCollection(circles, facecolor='#1e4d24', edgecolor='#0f2a12',
                                      linewidth=0.2, alpha=0.75))
    ax.set_xlim(extent_xy[0], extent_xy[1])
    ax.set_ylim(extent_xy[2], extent_xy[3])
    ax.set_aspect('equal')
    ax.set_xticks([])
    ax.set_yticks([])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dir', required=True, help='course-model output dir')
    ap.add_argument('--course', required=True, help='public course-v1.json (for Hole 1 tee/green)')
    args = ap.parse_args()

    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from pyproj import Transformer

    d = Path(args.dir)
    to_utm = Transformer.from_crs('EPSG:4326', 'EPSG:26916', always_xy=True)
    dem_h, dem = load_grid(d / 'dem-utm16n-1m.json')
    polys, lines, golf_values = load_osm(d / 'osm-full.json.gz', to_utm)
    trees = []
    if (d / 'trees.geojson').exists():
        for f in json.loads((d / 'trees.geojson').read_text())['features']:
            x, y = f['properties']['utm16n']
            trees.append((x, y, f['properties']['crown_radius_m'], f['properties']['height_m']))
    woods_polys = []
    if (d / 'woods.geojson').exists():
        for f in json.loads((d / 'woods.geojson').read_text())['features']:
            g = f['geometry']
            rings = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
            for ring in rings:
                woods_polys.append(np.array([to_utm.transform(lon, lat) for lon, lat in ring]))

    px = dem_h['pixelSize']
    full = [dem_h['originX'], dem_h['originX'] + dem.shape[1] * px,
            dem_h['originY'] - dem.shape[0] * px, dem_h['originY']]
    fig, ax = plt.subplots(figsize=(12, 12 * (full[3] - full[2]) / (full[1] - full[0])), dpi=170)
    render(ax, full, dem_h, dem, polys, lines, trees, woods_polys)
    ax.set_title('FarmLinks — LiDAR terrain + full OSM + LiDAR trees (prototype)', fontsize=10)
    fig.tight_layout()
    fig.savefig(d / 'preview-course.png')
    plt.close(fig)

    course = json.loads(Path(args.course).read_text())
    frame = course['holes']['1']['coordinateFrame']
    tee = to_utm.transform(frame['selectedTeeLatLon'][1], frame['selectedTeeLatLon'][0])
    green = to_utm.transform(frame['targetGreenLatLon'][1], frame['targetGreenLatLon'][0])
    m = 110
    box = [min(tee[0], green[0]) - m, max(tee[0], green[0]) + m,
           min(tee[1], green[1]) - m, max(tee[1], green[1]) + m]
    fig, ax = plt.subplots(figsize=(7, 7 * (box[3] - box[2]) / (box[1] - box[0])), dpi=200)
    render(ax, box, dem_h, dem, polys, lines, trees, woods_polys)
    ax.plot([tee[0], green[0]], [tee[1], green[1]], color='white', lw=0.8, ls='--')
    ax.set_title('FarmLinks Hole 1 — prototype layers', fontsize=9)
    fig.tight_layout()
    fig.savefig(d / 'preview-h1.png')
    plt.close(fig)

    (d / 'osm-golf-values.json').write_text(json.dumps(dict(sorted(golf_values.items())), indent=2) + '\n')
    print(json.dumps({'golfValues': golf_values, 'trees': len(trees), 'woodsPolys': len(woods_polys)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
