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
  2. Fetch every leisure=golf_course on OSM within 8 km of those courses,
     40 courses per Overpass query (`around`, `out tags center`).
  3. Match each course: the best-named OSM course within 8 km. Status
     matched / review / no-map / fictional, top candidates kept for review.
  4. GSPro keys: the manifest's CourseFolder, plus keys from players'
     libraries (gspro_library) for courses only the page feed lists.
  5. Upsert public.course_crosswalk after every batch (a failed batch is left
     for the next run; reruns only match courses not in the table unless
     --refresh). Rows a person fixed (method 'manual') or a course match
     confirmed (verified) keep their OSM course.

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
NEAR_KM = 3.0
FAR_KM = 8.0
# SGT's coordinates are often the town's, not the course's (Valhalla: downtown
# Louisville, 25 km away). Courses with no match nearby get a second look by
# name out to this far: only a strong, unique name match counts there.
NAME_SEARCH_KM = 45.0
NAME_SEARCH_SCORE = 0.8
NAME_BATCH = 20
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


BATCH = 40


def osm_courses_around(batch: list[dict]) -> list[dict]:
    """Every leisure=golf_course within FAR_KM of these courses (one Overpass
    query: a union of `around` clauses; 11/4 4-degree tiles took 40 s - 9 min each)."""
    radius = int(FAR_KM * 1000)
    parts = ''.join(f'way["leisure"="golf_course"](around:{radius},{c["lat"]},{c["lon"]});'
                    f'relation["leisure"="golf_course"](around:{radius},{c["lat"]},{c["lon"]});' for c in batch)
    payload = overpass(f'[out:json][timeout:180];({parts});out tags center;')
    out = []
    for el in payload.get('elements', []):
        center = el.get('center') or {}
        if 'lat' in center:
            out.append({'type': el['type'], 'id': el['id'], 'name': (el.get('tags') or {}).get('name') or '',
                        'lat': center['lat'], 'lon': center['lon']})
    return out


# ------------------------------------------------------------------ matching

def fictional(c: dict) -> bool:
    return c['lat'] is None or c['lon'] is None or 'fictional' in c['location'].lower() \
        or (abs(c['lat']) < 1e-6 and abs(c['lon']) < 1e-6)


GENERIC_WORDS = {
    'mountain', 'mountains', 'valley', 'creek', 'hills', 'hill', 'lake', 'lakes', 'pines', 'pine', 'national',
    'river', 'park', 'ridge', 'springs', 'oaks', 'meadows', 'dunes', 'point', 'north', 'south', 'east', 'west',
    'island', 'beach', 'harbor', 'harbour', 'canyon', 'ranch', 'woods', 'glen', 'stadium', 'championship',
    'plantation', 'farms', 'farm', 'municipal', 'heights', 'estates', 'village', 'trails', 'trail', 'royal',
}


def name_regex(name: str) -> str | None:
    """The course name's most telling word (not "Mountain" or "Creek"), as an Overpass regex."""
    words_ = sorted((w for w in tokens(name) if len(w) >= 4 and not w.isdigit()), key=len, reverse=True)
    word = next((w for w in words_ if w not in GENERIC_WORDS), words_[0] if words_ else None)
    return re.escape(word) if word else None


def osm_courses_by_name(batch: list[dict]) -> list[dict]:
    """Golf courses within NAME_SEARCH_KM whose name contains each course's telling word."""
    radius = int(NAME_SEARCH_KM * 1000)
    parts = ''
    for c in batch:
        rx = name_regex(c['name'])
        if not rx:
            continue
        for kind in ('way', 'relation'):
            parts += f'{kind}["leisure"="golf_course"]["name"~"{rx}",i](around:{radius},{c["lat"]},{c["lon"]});'
    if not parts:
        return []
    payload = overpass(f'[out:json][timeout:180];({parts});out tags center;')
    return [{'type': el['type'], 'id': el['id'], 'name': (el.get('tags') or {}).get('name') or '',
             'lat': el['center']['lat'], 'lon': el['center']['lon']}
            for el in payload.get('elements', []) if 'lat' in (el.get('center') or {})]


def match_by_name(c: dict, found: list[dict]) -> dict | None:
    """A strong, unique name match within NAME_SEARCH_KM, else None."""
    near = []
    for el in found:
        d = km(c['lat'], c['lon'], el['lat'], el['lon'])
        s = name_score(c['name'], el['name'])
        if d <= NAME_SEARCH_KM and s >= NAME_SEARCH_SCORE:
            near.append({**el, 'km': d, 'score': s, 'tie': tie_score(c['name'], el['name'])})
    if not near:
        return None
    near.sort(key=lambda x: (-x['score'], -x['tie'], x['km']))
    best = near[0]
    rivals = [x for x in near[1:] if x['score'] >= best['score'] - 0.05 and x['tie'] >= best['tie'] - 0.05]
    cands = [{'type': x['type'], 'id': x['id'], 'name': x['name'], 'distanceM': round(x['km'] * 1000),
              'score': round(x['score'], 2)} for x in near[:4]]
    return {'status': 'review' if rivals else 'matched', 'osm_type': best['type'], 'osm_id': best['id'],
            'osm_name': best['name'] or None, 'distance_m': round(best['km'] * 1000),
            'name_score': round(best['score'], 2), 'candidates': cands}


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


def name_search_pass(key: str | None, dry_run: bool) -> int:
    """Second look for 'no-map' rows the builder matched automatically: by name out to 45 km."""
    if not key:
        raise SystemExit('the name search reads the table: SUPABASE_SECRET_KEY is needed')
    rows = rest('GET', 'course_crosswalk?select=sgt_id,name,lat,lon&status=eq.no-map&method=eq.auto&verified=eq.false'
                       '&lat=not.is.null&order=sgt_id', key) or []
    print(f'name search: {len(rows)} courses with no map course near their coordinates', flush=True)
    tally: dict[str, int] = defaultdict(int)
    for i in range(0, len(rows), NAME_BATCH):
        batch = rows[i:i + NAME_BATCH]
        try:
            found = osm_courses_by_name(batch)
        except RuntimeError as exc:
            print(f'batch {i // NAME_BATCH + 1}: Overpass failed, left for the next run ({exc})', flush=True)
            continue
        for c in batch:
            m = match_by_name(c, found)
            if not m:
                tally['still no-map'] += 1
                continue
            tally[m['status']] += 1
            print(f"  {c['name']}: {m['status']} {m['osm_name']!r} {m['distance_m']} m", flush=True)
            if not dry_run:
                rest('PATCH', f"course_crosswalk?sgt_id=eq.{c['sgt_id']}", key,
                     {**m, 'notes': 'matched by name; SGT coordinates are the town, not the course',
                      'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                     prefer='return=minimal')
        print(f'name search batch {i // NAME_BATCH + 1}/{math.ceil(len(rows) / NAME_BATCH)}: {dict(tally)}', flush=True)
    print(json.dumps({'nameSearch': dict(tally)}, indent=1), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--manifest', type=Path, help='a saved course_manifest.json (tests)')
    ap.add_argument('--page-data', type=Path, help='a saved page-data JSON (tests)')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--refresh', action='store_true', help='re-match courses already in the table (else only new ones)')
    ap.add_argument('--name-search', action='store_true',
                    help="second look by name (up to 45 km) for courses with no match near SGT's coordinates")
    args = ap.parse_args()
    key = os.environ.get('SUPABASE_SECRET_KEY')
    if not args.dry_run and not key:
        raise SystemExit('SUPABASE_SECRET_KEY is not set (or use --dry-run)')
    if args.name_search:
        return name_search_pass(key, args.dry_run)

    courses = sgt_courses(json.loads(args.manifest.read_text()) if args.manifest else None,
                          json.loads(args.page_data.read_text()) if args.page_data else None)
    if args.limit:
        courses = courses[:args.limit]
    print(f'SGT: {len(courses)} courses, {sum(1 for c in courses if c["gspro_folder"])} with a GSPro folder, '
          f'{sum(1 for c in courses if not fictional(c))} with a location', flush=True)

    library = rest('GET', 'gspro_library?select=course_key,course_name,location', key) if key else []
    keys = gspro_keys_by_course(courses, library or [])
    existing = {r['sgt_id']: r for r in (rest('GET', 'course_crosswalk?select=sgt_id,method,verified,gspro_keys,status', key) or [])} \
        if key and not args.dry_run else {}
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    source_cols = ('sgt_id', 'name', 'location', 'country', 'par', 'designer', 'elevation_ft', 'lat', 'lon',
                   'sgt_updated', 'gspro_folder', 'gspro_keys', 'updated_at')

    def base_row(c: dict) -> dict:
        old = existing.get(c['sgt_id']) or {}
        return {**c, 'gspro_keys': sorted(keys.get(c['sgt_id'], set()) | set(old.get('gspro_keys') or [])
                                          | ({c['gspro_folder']} if c['gspro_folder'] else set())),
                'updated_at': now}

    def keep(c: dict) -> bool:
        """A person's fix or a course match's confirmation is never overwritten."""
        old = existing.get(c['sgt_id'])
        return bool(old and (old.get('method') != 'auto' or old.get('verified')))

    tally: dict[str, int] = defaultdict(int)
    shown: list[dict] = []

    def write(rows: list[dict]) -> None:
        full = [r for r in rows if 'status' in r]
        kept = [{k: r[k] for k in source_cols} for r in rows if 'status' not in r]
        for part in (full, kept):
            if part and not args.dry_run:
                rest('POST', 'course_crosswalk?on_conflict=sgt_id', key, part, prefer='resolution=merge-duplicates,return=minimal')
        for r in rows:
            tally[r.get('status', 'kept')] += 1
            if r['name'].lower().startswith(('greywolf', 'pinehurst 2', 'bandon dunes', 'cape kidnappers', 'dunstanburgh',
                                              'detroit golf', 'valhalla', 'pebble beach', 'mammoth', 'kiawah', 'needler')):
                shown.append(r)

    # Fictional courses: no map to look at.
    write([{**base_row(c), **({} if keep(c) else {'status': 'fictional', 'osm_type': None, 'osm_id': None,
            'osm_name': None, 'distance_m': None, 'name_score': None, 'candidates': [], 'method': 'auto'})}
           for c in courses if fictional(c)])
    todo = [c for c in courses if not fictional(c) and (args.refresh or c['sgt_id'] not in existing)]
    todo.sort(key=lambda c: (math.floor(c['lat'] / 2), math.floor(c['lon'] / 2), c['lat'], c['lon']))
    print(f'to match: {len(todo)} ({len(courses) - len(todo)} already in the table or fictional)', flush=True)
    failed = 0
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        try:
            osm = osm_courses_around(batch)
        except RuntimeError as exc:
            failed += len(batch)
            print(f'batch {i // BATCH + 1}: Overpass failed, left for the next run ({exc})', flush=True)
            continue
        grid = defaultdict(list)
        for el in osm:
            grid[(math.floor(el['lat'] / 0.1), math.floor(el['lon'] / 0.1))].append(el)
        rows = []
        for c in batch:
            row = base_row(c)
            if not keep(c):
                m = match(c, grid)
                row.update({'status': m['status'], 'osm_type': m.get('osm_type'), 'osm_id': m.get('osm_id'),
                            'osm_name': m.get('osm_name'), 'distance_m': m.get('distance_m'),
                            'name_score': m.get('name_score'), 'candidates': m['candidates'], 'method': 'auto'})
            rows.append(row)
        write(rows)
        print(f'batch {i // BATCH + 1}/{math.ceil(len(todo) / BATCH)}: {len(osm)} OSM courses; '
              f'so far {dict(tally)}', flush=True)

    print(json.dumps({'courses': len(courses), 'status': dict(tally), 'leftForNextRun': failed}, indent=1), flush=True)
    for r in shown:
        print(f"  {r['name']} ({r['location']}) folder={r['gspro_folder']} -> {r.get('status')} "
              f"{r.get('osm_type')}/{r.get('osm_id')} {r.get('osm_name')!r} {r.get('distance_m')} m "
              f"score {r.get('name_score')}", flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
