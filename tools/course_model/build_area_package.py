#!/usr/bin/env python3
"""Package a whole course area for Looper, without OpenStreetMap hole numbers.

The hole-by-hole loader needs OpenStreetMap to draw exactly one golf=hole line
per hole 1-18. Many courses fail that (Frosty Valley: 9 holes drawn; Bandon
Dunes, Bethpage: several courses in one outline; Pinehurst No. 2: holes
drawn but not numbered). GSPro's own course file already says what each hole
is, so the hole frames come from it on the player's PC; the cloud only needs to
package what the map knows about the ground:

  surfaces     fairway, green, tee, rough, bunker, water (all of them, unnumbered)
  context      LiDAR tree canopy (or OSM woods), scrub, heath/grass, sand
  mapFeatures  cart paths, roads, buildings, parking
  terrain      2-yd grid from the 1 m DEM (coarser if the area is very large)
  greens       every green's centroid, for matching GSPro's greens on the PC

One course-wide frame: x = east yards, y = north yards from the area centre,
the builder's own equirectangular projection (build_osm_course_package.py), so
the browser maps it exactly as it maps hole packages.

Output: public/course-geometry/<slug>/course-area-v1.json
GSPro's course files are never read here.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_enriched_package import (  # noqa: E402
    assemble_rings, build_terrain, localize_polygon, osm_features, point_in_ring, rdp, ring_area, ring_ok, to_local,
)
from grid_io import load_grid  # noqa: E402

# find_course already grew the box to every golf feature plus 150 m; the DEM
# tiles cover that box, so no extra margin (terrain needs 95% DEM coverage).
AREA_MARGIN_YDS = 0.0
MAX_TERRAIN_CELLS = 1_600_000

GOLF_SURFACES = {'fairway': 'fairway', 'green': 'green', 'tee': 'tee', 'rough': 'rough'}
CONTEXT = {
    ('natural', 'wood'): 'woods', ('landuse', 'forest'): 'woods',
    ('natural', 'scrub'): 'scrub',
    ('natural', 'heath'): 'native-grass', ('natural', 'grassland'): 'native-grass',
    ('landuse', 'meadow'): 'grass-context', ('landuse', 'grass'): 'grass-context',
}


def shapes_of(el: dict):
    """[(outer_ring, [inner_rings])] in (lat, lon), multipolygons assembled."""
    if el.get('type') == 'way' and el.get('geometry'):
        ring = [(p['lat'], p['lon']) for p in el['geometry']]
        return [(ring, [])] if len(ring) >= 4 else []
    if el.get('type') == 'relation':
        members = [m for m in el.get('members', []) if m.get('geometry')]
        outers = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']] for m in members if m.get('role') == 'outer'])
        inners = assemble_rings([[(p['lat'], p['lon']) for p in m['geometry']] for m in members if m.get('role') == 'inner'])
        return [(o, [i for i in inners if point_in_ring(i[0], o)]) for o in outers]
    return []


def area_frame(bbox_lonlat):
    w, s, e, n = bbox_lonlat
    lat0, lon0 = (s + n) / 2, (w + e) / 2
    # heading 0: forward = north, right = east -> (x, y) = (east, north) yards
    return lat0, lon0, (0.0, 1.0), (1.0, 0.0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model-dir', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--course-id', required=True)
    ap.add_argument('--course-name', required=True)
    ap.add_argument('--location', default='')
    ap.add_argument('--slug', required=True)
    ap.add_argument('--alias', action='append', default=[])
    ap.add_argument('--terrain-spacing-yds', type=float, default=2.0)
    args = ap.parse_args()
    t0 = time.time()

    md = args.model_dir
    bbox = json.loads((md / 'course-bbox.json').read_text())
    frame = area_frame(bbox['bboxLonLat'])
    w, s, e, n = bbox['bboxLonLat']
    corners = [to_local(frame, lat, lon) for lat, lon in ((s, w), (s, e), (n, w), (n, e))]
    view = {
        'minX': round(min(c[0] for c in corners) - AREA_MARGIN_YDS, 1),
        'maxX': round(max(c[0] for c in corners) + AREA_MARGIN_YDS, 1),
        'minY': round(min(c[1] for c in corners) - AREA_MARGIN_YDS, 1),
        'maxY': round(max(c[1] for c in corners) + AREA_MARGIN_YDS, 1),
    }

    osm = json.loads(gzip.open(md / 'osm-full.json.gz', 'rt', encoding='utf-8').read())
    surfaces: dict[str, list] = {}
    context: dict[str, list] = {}
    greens: list[dict] = []
    for el in osm.get('elements', []):
        tags = el.get('tags') or {}
        kind = GOLF_SURFACES.get(tags.get('golf') or '')
        ctx = next((v for (k, val), v in CONTEXT.items() if tags.get(k) == val), None)
        if tags.get('natural') == 'sand' and 'golf' not in tags:
            ctx = 'dune-sand'
        if not kind and not ctx:
            continue
        for outer, inners in shapes_of(el):
            ring = localize_polygon(frame, outer, inners, eps=0.3 if kind else 1.0)
            if not ring_ok(ring):
                continue
            if kind:
                surfaces.setdefault(kind, []).append(ring)
                if kind == 'green':
                    lat = sum(p[0] for p in outer) / len(outer)
                    lon = sum(p[1] for p in outer) / len(outer)
                    greens.append({'id': f"{el.get('type')}/{el.get('id')}", 'latLon': [round(lat, 7), round(lon, 7)],
                                   'areaSqYds': round(abs(ring_area(ring)), 1)})
            else:
                context.setdefault(ctx, []).append(ring)

    # Bunkers and water exactly as the hole packages take them; paths, roads, buildings.
    map_features: dict = {}
    for cat, shapes, is_poly in osm_features(osm):
        if cat in ('bunker', 'water') and is_poly:
            for outer, holes in shapes:
                ring = localize_polygon(frame, outer, holes, eps=0.3)
                if ring_ok(ring):
                    surfaces.setdefault(cat, []).append(ring)
            continue
        if cat not in ('cartpath', 'road', 'building', 'parking'):
            continue
        for shape in shapes:
            if is_poly:
                outer, holes = shape
                ring = localize_polygon(frame, outer, holes, eps=0.3)
                if ring_ok(ring):
                    map_features.setdefault(cat, {}).setdefault('polygons', []).append(ring)
            else:
                pts = [[round(x, 1), round(y, 1)] for x, y in (to_local(frame, la, lo) for la, lo in shape)]
                if len(pts) >= 2:
                    map_features.setdefault(cat, {}).setdefault('lines', []).append(rdp(pts, 0.5))

    # LiDAR tree canopy replaces OSM woods where the course model built it.
    woods_path = md / 'woods.geojson'
    lidar_woods = False
    if woods_path.exists():
        rings = []
        for f in json.loads(woods_path.read_text())['features']:
            g = f['geometry']
            for poly in ([g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']):
                outer = [(lat, lon) for lon, lat in poly[0]]
                inners = [[(lat, lon) for lon, lat in hole] for hole in poly[1:]]
                ring = localize_polygon(frame, outer, inners, eps=1.5)
                if ring_ok(ring):
                    rings.append(ring)
        if rings:
            context['woods'] = rings
            lidar_woods = True

    if not greens:
        raise SystemExit('No greens mapped in this area: nothing to match GSPro\'s greens against.')

    cells = ((view['maxX'] - view['minX']) / args.terrain_spacing_yds) * ((view['maxY'] - view['minY']) / args.terrain_spacing_yds)
    spacing = args.terrain_spacing_yds
    while cells > MAX_TERRAIN_CELLS:
        spacing += 1.0
        cells = ((view['maxX'] - view['minX']) / spacing) * ((view['maxY'] - view['minY']) / spacing)
    dem_json = md / 'dem-utm-1m.json' if (md / 'dem-utm-1m.json').exists() else md / 'dem-utm16n-1m.json'
    dem_h, dem = load_grid(dem_json)
    terrain = build_terrain(frame, view, dem_h, dem, spacing)
    terrain['note'] = (f"{spacing:g}-yd course-area terrain from the {terrain['sourceResolutionMeters']:g} m "
                       f"{(dem_h.get('provenance') or {}).get('dataset') or 'DEM'} (course model).")

    lat0, lon0 = frame[0], frame[1]
    out = {
        'schemaVersion': 'looper-course-area-v1',
        'courseId': args.course_id,
        'courseName': args.course_name,
        'location': args.location,
        'slug': args.slug,
        'gsproAliases': sorted({a for a in [args.course_name, *args.alias] if a}),
        'osmCourseElement': bbox.get('osm'),
        'provenance': {
            'geometrySource': 'osm-course-area',
            'attribution': '© OpenStreetMap contributors',
            'license': 'ODbL-1.0',
            'note': "Whole-area map package: holes come from the player's GSPro course file on their PC.",
        },
        **({'enrichment': {'schemaVersion': 'looper-course-enrichment-v1', 'terrainSpacingYds': spacing,
                           'trees': 'lidar'}} if lidar_woods else {}),
        'area': {
            'coordinateFrame': {'anchorLatLon': [round(lat0, 8), round(lon0, 8)], 'headingDegreesTrue': 0.0,
                                'origin': 'area-centre'},
            'viewBounds': view,
            'surfaces': surfaces,
            'context': context,
            'mapFeatures': map_features,
            'terrain': terrain,
            'greens': greens,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(out, separators=(',', ':')) + '\n'
    args.out.write_text(text)
    print(json.dumps({
        'bytes': len(text), 'seconds': round(time.time() - t0, 1), 'terrainSpacingYds': spacing,
        'terrainCells': terrain['width'] * terrain['height'], 'greens': len(greens),
        'surfaces': {k: len(v) for k, v in surfaces.items()}, 'context': {k: len(v) for k, v in context.items()},
        'lidarWoods': lidar_woods,
    }, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
