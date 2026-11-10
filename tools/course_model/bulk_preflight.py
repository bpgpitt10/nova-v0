"""Bulk course preflight (temporary, diag branch, 10 Nov 2026): for each candidate
course (2027 majors, Brian's library, the most-played real GSPro courses), find it
on OpenStreetMap the way the loader does, count what is mapped (hole lines 1-18,
duplicates, greens, tees, fairways, bunkers, water) and say which terrain / LiDAR
source a load would use. SHARD/SHARDS env split the list across jobs. One JSON line
per course on stdout (read from the job log) plus a report file.
"""
from __future__ import annotations

import os

import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import find_course as fc  # noqa: E402

COURSES = [
    # (name, location, group, photon query, lat, lon)
    # 2027 majors and the Ryder Cup
    ('Augusta National Golf Club', 'Augusta, GA', '2027 Masters', 'Augusta National Golf Club', 33.503, -82.022),
    ('PGA Frisco Fields Ranch East', 'Frisco, TX', '2027 PGA Championship', 'Fields Ranch East', 33.155, -96.856),
    ('St Andrews Old Course', 'St Andrews, Scotland', '2027 Open', 'Old Course St Andrews', 56.343, -2.803),
    ('Memorial Park Golf Course', 'Houston, TX', '2027 Chevron (women)', 'Memorial Park Golf Course', 29.765, -95.437),
    ('Inverness Club', 'Toledo, OH', "2027 US Women's Open", 'Inverness Club', 41.652, -83.693),
    ('Congressional Country Club', 'Bethesda, MD', "2027 KPMG Women's PGA", 'Congressional Country Club', 39.000, -77.163),
    ('Evian Resort Golf Club', 'Evian-les-Bains, France', '2027 Evian (women)', 'Evian Resort Golf Club', 46.392, 6.581),
    ("Royal St George's", 'Sandwich, England', "2027 AIG Women's Open", "Royal St George's Golf Club", 51.276, 1.386),
    ('Adare Manor', 'Adare, Ireland', '2027 Ryder Cup', 'Adare Manor Golf', 52.563, -8.785),
    # Brian's GSPro library, not loaded
    ('Bethpage Black', 'Farmingdale, NY', 'library', 'Bethpage Black', 40.745, -73.454),
    ('Aronimink Golf Club', 'Newtown Square, PA', 'library', 'Aronimink Golf Club', 39.981, -75.398),
    ('Newport Country Club', 'Newport, RI', 'library', 'Newport Country Club', 41.446, -71.326),
    ('Torrey Pines North Course', 'La Jolla, CA', 'library', 'Torrey Pines North', 32.904, -117.245),
    ('Waialae Country Club', 'Honolulu, HI', 'library', 'Waialae Country Club', 21.271, -157.776),
    ('Mammoth Dunes', 'Nekoosa, WI', 'library', 'Mammoth Dunes', 44.155, -89.879),
    ('Copperhead (Innisbrook)', 'Palm Harbor, FL', 'library', 'Copperhead Innisbrook', 28.087, -82.744),
    ('Nicklaus North', 'Whistler, BC', 'library', 'Nicklaus North Golf', 50.131, -122.948),
    # Championship courses on every "best GSPro courses" list
    ('Oakmont Country Club', 'Oakmont, PA', 'famous', 'Oakmont Country Club', 40.526, -79.826),
    ('Merion Golf Club East', 'Ardmore, PA', 'famous', 'Merion Golf Club', 40.007, -75.312),
    ('Riviera Country Club', 'Pacific Palisades, CA', 'famous', 'Riviera Country Club', 34.050, -118.502),
    ('Los Angeles Country Club North', 'Los Angeles, CA', 'famous', 'Los Angeles Country Club', 34.069, -118.420),
    ('Pine Valley Golf Club', 'Pine Valley, NJ', 'famous', 'Pine Valley Golf Club', 39.786, -74.973),
    ('Seminole Golf Club', 'Juno Beach, FL', 'famous', 'Seminole Golf Club', 26.836, -80.043),
    ('Whistling Straits', 'Kohler, WI', 'famous', 'Whistling Straits', 43.853, -87.732),
    ('Quail Hollow Club', 'Charlotte, NC', 'famous', 'Quail Hollow Club', 35.114, -80.838),
    ('East Lake Golf Club', 'Atlanta, GA', 'famous', 'East Lake Golf Club', 33.742, -84.307),
    ('Royal Birkdale', 'Southport, England', 'famous', 'Royal Birkdale Golf Club', 53.620, -3.033),
    ('Carnoustie Championship', 'Carnoustie, Scotland', 'famous', 'Carnoustie Golf Links', 56.497, -2.718),
    ('Royal Liverpool', 'Hoylake, England', 'famous', 'Royal Liverpool Golf Club', 53.384, -3.185),
    ('Royal County Down', 'Newcastle, N. Ireland', 'famous', 'Royal County Down', 54.221, -5.886),
    ('Lahinch Old Course', 'Lahinch, Ireland', 'famous', 'Lahinch Golf Club', 52.934, -9.344),
    ('Sand Hills Golf Club', 'Mullen, NE', 'famous', 'Sand Hills Golf Club', 41.838, -101.044),
    ('Pacific Dunes', 'Bandon, OR', 'famous', 'Pacific Dunes', 43.186, -124.398),
    ('Streamsong Blue', 'Bowling Green, FL', 'famous', 'Streamsong Blue', 27.672, -81.951),
    ('TPC Scottsdale Stadium', 'Scottsdale, AZ', 'tour', 'TPC Scottsdale Stadium Course', 33.640, -111.912),
    ('Harbour Town Golf Links', 'Hilton Head, SC', 'tour', 'Harbour Town Golf Links', 32.139, -80.811),
    ('Sea Island Seaside', 'St Simons Island, GA', 'tour', 'Sea Island Seaside Course', 31.155, -81.385),
    ('Colonial Country Club', 'Fort Worth, TX', 'tour', 'Colonial Country Club', 32.712, -97.385),
]

# Second pass (10 Nov evening): misses, the wrong Carnoustie pick, the other
# Chevron venue report, 2028 majors, and the next destination / tour courses.
COURSES_2 = [
    ('Oakmont Country Club', 'Oakmont, PA', 'famous', 'Oakmont Country Club', 40.5264, -79.8262),
    ('Adare Manor', 'Adare, Ireland', '2027 Ryder Cup', 'Adare Manor', 52.5639, -8.7867),
    ('Lahinch Old Course', 'Lahinch, Ireland', 'famous', 'Lahinch', 52.9347, -9.3460),
    ('Mammoth Dunes', 'Nekoosa, WI', 'library', 'Sand Valley', 44.1430, -89.8650),
    ('Carnoustie Championship', 'Carnoustie, Scotland', 'famous', 'Carnoustie Championship', 56.4990, -2.7230),
    ('The Club at Carlton Woods', 'The Woodlands, TX', '2027 Chevron (alt report)', 'Carlton Woods', 30.1830, -95.5570),
    ('Winged Foot West', 'Mamaroneck, NY', '2028 US Open', 'Winged Foot', 40.9580, -73.7590),
    ('Olympic Club Lake', 'San Francisco, CA', '2028 PGA Championship', 'Olympic Club Lake', 37.7090, -122.4960),
    ('Royal Lytham & St Annes', 'Lytham St Annes, England', '2028 Open', 'Royal Lytham', 53.7470, -3.0060),
    ('Bandon Trails', 'Bandon, OR', 'destination', 'Bandon Trails', 43.1850, -124.3850),
    ('Old Macdonald', 'Bandon, OR', 'destination', 'Old Macdonald', 43.1700, -124.3900),
    ('Pumpkin Ridge Witch Hollow', 'North Plains, OR', 'destination', 'Pumpkin Ridge Witch Hollow', 45.6340, -123.0310),
    ('Congaree Golf Club', 'Ridgeland, SC', 'destination', 'Congaree Golf Club', 32.4540, -81.0390),
    ('Ohoopee Match Club', 'Cobbtown, GA', 'destination', 'Ohoopee Match Club', 32.2830, -82.1240),
    ('Kingsley Club', 'Kingsley, MI', 'destination', 'Kingsley Club', 44.5600, -85.5600),
    ('Medalist Golf Club', 'Hobe Sound, FL', 'destination', 'Medalist Golf Club', 27.0760, -80.1530),
    ('Palmetto Golf Club', 'Aiken, SC', 'destination', 'Palmetto Golf Club', 33.5410, -81.7380),
    ('Diamond Creek Golf Club', 'Banner Elk, NC', 'destination', 'Diamond Creek', 36.1470, -81.8520),
    ('Pelican Golf Club', 'Belleair, FL', 'tour', 'Pelican Golf Club', 27.9310, -82.8040),
    ('Tiburon Gold Course', 'Naples, FL', 'tour', 'Tiburon Golf Club', 26.2700, -81.7720),
    ('TPC Twin Cities', 'Blaine, MN', 'tour', 'TPC Twin Cities', 45.1820, -93.2300),
    ('Sedgefield Country Club', 'Greensboro, NC', 'tour', 'Sedgefield Country Club', 36.0280, -79.8510),
    ('TPC River Highlands', 'Cromwell, CT', 'tour', 'TPC River Highlands', 41.6200, -72.6600),
    ('Grand Cypress Links', 'Orlando, FL', 'library', 'Grand Cypress', 28.3780, -81.5130),
]
if os.environ.get('PASS') == '2':
    COURSES = COURSES_2

PHOTON = 'https://photon.komoot.io/api/?'


def photon(query: str, lat: float, lon: float) -> list[dict]:
    url = PHOTON + urllib.parse.urlencode({'q': query, 'lat': lat, 'lon': lon, 'limit': 8})
    try:
        data = json.loads(fc.get(url, timeout=60))
    except Exception as exc:  # noqa: BLE001
        return [{'error': str(exc)}]
    out = []
    for f in data.get('features', []):
        p = f.get('properties') or {}
        if p.get('osm_value') not in ('golf_course',) and p.get('osm_key') not in ('leisure', 'golf'):
            continue
        out.append({'name': p.get('name'), 'osm': f"{p.get('osm_type')}{p.get('osm_id')}",
                    'type': {'W': 'way', 'R': 'relation', 'N': 'node'}.get(p.get('osm_type')),
                    'id': p.get('osm_id'), 'value': p.get('osm_value'),
                    'lon': f['geometry']['coordinates'][0], 'lat': f['geometry']['coordinates'][1]})
    return out


def features(w: float, s: float, e: float, n: float) -> dict:
    q = f"""[out:json][timeout:120];
(
  way["golf"]({s},{w},{n},{e});
  relation["golf"]({s},{w},{n},{e});
  way["natural"="water"]({s},{w},{n},{e});
  relation["natural"="water"]({s},{w},{n},{e});
  way["natural"="wood"]({s},{w},{n},{e});
  way["landuse"="forest"]({s},{w},{n},{e});
);
out tags;"""
    data = fc.overpass(q)
    counts: dict[str, int] = {}
    refs: dict[str, int] = {}
    pars = 0
    for el in data.get('elements', []):
        t = el.get('tags') or {}
        kind = t.get('golf') or ('water' if t.get('natural') == 'water' else 'woods')
        counts[kind] = counts.get(kind, 0) + 1
        if t.get('golf') == 'hole':
            ref = (t.get('ref') or '').strip()
            refs[ref] = refs.get(ref, 0) + 1
            if t.get('par'):
                pars += 1
    numbered = {str(i) for i in range(1, 19)}
    present = sorted((r for r in refs if r in numbered), key=int)
    return {
        'counts': counts,
        'holesNumbered': len(present),
        'missingHoles': sorted(numbered - set(present), key=int),
        'duplicateHoles': sorted((r for r, c in refs.items() if r in numbered and c > 1), key=int),
        'unnumberedHoles': refs.get('', 0),
        'holesWithPar': pars,
    }


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else 'bulk-preflight')
    shard, shards = int(os.environ.get('SHARD', '0')), int(os.environ.get('SHARDS', '1'))
    out_dir.mkdir(parents=True, exist_ok=True)
    report = []
    for i, (name, where, status, query, lat, lon) in enumerate(COURSES):
        if i % shards != shard:
            continue
        row: dict = {'name': name, 'location': where, 'group': status}
        row['photon'] = photon(query, lat, lon)[:4]
        time.sleep(1.2)
        regex = '|'.join(part for part in query.replace("'", '.').split() if len(part) > 3)
        work = out_dir / name.lower().replace(' ', '-').replace("'", '')
        cmd = [sys.executable, str(HERE / 'find_course.py'), '--name-regex', regex,
               '--lat', str(lat), '--lon', str(lon), '--out', str(work), '--radius-m', '6000']
        best = next((p for p in row['photon'] if p.get('type') in ('way', 'relation')), None)
        if best:
            cmd += ['--osm-id', str(best['id'])]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if proc.returncode != 0:  # Overpass is flaky; one retry
            time.sleep(20)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        row['findLog'] = (proc.stdout + proc.stderr).strip().splitlines()[-6:]
        bbox_file = work / 'course-bbox.json'
        if proc.returncode == 0 and bbox_file.exists():
            bbox = json.loads(bbox_file.read_text())
            row['osm'] = bbox['osm']
            row['demProvider'] = bbox['demProvider']
            row['lidarPointCloud'] = (bbox.get('ept') or {}).get('chosen')
            row['hrdem'] = bool(bbox.get('hrdem'))
            w, s, e, n = bbox['bboxLonLat']
            try:
                row['mapped'] = features(w, s, e, n)
            except Exception as exc:  # noqa: BLE001
                row['mapped'] = {'error': str(exc)}
        else:
            row['osm'] = None
        report.append(row)
        print('PREFLIGHT ' + json.dumps({k: row.get(k) for k in ('name', 'group', 'osm', 'demProvider', 'lidarPointCloud', 'hrdem', 'mapped', 'photon') + (() if row.get('osm') else ('findLog',))}), flush=True)
        time.sleep(2)
    (out_dir / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
