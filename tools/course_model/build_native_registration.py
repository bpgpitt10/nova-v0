#!/usr/bin/env python3
"""Build the web app's native registration file for one course.

Output (public/course-geometry/<slug>/native-registration-v1.json) lets the
browser turn GSPro world x/z straight into each hole's map yards:

  GSPro x/z (true-north metres)
    -> lat/lon via a local tangent plane at a course reference point
    -> hole-local yards with the course builder's own equirectangular frame
       (anchor = hole's selected tee lat/lon, axes rotated by hole heading)

It contains the fitted offset, the reference point, per-hole frames copied from
the course package and the GKD layout fingerprint. It contains NO GKD geometry.

The same conversion is mirrored in src/courseGeometry/nativeRegistration.ts.
Running this script also checks it end to end: every GKD pin must land inside
an OSM green polygon of its hole in the package's own coordinates.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gkd_native as gkd  # noqa: E402
from register_terrain import utm16n  # noqa: E402

# Must match tools/build_osm_course_package.py
BUILDER_EARTH_RADIUS_M = 6_371_008.8
BUILDER_M_TO_YD = 1.0936133
# GRS80 / WGS84 ellipsoid for the GSPro -> lat/lon step
A = 6378137.0
F = 1 / 298.257222101
E2 = F * (2 - F)


def radii(lat_deg: float) -> tuple[float, float]:
    s = math.sin(math.radians(lat_deg))
    w = math.sqrt(1 - E2 * s * s)
    meridian = A * (1 - E2) / w ** 3
    prime_vertical = A / w
    return meridian, prime_vertical


def world_to_latlon(reg: dict, x: float, z: float) -> tuple[float, float]:
    lat0, lon0 = reg['reference']['latLon']
    x0, z0 = reg['reference']['worldXZ']
    m, n = radii(lat0)
    lat = lat0 + math.degrees((z - z0) / m)
    lon = lon0 + math.degrees((x - x0) / (n * math.cos(math.radians(lat0))))
    return lat, lon


def latlon_to_hole_local(frame: dict, lat: float, lon: float) -> tuple[float, float]:
    lat0, lon0 = frame['anchorLatLon']
    north = BUILDER_EARTH_RADIUS_M * math.radians(lat - lat0)
    east = BUILDER_EARTH_RADIUS_M * math.radians(lon - lon0) * math.cos(math.radians(lat0))
    h = math.radians(frame['headingDegreesTrue'])
    fwd = (math.sin(h), math.cos(h))
    right = (fwd[1], -fwd[0])
    return ((east * right[0] + north * right[1]) * BUILDER_M_TO_YD,
            (east * fwd[0] + north * fwd[1]) * BUILDER_M_TO_YD)


def point_in_polygon(pt, poly) -> bool:
    x, y = pt
    inside, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--registration', required=True, type=Path, help='registration-v1.json (register_terrain.py)')
    ap.add_argument('--course', required=True, type=Path, help='public course-v1.json')
    ap.add_argument('--gkd', required=True, type=Path, help="player's local GKD (fingerprint + check only)")
    ap.add_argument('--course-key', required=True, help='GSPro CourseKey, e.g. farmlinks_al_2_7_gsp')
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()

    fit = json.loads(args.registration.read_text())
    model = fit['models'][fit['chosenModel']]
    pkg = json.loads(args.course.read_text())
    course = gkd.normalize(*gkd.load_raw(args.gkd))
    if course['layoutFingerprint'] != gkd.layout_fingerprint(course['holes']):
        raise SystemExit('fingerprint mismatch')

    frames = {k: h['coordinateFrame'] for k, h in pkg['holes'].items() if h.get('coordinateFrame')}
    greens = [f['targetGreenLatLon'] for f in frames.values()]
    lat0 = sum(g[0] for g in greens) / len(greens)
    lon0 = sum(g[1] for g in greens) / len(greens)
    e, n = utm16n(lat0, lon0)
    th, s = math.radians(model['rotationDeg']), model['scale']
    dx, dn = (e - model['tE']) / s, (n - model['tN']) / s
    x0 = math.cos(th) * dx + math.sin(th) * dn
    z0 = -math.sin(th) * dx + math.cos(th) * dn

    out = {
        'schemaVersion': 'looper-native-registration-v1',
        'courseId': pkg['courseId'],
        'gsproCourseKey': args.course_key,
        'layoutFingerprint': course['layoutFingerprint'],
        'sceneFingerprint': course['sceneFingerprint'],
        'grade': fit['grade'],
        'method': 'terrain-height match, true-north GSPro frame (rotation/scale fixed by UTM geometry)',
        'reference': {'latLon': [round(lat0, 9), round(lon0, 9)], 'worldXZ': [round(x0, 4), round(z0, 4)]},
        'worldYToElevationOffsetM': model['dy'],
        'quality': {
            'heightResidualMedianM': model['fitResiduals']['medianAbsM'],
            'splitHalfCentreDifferenceM': fit['splitHalfCentreDifferenceM'],
            'heightPoints': model['fitResiduals']['n'],
        },
        'holes': {k: {'anchorLatLon': f['anchorLatLon'], 'headingDegreesTrue': f['headingDegreesTrue'],
                      'origin': f.get('origin')}
                  for k, f in sorted(frames.items(), key=lambda kv: int(kv[0]))},
        'note': ('Contains no GKD geometry. Applies to any layout (GKD or GKDalt) of this GSPro scene '
                 'whose pins and green centres match sceneFingerprint.'),
    }

    # End-to-end check in the package's own frame.
    inside = total = 0
    misses = []
    for h in course['holes']:
        frame = out['holes'].get(str(h['hole']))
        hole_pkg = pkg['holes'].get(str(h['hole']), {})
        green_polys = [poly for surf_kind, polys in (hole_pkg.get('surfaces') or {}).items()
                       if surf_kind == 'green' for poly in polys]
        if not frame or not green_polys:
            continue
        for p in h['pins']:
            total += 1
            local = latlon_to_hole_local(frame, *world_to_latlon(out, p['x'], p['z']))
            if any(point_in_polygon(local, poly) for poly in green_polys):
                inside += 1
            else:
                misses.append((h['hole'], p['slot']))
    out['quality']['pinsInsideOsmGreens'] = f'{inside}/{total}'
    args.out.write_text(json.dumps(out, indent=2) + '\n')
    print(json.dumps({'pinsInsideOsmGreens': f'{inside}/{total}', 'misses': misses,
                      'reference': out['reference']}))
    return 0 if total and inside == total else 1


if __name__ == '__main__':
    sys.exit(main())
