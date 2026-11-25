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
# Public Overpass instances, tried in turn. overpass-api.de was "at capacity"
# for hours on 11/4 (a Bellerive load timed out in find after 14 minutes).
OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
EPT_BOUNDARIES = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson'
R_MERC = 6378137.0


def get(url: str, data: bytes | None = None, timeout: int = 240) -> bytes:
    req = urllib.request.Request(url, data=data, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def overpass(query: str) -> dict:
    """Two passes over every instance with a short wait each: a busy server
    answers a small query in seconds or not at all."""
    errors = []
    for attempt in range(2):
        for url in OVERPASS_URLS:
            try:
                return json.loads(get(url, urllib.parse.urlencode({'data': query}).encode(), timeout=150))
            except Exception as exc:  # noqa: BLE001
                errors.append(f'{url.split("/")[2]}: {exc}')
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'overpass failed on every server: {"; ".join(errors[-4:])}')


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


def golf_counts(elements: list[dict], rings: list) -> dict:
    """What OpenStreetMap has for this course, before minutes of loading (Kenai, 24 Nov: 16 greens and
    no holes failed after 12 minutes; We-Ko-Pa: two 18s in one outline loaded as a map with no holes).

    greensNearby   greens within 600 m of the outline (an upper bound: a neighbour's greens count too)
    holesNumbered  hole numbers 1-18 with a hole line inside the outline
    holesTwice     hole numbers mapped twice inside the outline more than 150 m apart (two courses)
    """
    def centre(el: dict) -> tuple[float, float] | None:
        pts = el.get('geometry') or []
        return (sum(p['lon'] for p in pts) / len(pts), sum(p['lat'] for p in pts) / len(pts)) if pts else None

    def inside(pt: tuple[float, float] | None) -> bool:
        return pt is not None and any(point_in_ring(pt[0], pt[1], ring) for ring in rings)

    greens = [el for el in elements if (el.get('tags') or {}).get('golf') == 'green']
    holes: dict[int, list[tuple[float, float]]] = {}
    for el in elements:
        tags = el.get('tags') or {}
        ref = str(tags.get('ref') or '').strip()
        pt = centre(el)
        if tags.get('golf') == 'hole' and ref.isdigit() and 1 <= int(ref) <= 18 and inside(pt):
            holes.setdefault(int(ref), []).append(pt)

    def apart_m(a: tuple[float, float], b: tuple[float, float]) -> float:
        k = 111_320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
        return math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110_540.0)

    twice = sorted(n for n, pts in holes.items()
                   if any(apart_m(a, b) > 150 for i, a in enumerate(pts) for b in pts[i + 1:]))
    return {'greensNearby': len(greens), 'greensInside': sum(1 for el in greens if inside(centre(el))),
            'holesNumbered': sorted(holes), 'holesTwice': twice}


def course_choices(best: dict, area: str, inside_only: bool, limit: int = 4) -> list[dict]:
    """Other named golf courses to ask the player about when a load can't go ahead: the courses inside
    this outline (Saguaro and Cholla inside "We-Ko-Pa Golf Club"), or the ones nearby when this outline
    can't be built (Kenai). Each can be loaded straight from the site's "Your courses" question."""
    try:
        found = overpass(f'[out:json][timeout:120];(way["leisure"="golf_course"]{area};'
                         f'relation["leisure"="golf_course"]{area};);out center tags;')
    except Exception as exc:  # noqa: BLE001 - choices are a nicety, never a failure
        print(f'course choices lookup failed: {exc}', file=sys.stderr)
        return []
    choices, seen = [], set()
    for el in found.get('elements', []):
        c, name = el.get('center') or {}, (el.get('tags') or {}).get('name')
        if not name or el.get('id') == best.get('id') or c.get('lon') is None or name in seen:
            continue
        if inside_only and not any(point_in_ring(c['lon'], c['lat'], ring) for ring in best['rings']):
            continue
        seen.add(name)
        choices.append({'name': name, 'osmType': el['type'], 'osmId': el['id'],
                        'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6)})
    return sorted(choices, key=lambda ch: ch['name'])[:limit]


def in_usgs_3dep_coverage(w: float, s: float, e: float, n: float) -> bool:
    """USGS 3DEP's bare-earth service covers the US (lower 48, Alaska,
    Hawaii, Puerto Rico); a box test is enough to pick it over Copernicus."""
    lon, lat = (w + e) / 2, (s + n) / 2
    lower48 = 24.0 <= lat <= 49.5 and -125.0 <= lon <= -66.5
    alaska = 51.0 <= lat <= 71.5 and -170.0 <= lon <= -129.5
    hawaii = 18.5 <= lat <= 22.5 and -160.5 <= lon <= -154.5
    puerto_rico = 17.8 <= lat <= 18.6 and -67.5 <= lon <= -65.2
    return lower48 or alaska or hawaii or puerto_rico


def utm_crs(zone: int, lat: float, lon: float) -> str:
    """NAD83 UTM in North America (zones 1-23, as every course so far), else WGS84 UTM north/south."""
    if lat > 0 and zone <= 23 and -170.0 <= lon <= -50.0:
        return f'EPSG:{26900 + zone}'
    return f'EPSG:{(32600 if lat >= 0 else 32700) + zone}'


#: When nothing named right is within --radius-m, look this far before giving up: the crosswalk's
#: coordinates come from the GSPro course listing and can be 4 to 17 km off (Dunes West 15 km,
#: Sand Hills 17 km, Palm Beach Gardens and Carlton Woods 4 km).
WIDE_RADIUS_M = 30000


def parse_candidates(payload: dict, rx: re.Pattern) -> list[dict]:
    """leisure=golf_course ways and relations with their outer rings, area and whether the name matches."""
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
    return candidates


def distance_m(lat: float, lon: float, candidate: dict) -> float:
    """From the given point to the middle of the candidate's outline."""
    pts = [p for r in candidate['rings'] for p in r]
    clon, clat = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    dy = (clat - lat) * 110_540.0
    dx = (clon - lon) * 111_320.0 * math.cos(math.radians(lat))
    return math.hypot(dx, dy)


def pick_course(candidates: list[dict], osm_id: int | None, lat: float, lon: float, *, wide: bool = False) -> dict | None:
    """The asked-for id if it is there; else, near the point, the largest outline whose name matches;
    in a wide search, the nearest one (a same-named course 25 km off is less likely the one)."""
    if osm_id:
        for c in candidates:
            if c['id'] == osm_id:
                return c
    matched = [c for c in candidates if c['nameMatch']]
    if not matched:
        return None
    if wide:
        return min(matched, key=lambda c: distance_m(lat, lon, c))
    return max(matched, key=lambda c: c['areaHa'])


def find(args: argparse.Namespace, rx: re.Pattern, query=None) -> tuple[dict | None, str]:
    """(course, how it was found). `query` is overpass(), swappable in tests."""
    query = query or overpass
    near = parse_candidates(query(
        f'[out:json][timeout:180];(way["leisure"="golf_course"](around:{args.radius_m},{args.lat},{args.lon});'
        f'relation["leisure"="golf_course"](around:{args.radius_m},{args.lat},{args.lon}););out body geom;'), rx)
    print(json.dumps([{k: c[k] for k in ('type', 'id', 'name', 'areaHa', 'nameMatch')} for c in near]))
    best = pick_course(near, args.osm_id, args.lat, args.lon)
    if best and (not args.osm_id or best['id'] == args.osm_id):
        return best, 'near'
    if args.osm_id:
        # The outline the request names, wherever it is: the coordinates may be the ones that are off.
        types = [args.osm_type] if args.osm_type in ('way', 'relation') else ['way', 'relation']
        by_id = parse_candidates(query('[out:json][timeout:180];(' + ''.join(f'{t}({args.osm_id});' for t in types)
                                       + ');out body geom;'), rx)
        by_id = [c for c in by_id if c['id'] == args.osm_id]
        if by_id:
            off = distance_m(args.lat, args.lon, by_id[0])
            print(f'took {by_id[0]["type"]} {args.osm_id} ({by_id[0]["name"] or "no name"}) by its id, '
                  f'{off / 1000:.1f} km from the given point')
            return by_id[0], 'by id'
        if best:
            return best, 'near'
    # Nothing named right nearby: look wider, by name.
    wide = parse_candidates(query(
        f'[out:json][timeout:180];(way["leisure"="golf_course"]["name"~"{args.name_regex}",i](around:{WIDE_RADIUS_M},{args.lat},{args.lon});'
        f'relation["leisure"="golf_course"]["name"~"{args.name_regex}",i](around:{WIDE_RADIUS_M},{args.lat},{args.lon}););out body geom;'), rx)
    best = pick_course(wide, None, args.lat, args.lon, wide=True)
    if best:
        print(f'nothing named /{args.name_regex}/ within {args.radius_m / 1000:g} km; took {best["name"]} '
              f'{distance_m(args.lat, args.lon, best) / 1000:.1f} km away')
        return best, 'wide'
    return None, ''


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--name-regex', required=True)
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--radius-m', type=float, default=8000)
    ap.add_argument('--margin-m', type=float, default=150)
    ap.add_argument('--out', required=True)
    ap.add_argument('--osm-id', type=int, help='prefer this OSM way/relation id (from the search UI)')
    ap.add_argument('--osm-type', choices=('way', 'relation'), help='what --osm-id is (both are tried without it)')
    args = ap.parse_args()

    rx = re.compile(args.name_regex, re.I)
    best, how = find(args, rx)
    if not best:
        print(f'no leisure=golf_course matching /{args.name_regex}/ within {WIDE_RADIUS_M / 1000:g} km of '
              f'{args.lat},{args.lon}', file=sys.stderr)
        return 1
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
    golf_elements = overpass(golf_q).get('elements', [])
    counts = golf_counts(golf_elements, best['rings'])
    print(f"OpenStreetMap: {counts['greensNearby']} greens nearby, holes numbered {len(counts['holesNumbered'])}/18"
          f"{', mapped twice: ' + str(counts['holesTwice']) if counts['holesTwice'] else ''}")
    complete = counts['holesNumbered'] in (list(range(1, 19)), list(range(1, 10)))
    others = course_choices(best, f'({s0},{w0},{n0},{e0})', inside_only=True) if len(counts['holesTwice']) >= 9 \
        else course_choices(best, f'(around:8000,{args.lat},{args.lon})', inside_only=False) \
        if not complete and counts['greensNearby'] < 18 else []
    for el in golf_elements:
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

    # No USGS LiDAR (outside the US): Canada's NRCan HRDEM covers much of the
    # country from LiDAR (Cabot Cliffs, 11/3). Its DTM replaces 3DEP and, where
    # published, DSM - DTM replaces the point cloud's canopy heights.
    hrdem = None
    if not hits:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import nrcan_hrdem  # noqa: E402
            hrdem = nrcan_hrdem.search((w, s, e, n))
            if hrdem:
                print(f"no USGS LiDAR; NRCan HRDEM {hrdem['collection']}: {len(hrdem['items'])} tile(s)"
                      f"{' with DSM' if any(i.get('dsm') for i in hrdem['items']) else ' (no DSM: no tree heights)'}")
        except Exception as exc:  # noqa: BLE001
            print(f'NRCan HRDEM search failed: {exc}', file=sys.stderr)

    # New Zealand: national 1 m LiDAR from LINZ (DEM + DSM), same shape as HRDEM.
    linz = None
    if not hits and not hrdem:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import linz_elevation  # noqa: E402
            linz = linz_elevation.search((w, s, e, n))
            if linz:
                print(f"LINZ {linz['collection']}: {len(linz['items'])} tile(s)"
                      f"{' with DSM' if any(i.get('dsm') for i in linz['items']) else ' (no DSM)'}")
        except Exception as exc:  # noqa: BLE001
            print(f'LINZ elevation search failed: {exc}', file=sys.stderr)

    # Terrain without a LiDAR point cloud (11/4: Pinehurst, Tobacco Road, Cape
    # Kidnappers, Dunstanburgh failed here):
    #   US           USGS 3DEP's nationwide bare-earth service (the dem stage's
    #                default), 1 m where flown; no point cloud means no LiDAR
    #                trees, so the map's woods stand in.
    #   New Zealand  LINZ 1 m DEM; DSM - DEM for trees (loads as a map area).
    #   elsewhere    Copernicus GLO-30 (30 m, global): coarse, but plays-like
    #                elevation everywhere. These load as map areas.
    if hits:
        provider = 'usgs-3dep'
    elif hrdem:
        provider = 'nrcan-hrdem'
    elif linz:
        provider = 'linz-1m'
    elif in_usgs_3dep_coverage(w, s, e, n):
        provider = 'usgs-3dep'
        print('no USGS LiDAR point cloud here; terrain from the USGS 3DEP bare-earth service, trees from the map')
    else:
        provider = 'copernicus-30m'
        print('outside USGS / NRCan coverage; terrain from Copernicus GLO-30 (30 m), trees from the map')

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    record = {
        'schemaVersion': 'looper-course-model-bbox-v1',
        'bbox3857': [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
        'bboxLonLat': [w, s, e, n],
        'crs': utm_crs(zone, (s + n) / 2, (w + e) / 2),
        'utmZone': zone,
        'osm': {**{k: best[k] for k in ('type', 'id', 'name', 'areaHa')}, 'found': how},
        'ept': {'url': hits[0]['url'] if hits else None,
                'chosen': hits[0] if hits else None,
                'rule': 'newest year in dataset name, then most points',
                'candidates': hits[:8]},
        'demProvider': provider,
        'osmGolf': counts,
        **({'courseChoices': others} if others else {}),
        **({'hrdem': hrdem} if hrdem else {}),
        **({'linz': linz} if linz else {}),
    }
    (out / 'course-bbox.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: record[k] for k in ('bboxLonLat', 'crs', 'osm', 'demProvider')}), json.dumps(record['ept']['chosen']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
