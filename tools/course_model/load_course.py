#!/usr/bin/env python3
"""Load a golf course into Looper, soup to nuts, and time every stage.

Input: a name and approximate location (what a "search, click Load" UI sends).
Output, when every gate passes:
  public/course-geometry/<slug>/course-v1.json        canonical Looper package
  public/course-geometry/<slug>/green-detail-v1.json  1-yd green terrain
  public/course-geometry/<slug>/course-v1-lidar.json  LiDAR trees, full OSM, 2-yd terrain
  config/course-geometry/<slug>-v1.json               importer config
  runtime registration (generated registry), so Round Setup lists the course
  artifacts/course-load/<slug>/load-report.json       stage timings + outcome

Stages (each timed; the first failure stops the load and is reported):
  find      OSM leisure=golf_course by name near the location; USGS LiDAR choice
  config    importer config from the OSM course element
  import    canonical importer: OSM snapshot, hole/tee geometry, terrain,
            WorldCover context, green detail, validation, runtime registration
  osm       full OSM around the course (paths, roads, buildings, all hazards)
  dem       1 m USGS 3DEP DEM in the course's UTM zone (1.5 km tiles)
  lidar     USGS point cloud -> canopy height model
  trees     trees + woodland polygons (power-line and building masks)
  enrich    LiDAR-enriched package beside the canonical one

Native GSPro positions (GKD registration) are NOT part of this: they need the
player's own GSPro course files and happen on their PC after loading.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def slugify(text: str) -> str:
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


STAGES = ('find', 'config', 'import', 'osm', 'dem', 'lidar', 'trees', 'enrich', 'area')
# The importer's message when OpenStreetMap doesn't draw one numbered hole line
# per hole 1-18 (fetch_osm_course_snapshot.validate_holes).
HOLES_NOT_MAPPED = 'one route per hole'


class Load:
    def __init__(self, slug: str, report_dir: Path, on_stage=None):
        self.on_stage = on_stage
        self.slug = slug
        self.report_dir = report_dir
        self.stages: list[dict] = []
        self.started = time.time()
        report_dir.mkdir(parents=True, exist_ok=True)
        self.log = (report_dir / 'load-log.txt').open('w')

    def stage(self, name: str, *cmd: str) -> bool:
        if self.on_stage:
            try:
                self.on_stage(name, STAGES.index(name) + 1 if name in STAGES else None, len(STAGES))
            except Exception as error:  # progress reporting must never stop a load
                print(f'progress hook failed: {error}', flush=True)
        t0 = time.time()
        self.log.write(f'=== [{self.slug}:{name}] {" ".join(cmd)}\n')
        self.log.flush()
        proc = subprocess.run(list(cmd), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.log.write(proc.stdout)
        seconds = round(time.time() - t0, 1)
        tail = proc.stdout.strip().splitlines()[-6:]
        self.stages.append({'stage': name, 'ok': proc.returncode == 0, 'seconds': seconds,
                            **({} if proc.returncode == 0 else {'error': tail})})
        self.log.write(f'=== [{self.slug}:{name}] rc={proc.returncode} seconds={seconds}\n')
        self.log.flush()
        print(f'[{self.slug}] {name}: {"ok" if proc.returncode == 0 else "FAILED"} in {seconds}s', flush=True)
        return proc.returncode == 0

    def note(self, name: str, ok: bool, seconds: float, **extra) -> None:
        self.stages.append({'stage': name, 'ok': ok, 'seconds': round(seconds, 1), **extra})

    def finish(self, request: dict, extra: dict) -> dict:
        ok = bool(self.stages) and all(s['ok'] for s in self.stages)
        report = {
            'schemaVersion': 'looper-course-load-report-v1',
            'slug': self.slug,
            'request': request,
            'ready': ok,
            'totalSeconds': round(time.time() - self.started, 1),
            'stages': self.stages,
            'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'runId': os.environ.get('GITHUB_RUN_ID'),
            **extra,
        }
        (self.report_dir / 'load-report.json').write_text(json.dumps(report, indent=2) + '\n')
        self.log.close()
        return report


def write_config(slug: str, request: dict, bbox: dict) -> Path:
    osm = bbox['osm']
    w, s, e, n = bbox['bboxLonLat']
    name = request.get('name') or osm['name']
    location = request.get('location') or ''
    aliases = sorted({a for a in [name, osm['name'], *(request.get('gsproAliases') or [])] if a})
    config = {
        'schemaVersion': 'looper-course-build-config-v1',
        'courseId': slugify(f'{name} {location}') or slug,
        'courseName': name,
        'location': location,
        'slug': slug,
        'gsproAliases': aliases,
        'osmCourseElement': {'type': osm['type'], 'id': osm['id']},
        'osmCenter': [round((s + n) / 2, 5), round((w + e) / 2, 5)],
        'landcoverContext': {'enabled': True, 'provider': 'ESA WorldCover 2021 v200'},
        # Outside USGS coverage the find stage picked NRCan HRDEM (Canada).
        **({'terrain': {'provider': 'nrcan-hrdem'}} if bbox.get('demProvider') == 'nrcan-hrdem' else {}),
        'selection': {'teeStartRadiusYards': 220, 'contextRouteDistanceYards': 110,
                      'behindTeeToleranceYards': 35, 'pastGreenToleranceYards': 50},
    }
    path = ROOT / 'config' / 'course-geometry' / f'{slug}-v1.json'
    path.write_text(json.dumps(config, indent=2) + '\n')
    return path


MAX_EPT_TRIES = 3


def lidar_from_point_cloud(load: 'Load', py: str, bbox: dict, bbox_path: str, model: Path) -> bool:
    """Canopy heights from the newest USGS survey that actually has points
    here; the newest one listed can be empty over the course (Detroit GC,
    Oakland County 2019). With none, trees come from the map (still ok)."""
    urls = [bbox['ept']['url']] + [c['url'] for c in bbox['ept'].get('candidates') or []
                                   if c.get('url') and c['url'] != bbox['ept']['url']]
    for url in urls[:MAX_EPT_TRIES]:
        if not load.stage('lidar', py, str(HERE / 'lidar_pipeline.py'), '--ept', url,
                          '--dem-source', bbox_path, '--dem', str(model / 'dem-utm-1m.json'), '--out', str(model)):
            return False
        stats = json.loads((model / 'lidar-stats.json').read_text())
        if stats.get('pointsKeptInBbox', 0) > 0:
            return True
        load.stages[-1]['note'] = f'no points over the course in {url}; trying the next survey'
        (model / 'chm-utm-1m.json').unlink(missing_ok=True)
    load.note('lidar', True, 0, trees='osm', note='no USGS survey has points over this course: trees from the map')
    return True


def load_one(request: dict, *, skip_import: bool = False, on_stage=None) -> dict:
    slug = request.get('slug') or slugify(request['name'])
    py = sys.executable
    report_dir = ROOT / 'artifacts' / 'course-load' / slug
    model = ROOT / '.tmp' / 'course-load' / slug / 'model'
    tmp = ROOT / '.tmp' / 'course-load' / slug / 'tmp'
    model.mkdir(parents=True, exist_ok=True)
    load = Load(slug, report_dir, on_stage)
    extra: dict = {}

    regex = request.get('nameRegex') or re.escape(request['name'].split()[0])
    if not load.stage('find', py, str(HERE / 'find_course.py'), '--name-regex', regex,
                      '--lat', str(request['lat']), '--lon', str(request['lon']),
                      '--radius-m', str(request.get('radiusM', 8000)), '--out', str(model),
                      *(['--osm-id', str(request['osmId'])] if request.get('osmId') else [])):
        return load.finish(request, extra)
    bbox = json.loads((model / 'course-bbox.json').read_text())
    extra['osmCourse'] = bbox['osm']
    extra['lidar'] = bbox['ept'].get('chosen')
    extra['crs'] = bbox['crs']

    t0 = time.time()
    config_path = write_config(slug, request, bbox)
    load.note('config', True, time.time() - t0, path=str(config_path.relative_to(ROOT)))

    # Area mode: OpenStreetMap doesn't number this course's holes (or the
    # player asked for it). Package the whole area; GSPro's own course file
    # supplies the holes on the player's PC (build_area_package.py).
    area_mode = request.get('mode') == 'area'
    # The hole importer only fetches USGS 3DEP / NRCan terrain itself. LINZ
    # (New Zealand) and Copernicus GLO-30 (elsewhere) load as areas; the PC
    # corrects coarse Copernicus terrain to GSPro's own heights.
    no_importer_terrain = bbox.get('demProvider') in ('copernicus-30m', 'linz-1m')
    if area_mode or no_importer_terrain:
        area_mode = True
        load.note('import', True, 0, mode='area',
                  note='area package requested' if request.get('mode') == 'area'
                  else f"terrain from {bbox.get('demProvider')}, which the hole importer doesn't take: "
                  'packaging the course area')
    elif not skip_import and not load.stage('import', py, 'tools/import_course_canonical.py',
                                            '--config', str(config_path.relative_to(ROOT)), '--slug', slug,
                                            '--reason', 'one-click-course-load'):
        failed = load.stages[-1]
        if HOLES_NOT_MAPPED not in ' '.join(failed.get('error') or []):
            return load.finish(request, extra)
        load.stages[-1] = {'stage': 'import', 'ok': True, 'seconds': failed['seconds'], 'mode': 'area',
                           'note': "OpenStreetMap doesn't number every hole once: packaging the course area instead",
                           'importError': failed.get('error')}
        area_mode = True
    if area_mode:
        extra['mode'] = 'area'

    bbox_path = str(model / 'course-bbox.json')
    ok = (load.stage('osm', py, str(HERE / 'fetch_sources.py'), 'osm', '--dem-source', bbox_path, '--out', str(model))
          and load.stage('dem', py, str(HERE / 'fetch_sources.py'), 'dem', '--dem-source', bbox_path,
                         '--crs', bbox['crs'], '--tmp', str(tmp), '--out', str(model)))
    if ok and bbox['ept'].get('url'):
        ok = lidar_from_point_cloud(load, py, bbox, bbox_path, model)
        if ok and (model / 'chm-utm-1m.json').exists():
            ok = load.stage('trees', py, str(HERE / 'build_trees.py'), '--chm', str(model / 'chm-utm-1m.json'),
                            '--osm', str(model / 'osm-full.json.gz'), '--out', str(model))
    elif ok and bbox.get('demProvider') in ('nrcan-hrdem', 'linz-1m'):
        # Canada / New Zealand: canopy heights from DSM - DTM instead of a point cloud.
        found = bbox.get('hrdem') or bbox.get('linz') or {}
        if any(i.get('dsm') for i in found.get('items') or []):
            ok = (load.stage('lidar', py, str(HERE / 'fetch_sources.py'), 'chm', '--dem-source', bbox_path,
                             '--dem', str(model / 'dem-utm-1m.json'), '--out', str(model))
                  and load.stage('trees', py, str(HERE / 'build_trees.py'), '--chm', str(model / 'chm-utm-1m.json'),
                                 '--osm', str(model / 'osm-full.json.gz'), '--out', str(model)))
        else:
            load.note('lidar', True, 0, trees='osm', note='no surface model published here: trees from the map')
    elif ok:
        # US bare earth without a point cloud (North Carolina), or Copernicus:
        # terrain is in hand; trees come from the map's woods.
        load.note('lidar', True, 0, trees='osm',
                  note=f"no LiDAR point cloud: terrain from {bbox.get('demProvider')}, trees from the map")
    package = ROOT / 'public' / 'course-geometry' / slug / 'course-v1.json'
    if ok and area_mode:
        config = json.loads(config_path.read_text())
        load.stage('area', py, str(HERE / 'build_area_package.py'), '--model-dir', str(model),
                   '--out', str(ROOT / 'public' / 'course-geometry' / slug / 'course-area-v1.json'),
                   '--course-id', config['courseId'], '--course-name', config['courseName'],
                   '--location', config.get('location') or '', '--slug', slug,
                   *[arg for alias in config.get('gsproAliases') or [] for arg in ('--alias', alias)])
    elif ok and package.exists():
        load.stage('enrich', py, str(HERE / 'build_enriched_package.py'), '--package', str(package),
                   '--model-dir', str(model), '--out', str(package.parent / 'course-v1-lidar.json'))
    # Acceptance: is what was built fit to publish? (validate_package.py; hard
    # failures fail the load, soft ones ride along in the report.)
    built = [p for p in ((ROOT / 'public' / 'course-geometry' / slug).glob('course-*.json')) if p.is_file()] \
        if ok and (ROOT / 'public' / 'course-geometry' / slug).exists() else []
    if ok and built:
        report_path = report_dir / 'validate-report.json'
        load.stage('validate', py, str(HERE / 'validate_package.py'), '--report', str(report_path), *map(str, built))
        if report_path.exists():
            extra['validation'] = json.loads(report_path.read_text())
    for name in ('lidar-stats.json', 'trees-summary.json'):
        if (model / name).exists():
            extra[name.replace('.json', '')] = json.loads((model / name).read_text())
    sizes = {p.name: p.stat().st_size for p in (ROOT / 'public' / 'course-geometry' / slug).glob('*.json')} \
        if (ROOT / 'public' / 'course-geometry' / slug).exists() else {}
    extra['publishedBytes'] = sizes
    return load.finish(request, extra)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--requests', required=True, type=Path, help='JSON list of {name, lat, lon, slug?, location?, nameRegex?}')
    ap.add_argument('--only', nargs='*', default=None)
    args = ap.parse_args()
    requests = json.loads(args.requests.read_text())
    reports = []
    for request in requests:
        if args.only and request.get('slug') not in args.only:
            continue
        if request.get('done'):
            continue
        report = load_one(request)
        reports.append({k: report[k] for k in ('slug', 'ready', 'totalSeconds', 'stages')})
    if not reports:
        return 0
    summary = {'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'runId': os.environ.get('GITHUB_RUN_ID'), 'courses': reports}
    (ROOT / 'artifacts' / 'course-load').mkdir(parents=True, exist_ok=True)
    (ROOT / 'artifacts' / 'course-load' / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
