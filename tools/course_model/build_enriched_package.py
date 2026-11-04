#!/usr/bin/env python3
"""Enrich a Looper course package with the course model's layers.

Reads public/course-geometry/<slug>/course-v1.json and writes course-v1-lidar.json
beside it, same schema, so the browser loader needs no changes:

- context.woods      LiDAR canopy (CHM >= 3 m) replaces WorldCover's 10 m
                     landcover-woods. The decision layer treats 'woods' as an
                     obstruction (tactical deep rough) wherever no golf surface
                     is mapped; WorldCover woods were ignored for decisions.
- surfaces.water / surfaces.bunker
                     every OSM water and bunker polygon in the hole's view,
                     unclipped (the importer's 110-yd corridor dropped some).
                     Islands and clearings (multipolygon inner rings, canopy
                     holes) are kept as keyhole rings, so an island green is
                     not water.
                     Fairway, green, tee and rough stay the hole's own, so the
                     engine cannot pick a neighbouring hole's fairway as a target.
- mapFeatures        cart paths, roads, buildings and parking from full OSM.
- terrain            rebuilt at 2 yd (was 10 yd) from the 1 m 3DEP DEM, same
                     encoding (0.1 ft above a per-hole offset, zlib, rows up from minY).

Projection is the builder's own (tools/build_osm_course_package.py), so new
geometry lines up exactly with the existing polygons.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import math
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid_io import load_grid  # noqa: E402
from register_terrain import utm, utm_zone_from_crs  # noqa: E402

R = 6_371_008.8          # builder EARTH_RADIUS_M
M_TO_YD = 1.0936133      # builder M_TO_YD
YD_TO_M = 1 / M_TO_YD
FT = 3.280839895
NODATA = 65535
MARGIN_YDS = 40.0


def frame_of(hole: dict):
    f = hole['coordinateFrame']
    lat0, lon0 = f['anchorLatLon']
    h = math.radians(f['headingDegreesTrue'])
    fwd = (math.sin(h), math.cos(h))
    right = (fwd[1], -fwd[0])
    return lat0, lon0, fwd, right


def to_local(frame, lat: float, lon: float) -> tuple[float, float]:
    lat0, lon0, fwd, right = frame
    north = R * math.radians(lat - lat0)
    east = R * math.radians(lon - lon0) * math.cos(math.radians(lat0))
    return ((east * right[0] + north * right[1]) * M_TO_YD, (east * fwd[0] + north * fwd[1]) * M_TO_YD)


def from_local(frame, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lat0, lon0, fwd, right = frame
    east = (x * right[0] + y * fwd[0]) * YD_TO_M
    north = (x * right[1] + y * fwd[1]) * YD_TO_M
    lat = lat0 + np.degrees(north / R)
    lon = lon0 + np.degrees(east / (R * math.cos(math.radians(lat0))))
    return lat, lon


def rdp(points: list, eps: float) -> list:
    if len(points) < 4:
        return points
    a, b = np.array(points[0]), np.array(points[-1])
    seg = b - a
    norm = np.hypot(*seg)
    pts = np.array(points)
    if norm == 0:
        d = np.hypot(*(pts - a).T)
    else:
        d = np.abs(seg[0] * (pts[:, 1] - a[1]) - seg[1] * (pts[:, 0] - a[0])) / norm
    i = int(np.argmax(d))
    if d[i] <= eps:
        return [points[0], points[-1]]
    return rdp(points[:i + 1], eps)[:-1] + rdp(points[i:], eps)


def ring_ok(ring: list) -> bool:
    if len(ring) < 3:
        return False
    area = abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1] for i in range(len(ring)))) / 2
    return area >= 20.0  # square yards


def clip_to_box(ring: list, box) -> list:
    """Sutherland-Hodgman clip of a polygon ring to an axis-aligned box."""
    def clip(points, inside, cross):
        out = []
        for i, cur in enumerate(points):
            prev = points[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        return out

    def at_x(a, b, x):
        t = (x - a[0]) / (b[0] - a[0])
        return [x, a[1] + t * (b[1] - a[1])]

    def at_y(a, b, y):
        t = (y - a[1]) / (b[1] - a[1])
        return [a[0] + t * (b[0] - a[0]), y]

    pts = [list(p) for p in ring]
    for inside, cross in (
        (lambda p: p[0] >= box[0], lambda a, b: at_x(a, b, box[0])),
        (lambda p: p[0] <= box[2], lambda a, b: at_x(a, b, box[2])),
        (lambda p: p[1] >= box[1], lambda a, b: at_y(a, b, box[1])),
        (lambda p: p[1] <= box[3], lambda a, b: at_y(a, b, box[3])),
    ):
        if not pts:
            break
        pts = clip(pts, inside, cross)
    return [[round(x, 1), round(y, 1)] for x, y in pts]


def in_box(ring, box) -> bool:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return not (max(xs) < box[0] or min(xs) > box[2] or max(ys) < box[1] or min(ys) > box[3])


def localize(frame, latlon_ring, eps=0.8) -> list:
    ring = [to_local(frame, lat, lon) for lat, lon in latlon_ring]
    if len(ring) > 3 and ring[0] == ring[-1]:
        ring = ring[:-1]
    ring = rdp(ring + [ring[0]], eps)[:-1] if len(ring) > 8 else ring
    return [[round(x, 1), round(y, 1)] for x, y in ring]


def assemble_rings(ways: list) -> list:
    """Join OSM relation member ways (open polylines) into closed rings."""
    pending = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while pending:
        ring = pending.pop(0)
        grew = True
        while ring[0] != ring[-1] and grew:
            grew = False
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[::-1][:-1] + ring
                else:
                    continue
                pending.pop(i)
                grew = True
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def point_in_ring(pt, ring) -> bool:
    x, y = pt
    inside = False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i], ring[i - 1]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def osm_features(osm: dict):
    """Yield (category, shapes, is_polygon).

    Polygons are [(outer_ring, [inner_rings])] so islands and clearings
    survive; lines are [polyline]. Multipolygon members are joined into rings.
    """
    for el in osm.get('elements', []):
        tags = el.get('tags') or {}
        shapes: list = []
        if el.get('type') == 'way' and el.get('geometry'):
            shapes = [[(p['lat'], p['lon']) for p in el['geometry']]]
            relation = False
        elif el.get('type') == 'relation':
            members = [m for m in el.get('members', []) if m.get('geometry')]
            outers = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']]
                                     for m in members if m.get('role') == 'outer'])
            inners = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']]
                                     for m in members if m.get('role') == 'inner'])
            shapes = [(o, [i for i in inners if point_in_ring(i[0], o)]) for o in outers]
            relation = True
        if not shapes:
            continue
        as_polys = shapes if relation else [(shapes[0], [])]
        golf, highway = tags.get('golf'), tags.get('highway')
        if golf == 'bunker' or (tags.get('natural') == 'sand' and 'golf' in tags):
            yield 'bunker', as_polys, True
        elif golf in {'water_hazard', 'lateral_water_hazard'} or tags.get('natural') == 'water' \
                or tags.get('water') or tags.get('waterway') == 'riverbank':
            yield 'water', as_polys, True
        elif golf in {'cartpath', 'path'} or highway in {'path', 'footway', 'track', 'cycleway'}:
            yield 'cartpath', [o for o, _ in as_polys] if relation else shapes, False
        elif highway:
            yield 'road', [o for o, _ in as_polys] if relation else shapes, False
        elif 'building' in tags:
            yield 'building', as_polys, True
        elif tags.get('amenity') == 'parking':
            yield 'parking', as_polys, True


WOODS_TAGS = (('natural', 'wood'), ('landuse', 'forest'))


def osm_woods(osm: dict) -> list:
    """[(outer, [inners])] (lat, lon) for the map's natural=wood / landuse=forest."""
    rings = []
    for el in osm.get('elements', []):
        tags = el.get('tags') or {}
        if not any(tags.get(k) == v for k, v in WOODS_TAGS):
            continue
        if el.get('type') == 'way' and el.get('geometry'):
            ring = [(p['lat'], p['lon']) for p in el['geometry']]
            if len(ring) >= 4:
                rings.append((ring, []))
        elif el.get('type') == 'relation':
            members = [m for m in el.get('members', []) if m.get('geometry')]
            outers = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']]
                                     for m in members if m.get('role') == 'outer'])
            inners = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']]
                                     for m in members if m.get('role') == 'inner'])
            rings.extend((o, [i for i in inners if point_in_ring(i[0], o)]) for o in outers)
    return rings


def ring_area(ring: list) -> float:
    return sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring))) / 2


def keyhole(outer: list, holes: list) -> list:
    """One ring that keeps its holes: each hole is joined to the outline at
    its nearest outline vertex by a zero-width cut and walked the other way
    round. Even-odd point tests and SVG fills both see the hole as outside;
    the single-ring format (and every consumer of it) stays unchanged.
    (Cuts go to the original outline, so a cut can graze another hole on a
    canopy with many clearings: a hairline artefact, never a filled hole.)"""
    ring = outer if ring_area(outer) > 0 else outer[::-1]          # CCW outline
    o = np.asarray(ring, dtype=float)
    splices: dict[int, list] = {}
    for hole in holes:
        hole = hole if ring_area(hole) < 0 else hole[::-1]          # CW hole
        hv = np.asarray(hole, dtype=float)
        d = ((o[:, None, :] - hv[None, :, :]) ** 2).sum(axis=2)
        i, j = np.unravel_index(int(np.argmin(d)), d.shape)
        splices.setdefault(int(i), []).append(hole[j:] + hole[:j + 1])
    out: list = []
    for i, p in enumerate(ring):
        out.append(p)
        for loop in splices.get(i, []):
            out.extend(loop)
            out.append(p)
    return out


def localize_polygon(frame, outer, inners, eps: float) -> list:
    """Local-yards ring for an outline with holes (holes under 20 sq yd are dropped)."""
    ring = localize(frame, outer, eps=eps)
    holes = [h for h in (localize(frame, i, eps=eps) for i in inners) if ring_ok(h)]
    return keyhole(ring, holes) if holes else ring


COARSE_DEM_METERS = 5.0


def dem_source(dem_h: dict) -> tuple[str, float, str]:
    """(package terrain source, source resolution m, dataset) for a DEM grid.

    1 m LiDAR bare earth (USGS 3DEP, NRCan HRDEM) is 'lidar-dem'; a coarse
    global model (Copernicus GLO-30) is 'global-dem', which the PC treats as
    coarse and corrects to GSPro's own heights."""
    prov = dem_h.get('provenance') or {}
    res = float(prov.get('sourceResolutionMeters') or 1.0)
    dataset = str(prov.get('dataset') or 'USGS 3DEP DEM')
    return ('global-dem' if res >= COARSE_DEM_METERS else 'lidar-dem'), res, dataset


def build_terrain(frame, view: dict, dem_h: dict, dem: np.ndarray, spacing: float) -> dict:
    from scipy.ndimage import map_coordinates
    min_x = math.floor(view['minX'] / spacing) * spacing
    min_y = math.floor(view['minY'] / spacing) * spacing
    max_x = math.ceil(view['maxX'] / spacing) * spacing
    max_y = math.ceil(view['maxY'] / spacing) * spacing
    xs = np.arange(min_x, max_x + spacing * 0.25, spacing)
    ys = np.arange(min_y, max_y + spacing * 0.25, spacing)
    xx, yy = np.meshgrid(xs, ys)
    lat, lon = from_local(frame, xx, yy)
    zone = utm_zone_from_crs(dem_h['crs'])
    en = np.array([utm(la, lo, zone) for la, lo in zip(lat.ravel(), lon.ravel())])
    px = dem_h['pixelSize']
    cols = (en[:, 0] - dem_h['originX']) / px - 0.5
    rows = (dem_h['originY'] - en[:, 1]) / px - 0.5
    z = map_coordinates(np.nan_to_num(dem, nan=-1e4), [rows, cols], order=1, mode='constant', cval=-1e4)
    z = np.where(z < -1e3, np.nan, z).reshape(xx.shape) * FT
    valid = np.isfinite(z)
    if valid.mean() < 0.95:
        raise RuntimeError(f'DEM coverage {valid.mean():.1%} < 95%')
    offset = math.floor(float(np.nanmin(z)) * 10) / 10
    q = np.rint((z - offset) * 10)
    enc = np.full(z.shape, NODATA, dtype='<u2')
    good = valid & (q >= 0) & (q < NODATA)
    enc[good] = q[good].astype('<u2')
    source, res, dataset = dem_source(dem_h)
    return {
        'compression': 'deflate', 'elevationOffsetFt': round(offset, 1), 'height': int(len(ys)),
        'interpolation': 'bilinear', 'minX': round(float(min_x), 3), 'minY': round(float(min_y), 3),
        'nodata': NODATA, 'runtimeSpacingYds': spacing, 'source': source, 'sourceResolutionMeters': res,
        'valuesBase64': base64.b64encode(zlib.compress(enc.tobytes(), 9)).decode('ascii'), 'width': int(len(xs)),
        'note': f'{spacing:g}-yd whole-hole terrain from the {res:g} m {dataset} (course model).',
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--package', required=True, type=Path)
    ap.add_argument('--model-dir', required=True, type=Path, help='artifacts/course-model/<slug>')
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--terrain-spacing-yds', type=float, default=2.0)
    args = ap.parse_args()

    pkg = json.loads(args.package.read_text())
    md = args.model_dir
    dem_json = md / 'dem-utm-1m.json' if (md / 'dem-utm-1m.json').exists() else md / 'dem-utm16n-1m.json'
    dem_h, dem = load_grid(dem_json)
    utm_zone_from_crs(dem_h['crs'])  # any UTM zone (NAD83 or WGS84, north or south)
    osm = json.loads(gzip.open(md / 'osm-full.json.gz', 'rt', encoding='utf-8').read())
    feats = list(osm_features(osm))
    woods_rings = []
    # LiDAR tree canopy when the course model has a point cloud (or NRCan
    # DSM); otherwise the map's own woods (USGS bare earth only: Pinehurst).
    lidar_trees = (md / 'woods.geojson').exists()
    if lidar_trees:
        for f in json.loads((md / 'woods.geojson').read_text())['features']:
            g = f['geometry']
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            for poly in polys:
                woods_rings.append(([(lat, lon) for lon, lat in poly[0]],
                                    [[(lat, lon) for lon, lat in hole] for hole in poly[1:]]))
    else:
        woods_rings = osm_woods(osm)

    out = json.loads(json.dumps(pkg))
    report = {}
    for key, hole in out['holes'].items():
        frame = frame_of(hole)
        v = hole['viewBounds']
        box = (v['minX'] - MARGIN_YDS, v['minY'] - MARGIN_YDS, v['maxX'] + MARGIN_YDS, v['maxY'] + MARGIN_YDS)
        ctx = dict(hole.get('context') or {})
        ctx.pop('landcover-woods', None)
        wood_polys = [c for c in (clip_to_box(r, box) for r in (localize_polygon(frame, outer, holes, eps=1.5)
                      for outer, holes in woods_rings) if in_box(r, box)) if ring_ok(c)]
        ctx['woods'] = wood_polys
        hole['context'] = ctx
        surfaces = dict(hole.get('surfaces') or {})
        before = {k: len(surfaces.get(k, [])) for k in ('bunker', 'water')}
        for kind in ('bunker', 'water'):
            polys = [r for cat, shapes, is_poly in feats if cat == kind and is_poly
                     for r in (localize_polygon(frame, outer, holes, eps=0.3) for outer, holes in shapes)
                     if ring_ok(r) and in_box(r, box)]
            if polys:
                surfaces[kind] = polys
        hole['surfaces'] = surfaces
        mf = {}
        for cat, shapes, is_poly in feats:
            if cat not in ('cartpath', 'road', 'building', 'parking'):
                continue
            for shape in shapes:
                if is_poly:
                    outer, holes = shape
                    pts = localize_polygon(frame, outer, holes, eps=0.3)
                    if in_box(pts, box) and ring_ok(pts):
                        mf.setdefault(cat, {}).setdefault('polygons', []).append(pts)
                    continue
                pts = [[round(x, 1), round(y, 1)] for x, y in (to_local(frame, la, lo) for la, lo in shape)]
                if in_box(pts, box) and len(pts) >= 2:
                    mf.setdefault(cat, {}).setdefault('lines', []).append(rdp(pts, 0.5))
        hole['mapFeatures'] = mf
        hole['terrain'] = build_terrain(frame, v, dem_h, dem, args.terrain_spacing_yds)
        report[key] = {'woodsPolygons': len(wood_polys),
                       'bunker': f"{before['bunker']}->{len(surfaces.get('bunker', []))}",
                       'water': f"{before['water']}->{len(surfaces.get('water', []))}",
                       'mapFeatures': {k: sum(len(g.get(t, [])) for t in ('lines', 'polygons')) for k, g in mf.items()},
                       'terrainCells': hole['terrain']['width'] * hole['terrain']['height']}

    _, _, dataset = dem_source(dem_h)
    out['landcoverProvenance'] = {
        'provider': 'LiDAR canopy height model via Looper course model' if lidar_trees
        else 'OpenStreetMap woods (no LiDAR point cloud for this course)',
        'resolutionMeters': 1 if lidar_trees else None,
        'role': "tactical 'woods' context (obstruction) where no golf surface is mapped; replaces ESA WorldCover woods",
    }
    out['enrichment'] = {
        'schemaVersion': 'looper-course-enrichment-v1',
        'source': 'course-model-prototype-v1 (tools/course_model/build_enriched_package.py)',
        'terrainSpacingYds': args.terrain_spacing_yds,
        'trees': 'lidar' if lidar_trees else 'osm',
        'terrainDataset': dataset,
        'license': 'OSM data (c) OpenStreetMap contributors, ODbL; LiDAR/DEM public domain (USGS)',
    }
    text = json.dumps(out, separators=(',', ':')) + '\n'
    args.out.write_text(text)
    print(json.dumps({'bytes': len(text), 'originalBytes': args.package.stat().st_size, 'holes': report['1'],
                      'woodsTotal': sum(r['woodsPolygons'] for r in report.values())}, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
