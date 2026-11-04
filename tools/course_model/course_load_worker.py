#!/usr/bin/env python3
"""Work the one-click course-load queue (Supabase public.course_load_requests).

Run by .github/workflows/course-load-worker.yml on a checkout of the
production branch. For each queued request, oldest first:
  1. mark it running and report every stage as it starts (the Load page
     shows "Loading - stage N of 8");
  2. run load_course.load_one (find -> import -> OSM -> DEM -> LiDAR -> trees
     -> LiDAR package), which fails closed;
  3. on success commit the course to the production branch (Vercel deploys
     it), mark it "publishing", wait until thelooper.golf serves the package,
     then mark it "ready";
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
    if (ROOT / 'public' / 'course-geometry' / slug / 'course-v1-lidar.json').exists() and published(slug):
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
    summary = {k: report.get(k) for k in ('ready', 'totalSeconds', 'stages', 'osmCourse', 'lidar', 'publishedBytes')}
    if not report['ready']:
        failed = next((s for s in report['stages'] if not s['ok']), {})
        tail = readable_reason(failed.get('error') or [])
        patch(status='failed', finished_at=now(), report=summary,
              error=f"{failed.get('stage', 'load')} failed: {tail or 'see run log'}")
        return
    patch(status='publishing', stage='publish', report=summary)
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
