#!/usr/bin/env python3
"""Discover, prepare, and time a batch of Looper OSM courses.

This is an offline/admin ingestion tool, not a browser/runtime dependency. For a
course without a build config it first tries direct Nominatim golf-course
resolution. If that cannot identify a way/relation boundary, it resolves a
name/location anchor and searches nearby OSM leisure=golf_course boundaries
through the same raced Overpass provider used by the canonical importer.

Every seed produces append-only preparation timing, including failures, so
first-use latency and failure classes can be optimized from evidence later.
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
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fetch_osm_course_snapshot import SourceFetchError, fetch_overpass_query

NOMINATIM_ENDPOINT = os.environ.get(
    "LOOPER_NOMINATIM_ENDPOINT",
    "https://nominatim.openstreetmap.org/search",
)
NOMINATIM_MIN_INTERVAL_SECONDS = 1.1
NOMINATIM_TIMEOUT_SECONDS = 30
NOMINATIM_TRANSIENT_RETRY_SECONDS = 2.5
OVERPASS_BATCH_MIN_INTERVAL_SECONDS = 6.0
NEARBY_COURSE_RADIUS_METERS = 5000
USER_AGENT = "LooperCourseDiscovery/0.3 (+https://github.com/bpgpitt10/nova-v0)"

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


def summarize_raw_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "osmType": candidate.get("osm_type"),
        "osmId": candidate.get("osm_id"),
        "name": candidate_name(candidate),
        "displayName": candidate.get("display_name"),
        "category": candidate.get("category") or candidate.get("class"),
        "type": candidate.get("type"),
        "lat": candidate.get("lat"),
        "lon": candidate.get("lon"),
        "importance": candidate.get("importance"),
    }


def location_overlap(seed: dict[str, Any], display: str) -> float:
    wanted_tokens = {
        token
        for token in normalize(str(seed["location"])).split()
        if len(token) >= 2
    }
    if not wanted_tokens:
        return 0.0
    return len(wanted_tokens & set(normalize(display).split())) / len(wanted_tokens)


def score_named_candidate(
    seed: dict[str, Any],
    *,
    found_name: str,
    display_name: str,
    importance: float = 0.0,
    golf_primary: bool = False,
) -> tuple[float, float, float]:
    wanted_name = normalize(str(seed["courseName"]))
    found = normalize(found_name)
    display = normalize(display_name)
    if not found:
        return 0.0, 0.0, 0.0
    name_ratio = difflib.SequenceMatcher(None, wanted_name, found).ratio()
    overlap = location_overlap(seed, display_name)
    containment_bonus = 10.0 if wanted_name in display or found in wanted_name else 0.0
    primary_bonus = 5.0 if golf_primary else 0.0
    score = round(
        name_ratio * 100.0
        + overlap * 20.0
        + containment_bonus
        + primary_bonus
        + importance * 5.0,
        3,
    )
    return score, name_ratio, overlap


def score_direct_candidate(seed: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    osm_type = candidate.get("osm_type")
    if osm_type not in {"way", "relation"}:
        return None
    found_name = candidate_name(candidate)
    category = candidate.get("category") or candidate.get("class")
    place_type = candidate.get("type")
    importance = candidate.get("importance")
    importance_value = float(importance) if isinstance(importance, (int, float)) else 0.0
    score, name_ratio, overlap = score_named_candidate(
        seed,
        found_name=found_name,
        display_name=str(candidate.get("display_name") or ""),
        importance=importance_value,
        golf_primary=category == "leisure" and place_type == "golf_course",
    )
    if not found_name:
        return None
    return {
        "score": score,
        "nameRatio": round(name_ratio, 4),
        "locationOverlap": round(overlap, 4),
        "primaryCategory": category,
        "primaryType": place_type,
        "osmType": osm_type,
        "osmId": candidate.get("osm_id"),
        "lat": candidate.get("lat"),
        "lon": candidate.get("lon"),
        "name": found_name,
        "displayName": candidate.get("display_name"),
        "discoveryMethod": "nominatim-direct-golf-category",
    }


def choose_scored_candidate(
    scored: list[dict[str, Any]],
    *,
    minimum_name_ratio: float,
) -> tuple[dict[str, Any] | None, str | None]:
    scored.sort(key=lambda item: item["score"], reverse=True)
    if not scored:
        return None, "no candidate"
    top = scored[0]
    if float(top.get("nameRatio") or 0.0) < minimum_name_ratio:
        return None, f"top candidate name similarity too low: {top.get('nameRatio')}"
    if len(scored) > 1:
        runner_up = scored[1]
        if top["score"] - runner_up["score"] < 4.0 and float(runner_up.get("nameRatio") or 0.0) >= 0.55:
            return None, "top OSM course candidates are too close to choose automatically"
    if not isinstance(top.get("osmId"), int):
        return None, "top candidate has no integer OSM id"
    try:
        float(top["lat"])
        float(top["lon"])
    except (TypeError, ValueError):
        return None, "top candidate has no usable center coordinates"
    return top, None


def pace_nominatim(request_gate: dict[str, float]) -> float:
    since_last = time.perf_counter() - request_gate.get("lastRequestAt", 0.0)
    wait_seconds = max(0.0, NOMINATIM_MIN_INTERVAL_SECONDS - since_last)
    if wait_seconds > 0:
        time.sleep(wait_seconds)
    request_gate["lastRequestAt"] = time.perf_counter()
    return wait_seconds


def request_nominatim(
    seed: dict[str, Any],
    *,
    request_gate: dict[str, float],
    include_golf_category: bool,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    query = f"{seed['courseName']}, {seed['location']}"
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": "20",
        "addressdetails": "1",
        "namedetails": "1",
        "extratags": "1",
    }
    if include_golf_category:
        params["include"] = "osm.leisure.golf_course"
    country_code = seed.get("countryCode")
    if isinstance(country_code, str) and country_code.strip():
        params["countrycodes"] = country_code.strip().lower()
    url = f"{NOMINATIM_ENDPOINT}?{urllib.parse.urlencode(params)}"
    attempts: list[dict[str, Any]] = []

    for attempt_number in range(2):
        pace_nominatim(request_gate)
        started = time.perf_counter()
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Accept-Language": "en",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=NOMINATIM_TIMEOUT_SECONDS) as response:
                payload = json.load(response)
            if not isinstance(payload, list):
                raise RuntimeError("Nominatim returned a non-array payload")
            attempts.append({
                "attempt": attempt_number + 1,
                "success": True,
                "durationMs": elapsed_ms(started),
                "status": 200,
                "error": None,
            })
            return query, [candidate for candidate in payload if isinstance(candidate, dict)], attempts
        except urllib.error.HTTPError as exc:
            attempts.append({
                "attempt": attempt_number + 1,
                "success": False,
                "durationMs": elapsed_ms(started),
                "status": exc.code,
                "error": f"HTTPError: {exc}",
            })
            if attempt_number == 0 and exc.code in {429, 502, 503, 504}:
                time.sleep(NOMINATIM_TRANSIENT_RETRY_SECONDS)
                continue
            raise

    raise RuntimeError("Nominatim retry loop exhausted")


def choose_direct_candidate(
    seed: dict[str, Any],
    raw_candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    scored = [
        item
        for candidate in raw_candidates
        if (item := score_direct_candidate(seed, candidate)) is not None
    ]
    choice, error = choose_scored_candidate(scored, minimum_name_ratio=0.45)
    if not scored:
        error = "no way/relation golf-course candidates after category-filtered search"
    return choice, scored, error


def score_anchor_candidate(seed: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    if candidate.get("osm_type") not in {"node", "way", "relation"}:
        return None
    found_name = candidate_name(candidate)
    if not found_name:
        return None
    importance = candidate.get("importance")
    importance_value = float(importance) if isinstance(importance, (int, float)) else 0.0
    score, name_ratio, overlap = score_named_candidate(
        seed,
        found_name=found_name,
        display_name=str(candidate.get("display_name") or ""),
        importance=importance_value,
    )
    try:
        lat = float(candidate.get("lat"))
        lon = float(candidate.get("lon"))
    except (TypeError, ValueError):
        return None
    return {
        "score": score,
        "nameRatio": round(name_ratio, 4),
        "locationOverlap": round(overlap, 4),
        "osmType": candidate.get("osm_type"),
        "osmId": candidate.get("osm_id"),
        "lat": lat,
        "lon": lon,
        "name": found_name,
        "displayName": candidate.get("display_name"),
        "primaryCategory": candidate.get("category") or candidate.get("class"),
        "primaryType": candidate.get("type"),
    }


def choose_anchor(seed: dict[str, Any], raw_candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    scored = [
        item
        for candidate in raw_candidates
        if (item := score_anchor_candidate(seed, candidate)) is not None
    ]
    scored.sort(key=lambda item: item["score"], reverse=True)
    if not scored:
        return None, scored, "unfiltered Nominatim search returned no usable anchor"
    top = scored[0]
    if float(top.get("nameRatio") or 0.0) < 0.35:
        return None, scored, f"anchor name similarity too low: {top.get('nameRatio')}"
    return top, scored, None


def pace_overpass(overpass_gate: dict[str, float]) -> float:
    since_last = time.perf_counter() - overpass_gate.get("lastRequestStartedAt", 0.0)
    wait_seconds = max(0.0, OVERPASS_BATCH_MIN_INTERVAL_SECONDS - since_last)
    if wait_seconds > 0:
        time.sleep(wait_seconds)
    overpass_gate["lastRequestStartedAt"] = time.perf_counter()
    return round(wait_seconds * 1000.0, 1)


def nearby_golf_query(lat: float, lon: float) -> str:
    return f"""[out:json][timeout:45];
(
  way(around:{NEARBY_COURSE_RADIUS_METERS},{lat},{lon})[\"leisure\"=\"golf_course\"];
  rel(around:{NEARBY_COURSE_RADIUS_METERS},{lat},{lon})[\"leisure\"=\"golf_course\"];
);
out tags center;
"""


def validate_nearby_payload(payload: dict[str, Any]) -> None:
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise ValueError("nearby golf-course query returned no elements array")


def overpass_element_center(element: dict[str, Any], anchor: dict[str, Any]) -> tuple[float, float]:
    center = element.get("center")
    if isinstance(center, dict):
        try:
            return float(center["lat"]), float(center["lon"])
        except (KeyError, TypeError, ValueError):
            pass
    return float(anchor["lat"]), float(anchor["lon"])


def score_nearby_boundary(
    seed: dict[str, Any],
    element: dict[str, Any],
    anchor: dict[str, Any],
) -> dict[str, Any] | None:
    element_type = element.get("type")
    if element_type not in {"way", "relation"} or not isinstance(element.get("id"), int):
        return None
    tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
    found_name = ""
    for key in ("name", "name:en", "official_name", "short_name"):
        value = tags.get(key)
        if isinstance(value, str) and value.strip():
            found_name = value.strip()
            break
    if not found_name:
        return None
    score, name_ratio, _overlap = score_named_candidate(
        seed,
        found_name=found_name,
        display_name=found_name,
        golf_primary=True,
    )
    lat, lon = overpass_element_center(element, anchor)
    return {
        "score": score,
        "nameRatio": round(name_ratio, 4),
        "locationOverlap": 1.0,
        "osmType": element_type,
        "osmId": element["id"],
        "lat": lat,
        "lon": lon,
        "name": found_name,
        "displayName": found_name,
        "discoveryMethod": "nominatim-anchor-nearby-overpass-boundary",
    }


def choose_nearby_boundary(
    seed: dict[str, Any],
    payload: dict[str, Any],
    anchor: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    elements = payload.get("elements") if isinstance(payload.get("elements"), list) else []
    scored = [
        item
        for element in elements
        if isinstance(element, dict)
        if (item := score_nearby_boundary(seed, element, anchor)) is not None
    ]
    choice, error = choose_scored_candidate(scored, minimum_name_ratio=0.35)
    if not scored:
        error = "nearby Overpass search found no named golf-course way/relation"
    return choice, scored, error


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
    config_path: Path,
    discovery_path: Path,
    request_gate: dict[str, float],
    overpass_gate: dict[str, float],
) -> tuple[bool, float, float, str | None]:
    if config_path.exists():
        return False, 0.0, 0.0, None

    cached = load_json(discovery_path)
    if cached and cached.get("success") is True and isinstance(cached.get("chosen"), dict):
        config = config_from_choice(seed, cached["chosen"])
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        return False, 0.0, 0.0, None

    started = time.perf_counter()
    requested_at = iso_now()
    direct_query: str | None = None
    direct_raw: list[dict[str, Any]] = []
    direct_scored: list[dict[str, Any]] = []
    direct_attempts: list[dict[str, Any]] = []
    anchor_query: str | None = None
    anchor_raw: list[dict[str, Any]] = []
    anchor_scored: list[dict[str, Any]] = []
    anchor_attempts: list[dict[str, Any]] = []
    nearby_scored: list[dict[str, Any]] = []
    nearby_attempts: list[dict[str, Any]] = []
    nearby_endpoint: str | None = None
    overpass_throttle_ms = 0.0
    choice: dict[str, Any] | None = None
    error: str | None = None
    direct_error: str | None = None

    try:
        try:
            direct_query, direct_raw, direct_attempts = request_nominatim(
                seed,
                request_gate=request_gate,
                include_golf_category=True,
            )
            choice, direct_scored, direct_error = choose_direct_candidate(seed, direct_raw)
        except Exception as exc:
            direct_error = f"{type(exc).__name__}: {exc}"

        if choice is None:
            anchor_query, anchor_raw, anchor_attempts = request_nominatim(
                seed,
                request_gate=request_gate,
                include_golf_category=False,
            )
            anchor, anchor_scored, anchor_error = choose_anchor(seed, anchor_raw)
            if anchor is None:
                error = anchor_error or direct_error or "course discovery failed"
            else:
                overpass_throttle_ms = pace_overpass(overpass_gate)
                try:
                    raced = fetch_overpass_query(
                        nearby_golf_query(float(anchor["lat"]), float(anchor["lon"])),
                        validator=validate_nearby_payload,
                    )
                    nearby_attempts = raced["attempts"]
                    nearby_endpoint = raced["endpoint"]
                    choice, nearby_scored, nearby_error = choose_nearby_boundary(
                        seed,
                        raced["payload"],
                        anchor,
                    )
                    if choice is None:
                        error = nearby_error or direct_error or "nearby boundary discovery failed"
                except SourceFetchError as exc:
                    nearby_attempts = exc.attempts
                    error = f"nearby Overpass discovery failed: {exc}"

        if choice is not None:
            error = None
            config = config_from_choice(seed, choice)
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

        discovery_ms = elapsed_ms(started)
        discovery = {
            "schemaVersion": "looper-course-discovery-v2",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "location": seed["location"],
            "requestedAt": requested_at,
            "completedAt": iso_now(),
            "timingMs": discovery_ms,
            "success": choice is not None,
            "chosen": choice,
            "direct": {
                "provider": "nominatim",
                "providerEndpoint": NOMINATIM_ENDPOINT,
                "query": direct_query,
                "categoryFilter": "osm.leisure.golf_course",
                "attempts": direct_attempts,
                "candidates": direct_scored[:10],
                "rawCandidates": [summarize_raw_candidate(item) for item in direct_raw[:20]],
                "error": direct_error,
            },
            "anchorFallback": {
                "provider": "nominatim",
                "providerEndpoint": NOMINATIM_ENDPOINT,
                "query": anchor_query,
                "attempts": anchor_attempts,
                "candidates": anchor_scored[:10],
                "rawCandidates": [summarize_raw_candidate(item) for item in anchor_raw[:20]],
            },
            "nearbyBoundaryFallback": {
                "provider": "openstreetmap-overpass",
                "providerEndpoint": nearby_endpoint,
                "radiusMeters": NEARBY_COURSE_RADIUS_METERS,
                "batchThrottleMs": overpass_throttle_ms,
                "attempts": nearby_attempts,
                "candidates": nearby_scored[:10],
            },
            "error": error,
        }
        discovery_path.parent.mkdir(parents=True, exist_ok=True)
        discovery_path.write_text(json.dumps(discovery, indent=2, sort_keys=True), encoding="utf-8")
        return True, discovery_ms, overpass_throttle_ms, error
    except Exception as exc:
        discovery_ms = elapsed_ms(started)
        error = f"{type(exc).__name__}: {exc}"
        discovery = {
            "schemaVersion": "looper-course-discovery-v2",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "location": seed["location"],
            "requestedAt": requested_at,
            "completedAt": iso_now(),
            "timingMs": discovery_ms,
            "success": False,
            "chosen": None,
            "direct": {
                "query": direct_query,
                "attempts": direct_attempts,
                "candidates": direct_scored[:10],
                "rawCandidates": [summarize_raw_candidate(item) for item in direct_raw[:20]],
                "error": direct_error,
            },
            "anchorFallback": {
                "query": anchor_query,
                "attempts": anchor_attempts,
                "candidates": anchor_scored[:10],
                "rawCandidates": [summarize_raw_candidate(item) for item in anchor_raw[:20]],
            },
            "nearbyBoundaryFallback": {
                "providerEndpoint": nearby_endpoint,
                "batchThrottleMs": overpass_throttle_ms,
                "attempts": nearby_attempts,
                "candidates": nearby_scored[:10],
            },
            "error": error,
        }
        discovery_path.parent.mkdir(parents=True, exist_ok=True)
        discovery_path.write_text(json.dumps(discovery, indent=2, sort_keys=True), encoding="utf-8")
        return True, discovery_ms, overpass_throttle_ms, error


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    seed_file = args.seed_file.resolve()
    seeds = load_seeds(seed_file)
    request_gate: dict[str, float] = {"lastRequestAt": 0.0}
    overpass_gate: dict[str, float] = {"lastRequestStartedAt": 0.0}
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
        snapshot_path = artifact_dir / "osm-snapshot.json"

        discovery_used_network, discovery_ms, discovery_overpass_throttle_ms, discovery_error = discover_or_reuse(
            seed,
            config_path=config_path,
            discovery_path=discovery_path,
            request_gate=request_gate,
            overpass_gate=overpass_gate,
        )

        import_return_code: int | None = None
        import_timing: dict[str, Any] | None = None
        import_throttle_ms = 0.0
        error: str | None = discovery_error
        if discovery_error is None and config_path.exists():
            if not snapshot_path.exists():
                import_throttle_ms = pace_overpass(overpass_gate)
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
                "overpassThrottleMs": discovery_overpass_throttle_ms,
                "error": discovery_error,
            },
            "import": import_timing,
            "timingMs": {
                "discovery": discovery_ms,
                "batchThrottle": round(discovery_overpass_throttle_ms + import_throttle_ms, 1),
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
