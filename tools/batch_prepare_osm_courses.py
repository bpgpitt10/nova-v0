#!/usr/bin/env python3
"""Discover, prepare, and time a batch of Looper OSM courses.

This is an offline/admin ingestion tool, not a browser/runtime dependency. For a
course without a build config it resolves the golf-course OSM object through a
replaceable Nominatim endpoint, persists that decision, generates the canonical
build config, then invokes the same timed importer used by existing courses.

Every seed produces an append-only prepare timing row, including discovery
failures, so first-use latency can be optimized from evidence later.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

NOMINATIM_ENDPOINT = os.environ.get(
    "LOOPER_NOMINATIM_ENDPOINT",
    "https://nominatim.openstreetmap.org/search",
)
NOMINATIM_MIN_INTERVAL_SECONDS = 1.1
NOMINATIM_TIMEOUT_SECONDS = 30
USER_AGENT = "LooperCourseDiscovery/0.1 (+https://github.com/bpgpitt10/nova-v0)"

DEFAULT_SELECTION = {
    "teeStartRadiusYards": 220,
    "contextRouteDistanceYards": 110,
    "behindTeeToleranceYards": 35,
    "pastGreenToleranceYards": 50,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-file", required=True, type=Path)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser.parse_args()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 1)


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower().replace("&", "and")).strip()


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def append_ndjson(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True, separators=(",", ":")))
        handle.write("\n")


def read_last_ndjson(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    for line in reversed(path.read_text(encoding="utf-8").splitlines()):
        if line.strip():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                return None
            return payload if isinstance(payload, dict) else None
    return None


def load_seeds(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != "looper-course-import-seeds-v1":
        raise SystemExit(f"{path}: unsupported seed schema")
    courses = payload.get("courses")
    if not isinstance(courses, list) or not courses:
        raise SystemExit(f"{path}: courses must be a non-empty array")
    required = ("courseId", "courseName", "location", "slug")
    for seed in courses:
        if not isinstance(seed, dict) or any(not seed.get(key) for key in required):
            raise SystemExit(f"{path}: every seed requires {', '.join(required)}")
    return courses


def candidate_name(candidate: dict[str, Any]) -> str:
    details = candidate.get("namedetails")
    if isinstance(details, dict):
        for key in ("name", "name:en", "official_name", "short_name"):
            value = details.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    display = candidate.get("display_name")
    if isinstance(display, str) and display.strip():
        return display.split(",", 1)[0].strip()
    return ""


def score_candidate(seed: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    osm_type = candidate.get("osm_type")
    if osm_type not in {"way", "relation"}:
        return None
    category = candidate.get("category") or candidate.get("class")
    place_type = candidate.get("type")
    if category != "leisure" or place_type != "golf_course":
        return None

    wanted_name = normalize(str(seed["courseName"]))
    found_name = normalize(candidate_name(candidate))
    display = normalize(str(candidate.get("display_name") or ""))
    if not found_name:
        return None

    name_ratio = difflib.SequenceMatcher(None, wanted_name, found_name).ratio()
    wanted_location_tokens = {
        token
        for token in normalize(str(seed["location"])).split()
        if len(token) >= 2
    }
    display_tokens = set(display.split())
    location_overlap = (
        len(wanted_location_tokens & display_tokens) / len(wanted_location_tokens)
        if wanted_location_tokens
        else 0.0
    )
    containment_bonus = 10.0 if wanted_name in display or found_name in wanted_name else 0.0
    importance = candidate.get("importance")
    importance_value = float(importance) if isinstance(importance, (int, float)) else 0.0
    score = round(name_ratio * 100.0 + location_overlap * 20.0 + containment_bonus + importance_value * 5.0, 3)

    return {
        "score": score,
        "nameRatio": round(name_ratio, 4),
        "locationOverlap": round(location_overlap, 4),
        "osmType": osm_type,
        "osmId": candidate.get("osm_id"),
        "lat": candidate.get("lat"),
        "lon": candidate.get("lon"),
        "name": candidate_name(candidate),
        "displayName": candidate.get("display_name"),
    }


def fetch_discovery_candidates(seed: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    query = f"{seed['courseName']}, {seed['location']}"
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": "10",
        "addressdetails": "1",
        "namedetails": "1",
        "extratags": "1",
    }
    country_code = seed.get("countryCode")
    if isinstance(country_code, str) and country_code.strip():
        params["countrycodes"] = country_code.strip().lower()
    url = f"{NOMINATIM_ENDPOINT}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en",
        },
    )
    with urllib.request.urlopen(request, timeout=NOMINATIM_TIMEOUT_SECONDS) as response:
        payload = json.load(response)
    if not isinstance(payload, list):
        raise RuntimeError("Nominatim returned a non-array payload")
    return query, [candidate for candidate in payload if isinstance(candidate, dict)]


def choose_candidate(seed: dict[str, Any], raw_candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    scored = [
        scored_candidate
        for candidate in raw_candidates
        if (scored_candidate := score_candidate(seed, candidate)) is not None
    ]
    scored.sort(key=lambda item: item["score"], reverse=True)
    if not scored:
        return None, scored, "no way/relation leisure=golf_course candidates"

    top = scored[0]
    if top["nameRatio"] < 0.45:
        return None, scored, f"top candidate name similarity too low: {top['nameRatio']}"

    if len(scored) > 1:
        runner_up = scored[1]
        if top["score"] - runner_up["score"] < 4.0 and runner_up["nameRatio"] >= 0.55:
            return None, scored, "top OSM course candidates are too close to choose automatically"

    if not isinstance(top.get("osmId"), int):
        return None, scored, "top candidate has no integer OSM id"
    try:
        float(top["lat"])
        float(top["lon"])
    except (TypeError, ValueError):
        return None, scored, "top candidate has no usable center coordinates"
    return top, scored, None


def config_from_choice(seed: dict[str, Any], choice: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": "looper-course-build-config-v1",
        "courseId": seed["courseId"],
        "courseName": seed["courseName"],
        "location": seed["location"],
        "slug": seed["slug"],
        "osmCourseElement": {
            "type": choice["osmType"],
            "id": int(choice["osmId"]),
        },
        "osmCenter": [float(choice["lat"]), float(choice["lon"])],
        "selection": dict(DEFAULT_SELECTION),
    }


def discover_or_reuse(
    seed: dict[str, Any],
    *,
    repo_root: Path,
    config_path: Path,
    discovery_path: Path,
    request_gate: dict[str, float],
) -> tuple[bool, float, str | None]:
    if config_path.exists():
        return False, 0.0, None

    cached = load_json(discovery_path)
    if cached and cached.get("success") is True and isinstance(cached.get("chosen"), dict):
        config = config_from_choice(seed, cached["chosen"])
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        return False, 0.0, None

    since_last = time.perf_counter() - request_gate.get("lastRequestAt", 0.0)
    if since_last < NOMINATIM_MIN_INTERVAL_SECONDS:
        time.sleep(NOMINATIM_MIN_INTERVAL_SECONDS - since_last)

    started = time.perf_counter()
    requested_at = iso_now()
    query: str | None = None
    scored: list[dict[str, Any]] = []
    try:
        request_gate["lastRequestAt"] = time.perf_counter()
        query, raw_candidates = fetch_discovery_candidates(seed)
        choice, scored, error = choose_candidate(seed, raw_candidates)
        discovery_ms = elapsed_ms(started)
        discovery = {
            "schemaVersion": "looper-course-discovery-v1",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "location": seed["location"],
            "provider": "nominatim",
            "providerEndpoint": NOMINATIM_ENDPOINT,
            "query": query,
            "requestedAt": requested_at,
            "completedAt": iso_now(),
            "timingMs": discovery_ms,
            "success": error is None and choice is not None,
            "chosen": choice,
            "candidates": scored[:5],
            "error": error,
        }
        discovery_path.parent.mkdir(parents=True, exist_ok=True)
        discovery_path.write_text(json.dumps(discovery, indent=2, sort_keys=True), encoding="utf-8")
        if error or choice is None:
            return True, discovery_ms, error or "no candidate chosen"
        config = config_from_choice(seed, choice)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        return True, discovery_ms, None
    except Exception as exc:
        discovery_ms = elapsed_ms(started)
        error = f"{type(exc).__name__}: {exc}"
        discovery = {
            "schemaVersion": "looper-course-discovery-v1",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "location": seed["location"],
            "provider": "nominatim",
            "providerEndpoint": NOMINATIM_ENDPOINT,
            "query": query,
            "requestedAt": requested_at,
            "completedAt": iso_now(),
            "timingMs": discovery_ms,
            "success": False,
            "chosen": None,
            "candidates": scored[:5],
            "error": error,
        }
        discovery_path.parent.mkdir(parents=True, exist_ok=True)
        discovery_path.write_text(json.dumps(discovery, indent=2, sort_keys=True), encoding="utf-8")
        return True, discovery_ms, error


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    seed_file = args.seed_file.resolve()
    seeds = load_seeds(seed_file)
    request_gate: dict[str, float] = {"lastRequestAt": 0.0}
    batch_started = iso_now()
    rows: list[dict[str, Any]] = []

    for seed in seeds:
        prep_started_at = iso_now()
        prep_start = time.perf_counter()
        slug = str(seed["slug"])
        artifact_dir = repo_root / "artifacts" / "course-geometry" / slug
        config_path = repo_root / "config" / "course-geometry" / f"{slug}-v1.json"
        discovery_path = artifact_dir / "discovery-v1.json"
        prepare_timing_path = artifact_dir / "prepare-timings.ndjson"
        import_timing_path = artifact_dir / "import-timings.ndjson"

        discovery_used_network, discovery_ms, discovery_error = discover_or_reuse(
            seed,
            repo_root=repo_root,
            config_path=config_path,
            discovery_path=discovery_path,
            request_gate=request_gate,
        )

        import_return_code: int | None = None
        import_timing: dict[str, Any] | None = None
        error: str | None = discovery_error
        if discovery_error is None and config_path.exists():
            completed = subprocess.run(
                [
                    sys.executable,
                    str(repo_root / "tools" / "timed_import_osm_course.py"),
                    "--config",
                    str(config_path),
                ],
                cwd=repo_root,
                check=False,
            )
            import_return_code = completed.returncode
            import_timing = read_last_ndjson(import_timing_path)
            if completed.returncode != 0:
                error = f"timed_import_osm_course.py exited {completed.returncode}"

        success = discovery_error is None and import_return_code == 0
        row = {
            "schemaVersion": "looper-course-prepare-timing-v1",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "slug": slug,
            "startedAt": prep_started_at,
            "endedAt": iso_now(),
            "success": success,
            "discovery": {
                "usedNetwork": discovery_used_network,
                "timingMs": discovery_ms,
                "error": discovery_error,
            },
            "import": import_timing,
            "timingMs": {
                "discovery": discovery_ms,
                "sourceFetch": ((import_timing or {}).get("timingMs") or {}).get("sourceFetch"),
                "packageImporter": ((import_timing or {}).get("timingMs") or {}).get("importer"),
                "topologyAudit": ((import_timing or {}).get("timingMs") or {}).get("topologyAudit"),
                "total": elapsed_ms(prep_start),
            },
            "error": error,
        }
        append_ndjson(prepare_timing_path, row)
        rows.append(row)
        print(json.dumps({
            "courseId": row["courseId"],
            "success": success,
            "timingMs": row["timingMs"],
            "error": error,
        }, indent=2))

    failures = [row["courseId"] for row in rows if not row["success"]]
    summary = {
        "schemaVersion": "looper-course-batch-prepare-v1",
        "seedFile": str(seed_file.relative_to(repo_root)),
        "startedAt": batch_started,
        "endedAt": iso_now(),
        "courseCount": len(rows),
        "successCount": len(rows) - len(failures),
        "failureCount": len(failures),
        "failedCourseIds": failures,
        "courses": [
            {
                "courseId": row["courseId"],
                "slug": row["slug"],
                "success": row["success"],
                "timingMs": row["timingMs"],
                "error": row["error"],
            }
            for row in rows
        ],
    }
    summary_path = repo_root / "artifacts" / "course-geometry" / "batch-planned-courses-v1.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(summary, indent=2))

    # Persist the entire acceptance run before the workflow decides whether a
    # failure should make the job red. This lets failures remain diagnosable.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
