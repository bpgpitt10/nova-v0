#!/usr/bin/env bash
# Build the layered course model for every course in courses.json (or the
# slugs given as arguments). Each stage is logged and failures don't stop the
# run, so the committed per-course run-log shows exactly what worked.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${CONFIG:-$HERE/courses.json}"
TMP_ROOT="${TMP:-.tmp/course-model}"
ONLY="$*"

mkdir -p "$TMP_ROOT"
python - "$CONFIG" "$ONLY" > "$TMP_ROOT.list" <<'PY'
import json, sys
only = set(sys.argv[2].split())
for c in json.load(open(sys.argv[1])):
    if not only or c['slug'] in only:
        print(c['slug'])
PY

field() {  # field SLUG KEY -> value from courses.json ('' if missing)
  python -c "import json,sys;c=[x for x in json.load(open('$CONFIG')) if x['slug']=='$1'][0];print(c.get('$2',''))"
}

run_course() {
  local slug=$1
  local OUT="artifacts/course-model/$slug"
  local TMP="$TMP_ROOT/$slug"
  mkdir -p "$OUT" "$TMP"
  local LOG="$OUT/run-log.txt" STAGES="$TMP/stages.jsonl"
  : > "$LOG"; : > "$STAGES"

  stage() {
    local name=$1; shift
    local start end rc
    start=$(date +%s)
    echo "=== [$slug:$name] $*" | tee -a "$LOG"
    "$@" >> "$LOG" 2>&1
    rc=$?
    end=$(date +%s)
    echo "=== [$slug:$name] rc=$rc seconds=$((end - start))" | tee -a "$LOG"
    printf '{"stage":"%s","rc":%d,"seconds":%d}\n' "$name" "$rc" "$((end - start))" >> "$STAGES"
    return $rc
  }

  local bbox crs ept pkg name
  name=$(field "$slug" name)
  bbox=$(field "$slug" bboxFile)
  crs=$(field "$slug" crs)
  ept=$(field "$slug" ept)
  pkg=$(field "$slug" coursePackage)
  if [ -z "$bbox" ]; then
    stage find python "$HERE/find_course.py" --name-regex "$(field "$slug" nameRegex)" \
      --lat "$(field "$slug" lat)" --lon "$(field "$slug" lon)" --radius-m "$(field "$slug" radiusM)" --out "$OUT"
    bbox="$OUT/course-bbox.json"
    if [ -f "$bbox" ]; then
      crs=$(python -c "import json;print(json.load(open('$bbox'))['crs'])")
      ept=$(python -c "import json;print(json.load(open('$bbox'))['ept']['url'] or '')")
    fi
  fi

  if [ -f "$bbox" ]; then
    stage osm python "$HERE/fetch_sources.py" osm --dem-source "$bbox" --out "$OUT"
    stage dem python "$HERE/fetch_sources.py" dem --dem-source "$bbox" --crs "$crs" --tmp "$TMP" --out "$OUT"
    if [ -n "$ept" ]; then
      stage lidar-chm python "$HERE/lidar_pipeline.py" --ept "$ept" --dem-source "$bbox" \
          --dem "$OUT/dem-utm-1m.json" --out "$OUT" \
        && stage trees python "$HERE/build_trees.py" --chm "$OUT/chm-utm-1m.json" --osm "$OUT/osm-full.json.gz" --out "$OUT"
    else
      echo "=== [$slug] no USGS LiDAR point cloud found for this bbox" | tee -a "$LOG"
    fi
    if [ -n "$pkg" ]; then
      stage render python "$HERE/render_preview.py" --dir "$OUT" --course "$pkg" --title "$name"
    else
      stage render python "$HERE/render_preview.py" --dir "$OUT" --title "$name"
    fi
  fi

  python - "$STAGES" "$OUT/run-status.json" "$slug" <<'PY'
import json, sys, time, os
stages = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
out = os.path.dirname(sys.argv[2])
files = {n: os.path.getsize(os.path.join(out, n)) for n in sorted(os.listdir(out)) if os.path.isfile(os.path.join(out, n))}
json.dump({'course': sys.argv[3], 'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'runId': os.environ.get('GITHUB_RUN_ID'), 'commit': os.environ.get('GITHUB_SHA'),
           'stages': stages, 'outputBytes': files, 'allOk': bool(stages) and all(s['rc'] == 0 for s in stages)},
          open(sys.argv[2], 'w'), indent=2)
PY
}

for slug in $(cat "$TMP_ROOT.list"); do
  run_course "$slug"
done

python - "$TMP_ROOT.list" <<'PY'
import json, os, sys, time
courses = {}
for slug in open(sys.argv[1]).read().split():
    path = f'artifacts/course-model/{slug}/run-status.json'
    status = json.load(open(path)) if os.path.exists(path) else {}
    courses[slug] = {'allOk': status.get('allOk', False),
                     'failed': [s['stage'] for s in status.get('stages', []) if s['rc'] != 0]}
json.dump({'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'runId': os.environ.get('GITHUB_RUN_ID'),
           'courses': courses, 'allOk': all(c['allOk'] for c in courses.values())},
          open('artifacts/course-model/run-summary.json', 'w'), indent=2)
PY
exit 0
