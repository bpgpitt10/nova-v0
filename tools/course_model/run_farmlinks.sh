#!/usr/bin/env bash
# Run every prototype stage for FarmLinks, logging each one and continuing past
# failures so the committed run-log shows exactly what worked. Results are read
# back from git because the Actions API is not reachable from the review env.
set -u
OUT="${OUT:-artifacts/course-model/farmlinks}"
TMP="${TMP:-.tmp/course-model}"
DEM_SOURCE="${DEM_SOURCE:-artifacts/course-geometry/farmlinks/dem-source-v1.json}"
EPT="${EPT:-https://s3-us-west-2.amazonaws.com/usgs-lidar-public/AL_17Co_2_2020/ept.json}"
COURSE="${COURSE:-public/course-geometry/farmlinks/course-v1.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$OUT" "$TMP"
LOG="$OUT/run-log.txt"
STAGES="$TMP/stages.jsonl"
: > "$LOG"
: > "$STAGES"

stage() {
  local name=$1; shift
  local start end rc
  start=$(date +%s)
  echo "=== [$name] $*" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  rc=$?
  end=$(date +%s)
  echo "=== [$name] rc=$rc seconds=$((end - start))" | tee -a "$LOG"
  printf '{"stage":"%s","rc":%d,"seconds":%d}\n' "$name" "$rc" "$((end - start))" >> "$STAGES"
  return $rc
}

stage osm   python "$HERE/fetch_sources.py" osm --dem-source "$DEM_SOURCE" --out "$OUT"
stage dem   python "$HERE/fetch_sources.py" dem --dem-source "$DEM_SOURCE" --tmp "$TMP" --out "$OUT"
stage lidar-fetch python "$HERE/lidar_pipeline.py" fetch --dem-source "$DEM_SOURCE" --ept "$EPT" --tmp "$TMP" \
  && stage lidar-chm python "$HERE/lidar_pipeline.py" chm --ept "$EPT" --tmp "$TMP" --out "$OUT" \
  && stage trees python "$HERE/build_trees.py" --chm "$OUT/chm-utm16n-1m.json" --osm "$OUT/osm-full.json.gz" --out "$OUT"
stage render python "$HERE/render_preview.py" --dir "$OUT" --course "$COURSE"

python - "$STAGES" "$OUT/run-status.json" <<'PY'
import json, sys, time, os
stages = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
files = {}
out = os.path.dirname(sys.argv[2])
for name in sorted(os.listdir(out)):
    p = os.path.join(out, name)
    if os.path.isfile(p):
        files[name] = os.path.getsize(p)
json.dump({'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'runId': os.environ.get('GITHUB_RUN_ID'), 'commit': os.environ.get('GITHUB_SHA'),
           'stages': stages, 'outputBytes': files,
           'allOk': all(s['rc'] == 0 for s in stages)},
          open(sys.argv[2], 'w'), indent=2)
PY
exit 0
