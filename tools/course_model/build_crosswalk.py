#!/usr/bin/env python3
"""Build the course crosswalk: every public GSPro course -> the real course on OpenStreetMap.

Brian (11/4): "couldn't we just do a crosswalk of names ... make it a
reference table". Simulator Golf Tour hosts the public GSPro course manifest
(https://simulatorgolftour.com/course_manifest.json, 2,745 courses on 11/4):
SGT id, name, CourseFolder (the course key GSPro reports, e.g. GreyWolf_gsp),
location, coordinates and altitude. Its course page feed
(/sgt-api/courses/page-data) adds courses missing from the manifest. With real
coordinates the OSM match is local (golf courses mapped within a few km),
never a town lookup by name ("Panorama, BC" geocoded to Vancouver and loaded
Point Grey as Greywolf).

  1. Read SGT's manifest and course page feed (joined on the SGT id).
  2. Fetch every leisure=golf_course on OSM near those courses, a few big
     tiles at a time (Overpass, `out tags center`).
  3. Match each course: the best-named OSM course within 8 km. Status
     matched / review / no-map / fictional, top candidates kept for review.
  4. GSPro keys: the manifest's CourseFolder, plus keys from players'
     libraries (gspro_library) for courses only the page feed lists.
  5. Upsert public.course_crosswalk. Rows a person fixed (method 'manual') or
     a course match confirmed (verified) keep their OSM course.

Writes need SUPABASE_SECRET_KEY (service role). --dry-run prints a summary.
Data: course list (c) Simulator Golf Tour, credited in the app; OSM ODbL.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Same servers as tools/fetch_osm_course_snapshot.py (not imported: it needs shapely).
OVERPASS_URLS = (
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
)

SGT_MANIFEST = 'https://simulatorgolftour.com/course_manifest.json'
SGT_PAGE_DATA = 'https://simulatorgolftour.com/sgt-api/courses/page-data'
SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://kdjfdchzfemjpmaqpobn.supabase.co')
USER_AGENT = 'TheLooperCourseCrosswalk/1.0 (+https://thelooper.golf)'
TILE_DEG = 4.0
TILE_MARGIN_DEG = 0.1
NEAR_KM = 3.0
FAR_KM = 8.0
MATCH_SCORE = 0.6
FAR_MATCH_SCORE = 0.8
REVIEW_SCORE = 0.3
UNNAMED_NEAR_KM = 1.5

STOP = {
    'golf', 'club', 'course', 'courses', 'country', 'cc', 'gc', 'gl', 'the', 'links', 'resort', 'resorts',
    'at', 'and', 'of', 'no', 'gsp', 'v1', 'v2', 'v3', 'golfclub', 'golfplatz', 'de', 'la', 'le', 'du', 'des',
    'g', 'c', 'gcc', 'golfbane', 'golfbana', 'golfpark', 'cg',
}
ABBREVIATIONS = {'gc': 'golf club', 'cc': 'country club', 'gl': 'golf links', 'g&cc': 'golf and country club',
                 'st': 'saint', 'mt': 'mount', 'ft': 'fort'}


# ------------------------------------------------------------------ names

def plain(name: str) -> str:
    text = unicodedata.normalize('NFKD', name or '')
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[ʻ‘’'`]", '', text).lower()


def words(name: str) -> list[str]:
    return ' '.join(ABBREVIATIONS.get(w, w) for w in re.findall(r'[a-z0-9&]+', plain(name))).split()


def tokens(name: str) -> list[str]:
    return [w for w in words(name) if w not in STOP]


def same_word(a: str, b: str) -> bool:
    """Equal, or one a long prefix of the other ("pinehurst" / "pinehursts");
    never "grey" for "greywolf" (11/4: Point Grey matched Greywolf)."""
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 5 and long_.startswith(short) and len(short) / len(long_) >= 0.75


def name_score(course: str, osm: str) -> float:
    """Share of the course name's words found in the OSM name (0-1); names
    that differ only in spacing ("Grey Wolf" / "Greywolf") score 1."""
    a, b = tokens(course), tokens(osm)
    if not a or not b:
        return 0.0
    if ''.join(a) == ''.join(b):
        return 1.0
    hit = sum(1 for w in a if any(same_word(w, x) for x in b))
    return hit / len(a)


def tie_score(course: str, osm: str) -> float:
    """Every word counts ("Golf Club" vs "Country Club")."""
    a, b = set(words(course)), set(words(osm))
    return len(a & b) / len(a | b) if a and b else 0.0


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat = math.radians((lat1 + lat2) / 2)
    return math.hypot((lat1 - lat2) * 111.32, (lon1 - lon2) * 111.32 * math.cos(lat))


# ------------------------------------------------------------------ sources

def http(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 120, method: str | None = None):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'User-Agent': USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


SGT_FIELDS = ('sgtId', 'name', 'location', 'par', 'difficulty', 'styleBits', 'flagA', 'blank', 'updated',
              'designer', 'flagB', 'lat', 'lon')


def _num(value) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def sgt_courses(manifest: list | None = None, page_data: dict | None = None) -> list[dict]:
    """SGT's courses: the manifest (GSPro's course folder, altitude), with the
    course page feed filling coordinates and courses the manifest lacks."""
    if manifest is None:
        manifest = json.loads(http(SGT_MANIFEST, headers={'Referer': 'https://simulatorgolftour.com/courses/'}))
    if page_data is None:
        page_data = json.loads(http(SGT_PAGE_DATA, headers={'Referer': 'https://simulatorgolftour.com/courses/'}))
    feed = {int(r[0]): dict(zip(SGT_FIELDS, r)) for r in page_data.get('courses') or [] if r and r[0] is not None}
    out: dict[int, dict] = {}
    for m in manifest or []:
        if not isinstance(m, dict) or m.get('courseId') is None:
            continue
        sid = int(m['courseId'])
        f = feed.get(sid, {})
        lat, lon = _num(m.get('CourseLat')), _num(m.get('CourseLon'))
        if lat is None or lon is None or (abs(lat) < 1e-6 and abs(lon) < 1e-6):
            lat, lon = _num(f.get('lat')), _num(f.get('lon'))
        location = (m.get('CourseLocation') or f.get('location') or
                    ', '.join(p for p in (m.get('City'), m.get('State'), m.get('Country')) if p) or '').strip()
        out[sid] = {
            'sgt_id': sid,
            'name': str(m.get('Name') or f.get('name') or '').strip(),
            'location': location,
            'country': (m.get('Country') or '').strip() or None,
            'par': m.get('Par') if isinstance(m.get('Par'), int) else (f.get('par') if isinstance(f.get('par'), int) else None),
            'designer': (str(m.get('CourseDesigner') or f.get('designer') or '').strip() or None),
            'elevation_ft': m.get('ElevationInFeet') if isinstance(m.get('ElevationInFeet'), int) else None,
            'lat': round(lat, 6) if lat is not None else None,
            'lon': round(lon, 6) if lon is not None else None,
            'sgt_updated': (m.get('LastUpdated') or f.get('updated') or None),
            'gspro_folder': (str(m.get('CourseFolder') or '').strip() or None),
        }
    for sid, f in feed.items():
        if sid in out:
            continue
        lat, lon = _num(f.get('lat')), _num(f.get('lon'))
        out[sid] = {
            'sgt_id': sid, 'name': str(f.get('name') or '').strip(), 'location': str(f.get('location') or '').strip(),
            'country': None, 'par': f.get('par') if isinstance(f.get('par'), int) else None,
            'designer': (str(f.get('designer') or '').strip() or None), 'elevation_ft': None,
            'lat': round(lat, 6) if lat is not None else None, 'lon': round(lon, 6) if lon is not None else None,
            'sgt_updated': f.get('updated') or None, 'gspro_folder': None,
        }
    return [c for c in out.values() if c['name']]


_endpoint = [OVERPASS_URLS[0]]


def overpass(query: str) -> dict:
    errors = []
    for attempt in range(4):
        order = [_endpoint[0]] + [u for u in OVERPASS_URLS if u != _endpoint[0]]
        for url in order:
            try:
                body = http(url, urllib.parse.urlencode({'data': query}).encode(), timeout=200)
                _endpoint[0] = url
                return json.loads(body)
            except Exception as exc:  # noqa: BLE001
                errors.append(f'{url.split("/")[2]}: {exc}')
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f'overpass failed: {"; ".join(errors[-4:])}')


def osm_courses_near(courses: list[dict]) -> list[dict]:
    """Every leisure=golf_course in the tiles that hold SGT courses."""
    tiles = defaultdict(int)
    for c in courses:
        if c['lat'] is not None:
            tiles[(math.floor(c['lat'] / TILE_DEG), math.floor(c['lon'] / TILE_DEG))] += 1
    found: dict[tuple[str, int], dict] = {}
    for i, (ty, tx) in enumerate(sorted(tiles)):
        s, w = ty * TILE_DEG - TILE_MARGIN_DEG, tx * TILE_DEG - TILE_MARGIN_DEG
        n, e = s + TILE_DEG + 2 * TILE_MARGIN_DEG, w + TILE_DEG + 2 * TILE_MARGIN_DEG
        q = (f'[out:json][timeout:180];(way["leisure"="golf_course"]({s},{w},{n},{e});'
             f'relation["leisure"="golf_course"]({s},{w},{n},{e}););out tags center;')
        payload = overpass(q)
        for el in payload.get('elements', []):
            center = el.get('center') or {}
            if 'lat' not in center:
                continue
            found[(el['type'], el['id'])] = {'type': el['type'], 'id': el['id'],
                                             'name': (el.get('tags') or {}).get('name') or '',
                                             'lat': center['lat'], 'lon': center['lon']}
        print(f'tile {i + 1}/{len(tiles)} ({ty * TILE_DEG:g},{tx * TILE_DEG:g}): {tiles[(ty, tx)]} SGT courses, '
              f'{len(payload.get("elements", []))} OSM courses', flush=True)
    return list(found.values())


# ------------------------------------------------------------------ matching

def fictional(c: dict) -> bool:
    return c['lat'] is None or c['lon'] is None or 'fictional' in c['location'].lower() \
        or (abs(c['lat']) < 1e-6 and abs(c['lon']) < 1e-6)


def match(c: dict, grid: dict) -> dict:
    """Status, OSM course and top candidates for one SGT course."""
    if fictional(c):
        return {'status': 'fictional', 'candidates': []}
    cy, cx = math.floor(c['lat'] / 0.1), math.floor(c['lon'] / 0.1)
    near = []
    for dy in range(-1, 2):
        for dx in range(-3, 4):  # 0.1 deg of longitude shrinks toward the poles
            for el in grid.get((cy + dy, cx + dx), []):
                d = km(c['lat'], c['lon'], el['lat'], el['lon'])
                if d <= FAR_KM:
                    near.append({**el, 'km': d, 'score': name_score(c['name'], el['name']),
                                 'tie': tie_score(c['name'], el['name'])})
    near.sort(key=lambda x: (-x['score'], -x['tie'], x['km']))
    cands = [{'type': x['type'], 'id': x['id'], 'name': x['name'], 'distanceM': round(x['km'] * 1000),
              'score': round(x['score'], 2)} for x in near[:4]]
    pick = lambda x, status: {'status': status, 'osm_type': x['type'], 'osm_id': x['id'], 'osm_name': x['name'] or None,  # noqa: E731
                              'distance_m': round(x['km'] * 1000), 'name_score': round(x['score'], 2), 'candidates': cands}
    if not near:
        return {'status': 'no-map', 'candidates': []}
    best = near[0]
    strong = best['score'] >= (MATCH_SCORE if best['km'] <= NEAR_KM else FAR_MATCH_SCORE)
    if strong:
        rivals = [x for x in near[1:] if x['score'] >= best['score'] - 0.05 and x['tie'] >= best['tie'] - 0.05]
        return pick(best, 'review' if rivals else 'matched')
    if best['score'] >= REVIEW_SCORE:
        return pick(best, 'review')
    unnamed = sorted((x for x in near if not x['name'] and x['km'] <= UNNAMED_NEAR_KM), key=lambda x: x['km'])
    if unnamed:
        return pick(unnamed[0], 'review')
    closest = min(near, key=lambda x: x['km'])
    if closest['km'] <= 1.0:
        return pick(closest, 'review')  # a different name right there: renamed, or a neighbour
    return {'status': 'no-map', 'candidates': cands}


def gspro_keys_by_course(courses: list[dict], library: list[dict]) -> dict[int, set[str]]:
    """GSPro file keys (players' libraries) -> SGT course, by name (location breaks ties)."""
    by_plain = defaultdict(list)
    for c in courses:
        by_plain[' '.join(words(c['name']))].append(c)
    out: dict[int, set[str]] = defaultdict(set)
    for row in library:
        key, name, loc = row.get('course_key'), row.get('course_name') or '', row.get('location') or ''
        if not key or not name:
            continue
        hits = by_plain.get(' '.join(words(name)), [])
        if len(hits) != 1:
            scored = sorted(((name_score(name, c['name']) + 0.5 * tie_score(loc, c['location']), c) for c in courses
                             if name_score(name, c['name']) >= 0.8), key=lambda t: -t[0])
            hits = [scored[0][1]] if scored and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.2) else []
        if len(hits) == 1:
            out[hits[0]['sgt_id']].add(key)
    return out


# ------------------------------------------------------------------ Supabase

def rest(method: str, path: str, key: str, body=None, prefer: str | None = None):
    headers = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    if prefer:
        headers['Prefer'] = prefer
    raw = http(f'{SUPABASE_URL}/rest/v1/{path}', json.dumps(body).encode() if body is not None else None,
               headers, timeout=120, method=method)
    return json.loads(raw) if raw else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--manifest', type=Path, help='a saved course_manifest.json (tests)')
    ap.add_argument('--page-data', type=Path, help='a saved page-data JSON (tests)')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    key = os.environ.get('SUPABASE_SECRET_KEY')
    if not args.dry_run and not key:
        raise SystemExit('SUPABASE_SECRET_KEY is not set (or use --dry-run)')

    courses = sgt_courses(json.loads(args.manifest.read_text()) if args.manifest else None,
                          json.loads(args.page_data.read_text()) if args.page_data else None)
    if args.limit:
        courses = courses[:args.limit]
    print(f'SGT: {len(courses)} courses, {sum(1 for c in courses if c["gspro_folder"])} with a GSPro folder, '
          f'{sum(1 for c in courses if not fictional(c))} with a location', flush=True)
    osm = osm_courses_near([c for c in courses if not fictional(c)])
    grid = defaultdict(list)
    for el in osm:
        grid[(math.floor(el['lat'] / 0.1), math.floor(el['lon'] / 0.1))].append(el)
    print(f'OSM: {len(osm)} golf courses near them', flush=True)

    library = rest('GET', 'gspro_library?select=course_key,course_name,location', key) if key else []
    keys = gspro_keys_by_course(courses, library or [])
    existing = {r['sgt_id']: r for r in (rest('GET', 'course_crosswalk?select=sgt_id,method,verified,gspro_keys', key) or [])} \
        if key and not args.dry_run else {}

    rows, tally = [], defaultdict(int)
    for c in courses:
        m = match(c, grid)
        old = existing.get(c['sgt_id'])
        row = {**c, 'gspro_keys': sorted(keys.get(c['sgt_id'], set()) | set((old or {}).get('gspro_keys') or [])
                                        | ({c['gspro_folder']} if c['gspro_folder'] else set())),
               'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        if not (old and (old.get('method') != 'auto' or old.get('verified'))):
            row.update({'status': m['status'], 'osm_type': m.get('osm_type'), 'osm_id': m.get('osm_id'),
                        'osm_name': m.get('osm_name'), 'distance_m': m.get('distance_m'),
                        'name_score': m.get('name_score'), 'candidates': m['candidates'], 'method': 'auto'})
        tally[row.get('status', 'kept')] += 1
        rows.append(row)

    print(json.dumps({'courses': len(rows), 'status': dict(tally),
                      'withGsproKeys': sum(1 for r in rows if r['gspro_keys'])}, indent=1), flush=True)
    for r in rows:
        if r['name'].lower().startswith(('greywolf', 'pinehurst 2', 'bandon dunes', 'cape kidnappers', 'dunstanburgh',
                                          'detroit', 'valhalla', 'pebble', 'mammoth', 'kiawah', 'point grey')):
            print(f"  {r['name']} ({r['location']}) folder={r['gspro_folder']} -> {r.get('status')} "
                  f"{r.get('osm_type')}/{r.get('osm_id')} {r.get('osm_name')!r} {r.get('distance_m')} m "
                  f"score {r.get('name_score')}", flush=True)
    if args.dry_run:
        return 0
    # Same columns in every row of a batch (PostgREST requires it): kept rows send only the source fields.
    full = [r for r in rows if 'status' in r]
    kept = [{k: r[k] for k in ('sgt_id', 'name', 'location', 'country', 'par', 'designer', 'elevation_ft', 'lat',
                               'lon', 'sgt_updated', 'gspro_folder', 'gspro_keys', 'updated_at')}
            for r in rows if 'status' not in r]
    for batch_rows in (full, kept):
        for i in range(0, len(batch_rows), 500):
            rest('POST', 'course_crosswalk?on_conflict=sgt_id', key, batch_rows[i:i + 500],
                 prefer='resolution=merge-duplicates,return=minimal')
    print(f'upserted {len(full)} matched rows, {len(kept)} kept (manual or verified)', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
