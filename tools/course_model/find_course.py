#!/usr/bin/env python3
"""Locate a golf course in OSM and pick its USGS LiDAR point cloud.

Writes <out>/course-bbox.json:
  bbox3857   [minx, miny, maxx, maxy] in EPSG:3857 (what the other stages read)
  bboxLonLat [w, s, e, n]
  crs        NAD83 UTM zone for the course (EPSG:269xx)
  osm        id/name/area of the matched leisure=golf_course
  ept        chosen USGS EPT url + why, and the other candidates

Course: the leisure=golf_course whose name matches --name-regex within
--radius-m of the approximate location, largest area wins; bbox gets a margin.
LiDAR: USGS public EPT datasets (hobuinc/usgs-lidar boundaries) intersecting
the bbox; newest year in the dataset name wins, then most points.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = 'the-looper-course-model-prototype/0.1 (github.com/bpgpitt10)'
OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
EPT_BOUNDARIES = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson'
R_MERC = 6378137.0


def get(url: str, data: bytes | None = None, timeout: int = 240) -> bytes:
    req = urllib.request.Request(url, data=data, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def overpass(query: str) -> dict:
    last = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                return json.loads(get(url, urllib.parse.urlencode({'data': query}).encode()))
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(8 * (attempt + 1))
    raise RuntimeError(f'overpass failed: {last}')


def ring_area_m2(ring: list[tuple[float, float]]) -> float:
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = 111_320.0
    pts = [(lon * k * math.cos(math.radians(lat0)), lat * 110_540.0) for lon, lat in ring]
    return abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2


def to_3857(lon: float, lat: float) -> tuple[float, float]:
    return R_MERC * math.radians(lon), R_MERC * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def bbox_intersects_polygon(bbox: tuple, geom: dict) -> bool:
    w, s, e, n = bbox
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    corners = [(w, s), (w, n), (e, s), (e, n), ((w + e) / 2, (s + n) / 2)]
    for poly in polys:
        outer = poly[0]
        xs = [p[0] for p in outer]
        ys = [p[1] for p in outer]
        if max(xs) < w or min(xs) > e or max(ys) < s or min(ys) > n:
            continue
        if any(point_in_ring(x, y, outer) for x, y in corners):
            return True
        if any(w <= p[0] <= e and s <= p[1] <= n for p in outer):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--name-regex', required=True)
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--radius-m', type=float, default=8000)
    ap.add_argument('--margin-m', type=float, default=150)
    ap.add_argument('--out', required=True)
    ap.add_argument('--osm-id', type=int, help='prefer this OSM way/relation id (from the search UI)')
    args = ap.parse_args()

    q = (f'[out:json][timeout:180];(way["leisure"="golf_course"](around:{args.radius_m},{args.lat},{args.lon});'
         f'relation["leisure"="golf_course"](around:{args.radius_m},{args.lat},{args.lon}););out body geom;')
    payload = overpass(q)
    rx = re.compile(args.name_regex, re.I)
    candidates = []
    for el in payload.get('elements', []):
        name = (el.get('tags') or {}).get('name', '')
        if el['type'] == 'way':
            rings = [[(p['lon'], p['lat']) for p in el.get('geometry') or []]]
        else:
            rings = [[(p['lon'], p['lat']) for p in m.get('geometry') or []]
                     for m in el.get('members', []) if m.get('role') == 'outer']
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        area = sum(ring_area_m2(r) for r in rings)
        candidates.append({'type': el['type'], 'id': el['id'], 'name': name, 'areaHa': round(area / 1e4, 1),
                           'nameMatch': bool(rx.search(name)), 'rings': rings})
    print(json.dumps([{k: c[k] for k in ('type', 'id', 'name', 'areaHa', 'nameMatch')} for c in candidates]))
    if args.osm_id:
        for c in candidates:
            if c['id'] == args.osm_id:
                c['nameMatch'] = True
    matched = [c for c in candidates if c['nameMatch']]
    if not matched:
        print(f'no leisure=golf_course matching /{args.name_regex}/ near {args.lat},{args.lon}', file=sys.stderr)
        return 1
    by_id = [c for c in matched if args.osm_id and c['id'] == args.osm_id]
    best = by_id[0] if by_id else max(matched, key=lambda c: c['areaHa'])
    lons = [p[0] for r in best['rings'] for p in r]
    lats = [p[1] for r in best['rings'] for p in r]
    # OSM course outlines are often incomplete (Muirfield Village's covers
    # 107 ha and cuts through Hole 1). Grow the box to every golf playing
    # feature within 600 m of the outline's box.
    pad_lat = 600 / 110_540.0
    pad_lon = 600 / (111_320.0 * math.cos(math.radians((min(lats) + max(lats)) / 2)))
    s0, w0, n0, e0 = min(lats) - pad_lat, min(lons) - pad_lon, max(lats) + pad_lat, max(lons) + pad_lon
    golf_q = (f'[out:json][timeout:180];way["golf"~"^(hole|fairway|green|tee|bunker|rough|water_hazard|lateral_water_hazard)$"]'
              f'({s0},{w0},{n0},{e0});out geom;')
    grown = 0
    for el in overpass(golf_q).get('elements', []):
        for p in el.get('geometry') or []:
            lons.append(p['lon'])
            lats.append(p['lat'])
            grown += 1
    print(f'grew bbox with {grown} vertices from nearby golf features')
    lat_mid = (min(lats) + max(lats)) / 2
    dlat = args.margin_m / 110_540.0
    dlon = args.margin_m / (111_320.0 * math.cos(math.radians(lat_mid)))
    w, s, e, n = min(lons) - dlon, min(lats) - dlat, max(lons) + dlon, max(lats) + dlat
    x0, y0 = to_3857(w, s)
    x1, y1 = to_3857(e, n)
    zone = int((((w + e) / 2) + 180) // 6) + 1

    boundaries = json.loads(get(EPT_BOUNDARIES, timeout=300))
    hits = []
    for f in boundaries.get('features', []):
        props = f.get('properties') or {}
        if not f.get('geometry') or not bbox_intersects_polygon((w, s, e, n), f['geometry']):
            continue
        years = [int(y) for y in re.findall(r'(?<!\d)(20\d\d|19\d\d)(?!\d)', props.get('name', ''))]
        hits.append({'name': props.get('name'), 'url': props.get('url'), 'count': props.get('count'),
                     'year': max(years) if years else 0})
    hits.sort(key=lambda h: (h['year'], h['count'] or 0), reverse=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    record = {
        'schemaVersion': 'looper-course-model-bbox-v1',
        'bbox3857': [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
        'bboxLonLat': [w, s, e, n],
        'crs': f'EPSG:{26900 + zone}',
        'utmZone': zone,
        'osm': {k: best[k] for k in ('type', 'id', 'name', 'areaHa')},
        'ept': {'url': hits[0]['url'] if hits else None,
                'chosen': hits[0] if hits else None,
                'rule': 'newest year in dataset name, then most points',
                'candidates': hits[:8]},
    }
    (out / 'course-bbox.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: record[k] for k in ('bboxLonLat', 'crs', 'osm')}), json.dumps(record['ept']['chosen']))
    return 0 if hits else 2


if __name__ == '__main__':
    sys.exit(main())
