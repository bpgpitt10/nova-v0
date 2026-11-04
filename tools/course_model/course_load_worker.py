#!/usr/bin/env python3
"""Work the one-click course-load queue (Supabase public.course_load_requests).

Run by .github/workflows/course-load-worker.yml on a checkout of the
production branch. For each queued request, oldest first:
  1. mark it running and report every stage as it starts (the Load page
     shows "Loading - stage N of 8");
  2. run load_course.load_one (find -> import -> OSM -> DEM -> LiDAR -> trees
     -> LiDAR package), which fails closed;
  3. on success publish it: upload the package files to the public Supabase
     storage bucket `course-packages` and write its `loaded_courses` row, which
     every Looper app reads at start (no site redeploy), then mark it "ready".
     PUBLISH_MODE=git (or a storage failure) falls back to the old path: commit
     the course to the production branch, wait for thelooper.golf to serve it;
  4. on failure mark it "failed" with the stage and the last log lines.

Needs SUPABASE_SECRET_KEY (a service-role secret key). Without it the worker
logs that and exits successfully, so the schedule stays quiet.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import load_course  # noqa: E402

ROOT = load_course.ROOT
SUPABASE_URL = os.environ.get('SUPABASE_URL') or 'https://kdjfdchzfemjpmaqpobn.supabase.co'
SITE_URL = os.environ.get('LOOPER_SITE_URL') or 'https://thelooper.golf'
PUBLISH_BRANCH = os.environ.get('PUBLISH_BRANCH') or 'web-alpha-mishits'
MAX_PER_RUN = int(os.environ.get('MAX_LOADS_PER_RUN') or 3)
PUBLISH_MODE = (os.environ.get('PUBLISH_MODE') or 'storage').strip().lower()
BUCKET = 'course-packages'
PACKAGE_FILES = ('course-v1.json', 'course-v1-lidar.json', 'green-detail-v1.json')
STOP_WORDS = {'the', 'golf', 'club', 'course', 'country', 'links', 'resort', 'at', 'of', 'and', 'gc', 'cc'}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def rest(method: str, path: str, body: dict | None = None, key: str | None = None):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/{path}',
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'apikey': key, 'Content-Type': 'application/json', 'Prefer': 'return=representation'},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def name_regex(name: str) -> str:
    tokens = [t for t in re.findall(r"[A-Za-z0-9']+", name) if t.lower() not in STOP_WORDS]
    tokens = tokens[:2] or re.findall(r"[A-Za-z0-9']+", name)[:1]
    return '.*'.join(re.escape(t) for t in tokens)


def published(slug: str) -> bool:
    url = f'{SITE_URL}/course-geometry/{slug}/course-v1.json'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=20) as resp:
            return resp.status == 200 and 'json' in (resp.headers.get('content-type') or '')
    except (urllib.error.URLError, TimeoutError):
        return False


def storage_upload(path: str, data: bytes, key: str) -> None:
    """Upload (or replace) one file in the course-packages bucket. Secret keys
    work in the apikey header alone; a legacy service-role JWT also needs it
    as the bearer token, so retry with that on a refusal."""
    url = f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(path)}'
    headers = {'apikey': key, 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'max-age=60'}
    last: Exception | None = None
    for extra in ({}, {'Authorization': f'Bearer {key}'}):
        try:
            req = urllib.request.Request(url, method='POST', data=data, headers={**headers, **extra})
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp.read()
                return
        except urllib.error.HTTPError as error:
            last = RuntimeError(f'storage upload {path}: HTTP {error.code} {error.read()[:200]!r}')
            if error.code not in (400, 401, 403):
                break
    raise last or RuntimeError(f'storage upload {path} failed')


def public_url(path: str) -> str:
    return f'{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}'


def hole_headings(slug: str) -> list | None:
    """Tee-to-green true headings per hole, from the validation manifest."""
    path = ROOT / 'artifacts' / 'course-geometry' / slug / 'validation-v1.json'
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    headings: list = [None] * 18
    for hole in manifest.get('holes') or []:
        try:
            number, heading = int(hole.get('hole')), float(hole.get('headingDegreesTrue'))
        except (TypeError, ValueError):
            continue
        if 1 <= number <= 18:
            headings[number - 1] = round(heading, 2)
    return headings if any(h is not None for h in headings) else None


def publish_to_storage(request: dict, slug: str, key: str) -> None:
    """Upload the package files and write the course's loaded_courses row."""
    receipt = json.loads((ROOT / 'artifacts' / 'course-geometry' / slug / 'runtime-ready-v1.json').read_text())
    if receipt.get('runtimeReady') is not True:
        raise RuntimeError('the runtime-ready receipt is not ready')
    folder = ROOT / 'public' / 'course-geometry' / slug
    for name in PACKAGE_FILES:
        if (folder / name).exists():
            storage_upload(f'{slug}/{name}', (folder / name).read_bytes(), key)
    if not (folder / 'course-v1.json').exists():
        raise RuntimeError('course-v1.json was not built')
    aliases = [str(a).strip() for a in receipt.get('gsproAliases') or [] if str(a).strip()]
    row = {
        'slug': slug,
        'course_id': receipt['courseId'],
        'name': receipt.get('courseName') or request['course_name'],
        'location': receipt.get('location') or request.get('location') or '',
        'gspro_aliases': list(dict.fromkeys(aliases)),
        'package_url': public_url(f'{slug}/course-v1.json'),
        'lidar': lidar_trees(folder / 'course-v1-lidar.json'),
        'hole_headings': hole_headings(slug),
        'osm_type': request.get('osm_type'),
        'osm_id': request.get('osm_id'),
        'request_id': request.get('id'),
        'published_at': now(),
    }
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/loaded_courses?on_conflict=slug', method='POST', data=json.dumps(row).encode(),
        headers={'apikey': key, 'Content-Type': 'application/json',
                 'Prefer': 'resolution=merge-duplicates,return=minimal'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def lidar_trees(path: Path) -> bool:
    """Enriched with LiDAR tree canopy (not just the map's woods)."""
    if not path.exists():
        return False
    try:
        return (json.loads(path.read_text()).get('enrichment') or {}).get('trees', 'lidar') == 'lidar'
    except ValueError:
        return False


def publish_area_to_storage(request: dict, slug: str, key: str) -> None:
    """Upload the course-area package and write its loaded_course_areas row."""
    path = ROOT / 'public' / 'course-geometry' / slug / 'course-area-v1.json'
    if not path.exists():
        raise RuntimeError('course-area-v1.json was not built')
    pkg = json.loads(path.read_text())
    storage_upload(f'{slug}/course-area-v1.json', path.read_bytes(), key)
    aliases = [str(a).strip() for a in pkg.get('gsproAliases') or [] if str(a).strip()]
    if request.get('gspro_course_key'):
        aliases.append(request['gspro_course_key'])
    row = {
        'slug': slug,
        'course_id': pkg['courseId'],
        'name': pkg.get('courseName') or request['course_name'],
        'location': pkg.get('location') or request.get('location') or '',
        'gspro_aliases': list(dict.fromkeys(aliases)),
        'package_url': public_url(f'{slug}/course-area-v1.json'),
        'lidar': bool(pkg.get('enrichment')),
        'greens': len((pkg.get('area') or {}).get('greens') or []),
        'osm_type': request.get('osm_type'),
        'osm_id': request.get('osm_id'),
        'request_id': request.get('id'),
        'published_at': now(),
    }
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/loaded_course_areas?on_conflict=slug', method='POST', data=json.dumps(row).encode(),
        headers={'apikey': key, 'Content-Type': 'application/json',
                 'Prefer': 'resolution=merge-duplicates,return=minimal'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def loaded_row_exists(slug: str, key: str) -> bool:
    try:
        q = urllib.parse.quote(slug)
        return bool(rest('GET', f'loaded_courses?slug=eq.{q}&select=slug', key=key)) \
            or bool(rest('GET', f'loaded_course_areas?slug=eq.{q}&select=slug', key=key))
    except Exception:
        return False


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True)


def commit_course(slug: str, name: str) -> None:
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    paths = [f'public/course-geometry/{slug}', f'config/course-geometry/{slug}-v1.json',
             f'artifacts/course-geometry/{slug}', f'artifacts/course-load/{slug}', 'src/courseGeometry']
    git('add', '-A', *[p for p in paths if (ROOT / p).exists()])
    if git('diff', '--cached', '--quiet').returncode == 0:
        return
    msg = f'data(course-load): load {name} ({slug}) via one-click loader\n\nRun {os.environ.get("GITHUB_RUN_ID")}.'
    if git('commit', '-m', msg).returncode != 0:
        raise RuntimeError('git commit failed')
    for _ in range(3):
        if git('pull', '--rebase', 'origin', PUBLISH_BRANCH).returncode == 0 \
                and git('push', 'origin', f'HEAD:{PUBLISH_BRANCH}').returncode == 0:
            return
        time.sleep(10)
    raise RuntimeError('git push to the production branch failed')


def readable_reason(lines: list[str], limit: int = 400) -> str:
    """The line that says what went wrong, from its start (the page used to
    show the tail end of a long ValueError, cut mid-way)."""
    clean = [line.strip() for line in lines if line and line.strip()]
    for line in reversed(clean):
        if re.search(r"(\b\w*(Error|Exception)\b: |\bfailed\b)", line):
            return line if len(line) <= limit else line[: limit - 1] + '…'
    tail = ' | '.join(clean[-2:])
    return tail if len(tail) <= limit else '…' + tail[-(limit - 1):]


def work(request: dict, key: str) -> None:
    rid = request['id']
    patch = lambda **fields: rest('PATCH', f'course_load_requests?id=eq.{rid}', fields, key)  # noqa: E731
    slug = request.get('slug') or load_course.slugify(request['course_name'])
    if ((ROOT / 'public' / 'course-geometry' / slug / 'course-v1-lidar.json').exists() and published(slug)) \
            or loaded_row_exists(slug, key):
        patch(status='ready', slug=slug, finished_at=now(), stage=None,
              report={'note': 'already loaded'})
        return
    patch(status='running', slug=slug, started_at=now(), stage='find', stage_index=1,
          stage_count=len(load_course.STAGES))
    job = {
        'slug': slug,
        'name': request['course_name'],
        'location': request.get('location') or '',
        'lat': request['lat'],
        'lon': request['lon'],
        'nameRegex': name_regex(request['course_name']),
        'osmId': request.get('osm_id'),
        'gsproAliases': [request['gspro_course_key']] if request.get('gspro_course_key') else [],
    }
    report = load_course.load_one(
        job, on_stage=lambda name, index, count: patch(stage=name, stage_index=index, stage_count=count))
    summary = {k: report.get(k) for k in ('ready', 'totalSeconds', 'stages', 'osmCourse', 'lidar', 'publishedBytes', 'mode')}
    if not report['ready']:
        failed = next((s for s in report['stages'] if not s['ok']), {})
        tail = readable_reason(failed.get('error') or [])
        patch(status='failed', finished_at=now(), report=summary,
              error=f"{failed.get('stage', 'load')} failed: {tail or 'see run log'}")
        return
    patch(status='publishing', stage='publish', report=summary)
    if report.get('mode') == 'area':
        # A whole-area package: storage only (the site's code has no place for it).
        publish_area_to_storage(request, slug, key)
        patch(status='ready', stage=None, finished_at=now())
        print(f'published {slug} (course area) to storage', flush=True)
        return
    if PUBLISH_MODE != 'git':
        try:
            publish_to_storage(request, slug, key)
            patch(status='ready', stage=None, finished_at=now())
            print(f'published {slug} to storage', flush=True)
            return
        except Exception as error:  # fall back to committing it
            print(f'storage publish failed ({error}); committing instead', flush=True)
    commit_course(slug, request['course_name'])
    deadline = time.time() + 15 * 60
    while time.time() < deadline and not published(slug):
        time.sleep(30)
    if published(slug):
        patch(status='ready', stage=None, finished_at=now())
    else:
        patch(status='failed', finished_at=now(),
              error='Loaded and committed, but thelooper.golf did not serve it within 15 minutes (check the Vercel deploy).')


def main() -> int:
    key = os.environ.get('SUPABASE_SECRET_KEY')
    if not key:
        print('SUPABASE_SECRET_KEY is not set; nothing to do.')
        return 0
    queued = rest('GET', 'course_load_requests?status=eq.queued&order=created_at.asc&limit='
                  + str(MAX_PER_RUN), key=key) or []
    print(f'{len(queued)} queued course load(s)')
    for request in queued:
        print(f"loading {request['course_name']} ({request['id']})", flush=True)
        try:
            work(request, key)
        except Exception as error:  # report, then continue with the next request
            try:
                rest('PATCH', f"course_load_requests?id=eq.{request['id']}",
                     {'status': 'failed', 'finished_at': now(), 'error': f'loader error: {error}'[:600]}, key)
            except Exception:
                pass
            print(f'failed: {error}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
