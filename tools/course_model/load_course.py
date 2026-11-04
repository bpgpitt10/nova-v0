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


STAGES = ('find', 'config', 'import', 'osm', 'dem', 'lidar', 'trees', 'enrich')


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

    if not skip_import and not load.stage('import', py, 'tools/import_course_canonical.py',
                                          '--config', str(config_path.relative_to(ROOT)), '--slug', slug,
                                          '--reason', 'one-click-course-load'):
        return load.finish(request, extra)

    bbox_path = str(model / 'course-bbox.json')
    ok = (load.stage('osm', py, str(HERE / 'fetch_sources.py'), 'osm', '--dem-source', bbox_path, '--out', str(model))
          and load.stage('dem', py, str(HERE / 'fetch_sources.py'), 'dem', '--dem-source', bbox_path,
                         '--crs', bbox['crs'], '--tmp', str(tmp), '--out', str(model)))
    if ok and bbox['ept'].get('url'):
        ok = (load.stage('lidar', py, str(HERE / 'lidar_pipeline.py'), '--ept', bbox['ept']['url'],
                         '--dem-source', bbox_path, '--dem', str(model / 'dem-utm-1m.json'), '--out', str(model))
              and load.stage('trees', py, str(HERE / 'build_trees.py'), '--chm', str(model / 'chm-utm-1m.json'),
                             '--osm', str(model / 'osm-full.json.gz'), '--out', str(model)))
    elif ok and bbox.get('demProvider') == 'nrcan-hrdem':
        # Canada: canopy heights from HRDEM DSM - DTM instead of a point cloud.
        ok = (load.stage('lidar', py, str(HERE / 'fetch_sources.py'), 'chm', '--dem-source', bbox_path,
                         '--dem', str(model / 'dem-utm-1m.json'), '--out', str(model))
              and load.stage('trees', py, str(HERE / 'build_trees.py'), '--chm', str(model / 'chm-utm-1m.json'),
                             '--osm', str(model / 'osm-full.json.gz'), '--out', str(model)))
    elif ok:
        load.note('lidar', False, 0, error=['No USGS LiDAR point cloud covers this course.'])
        ok = False
    package = ROOT / 'public' / 'course-geometry' / slug / 'course-v1.json'
    if ok and package.exists():
        load.stage('enrich', py, str(HERE / 'build_enriched_package.py'), '--package', str(package),
                   '--model-dir', str(model), '--out', str(package.parent / 'course-v1-lidar.json'))
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
