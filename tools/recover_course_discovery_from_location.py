#!/usr/bin/env python3
"""Second-stage course discovery using the seed location as a wider search anchor."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from batch_prepare_osm_courses import (
    choose_anchor,
    choose_nearby_boundary,
    config_from_choice,
    iso_now,
    load_json,
    load_seeds,
    pace_overpass,
    request_nominatim,
    validate_nearby_payload,
)
from fetch_osm_course_snapshot import SourceFetchError, fetch_overpass_query

EXPANDED_COURSE_RADIUS_METERS = 30000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-file", required=True, type=Path)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser.parse_args()


def expanded_golf_query(lat: float, lon: float) -> str:
    return f"""[out:json][timeout:45];
(
  way(around:{EXPANDED_COURSE_RADIUS_METERS},{lat},{lon})[\"leisure\"=\"golf_course\"];
  rel(around:{EXPANDED_COURSE_RADIUS_METERS},{lat},{lon})[\"leisure\"=\"golf_course\"];
);
out tags center;
"""


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    seeds = load_seeds(args.seed_file.resolve())
    request_gate: dict[str, float] = {"lastRequestAt": 0.0}
    overpass_gate: dict[str, float] = {"lastRequestStartedAt": 0.0}
    results: list[dict[str, Any]] = []

    for seed in seeds:
        slug = str(seed["slug"])
        config_path = repo_root / "config" / "course-geometry" / f"{slug}-v1.json"
        discovery_path = repo_root / "artifacts" / "course-geometry" / slug / "discovery-v1.json"
        if config_path.exists():
            results.append({"courseId": seed["courseId"], "status": "preserved"})
            continue

        try:
            # Reuse the normal Nominatim request/anchor scoring, but make the
            # requested location itself the thing being resolved.
            location_seed = dict(seed)
            location_seed["courseName"] = str(seed["location"])
            location_query, location_raw, location_attempts = request_nominatim(
                location_seed,
                request_gate=request_gate,
                include_golf_category=False,
            )
            anchor, location_scored, anchor_error = choose_anchor(location_seed, location_raw)
            if anchor is None:
                raise RuntimeError(anchor_error or "location search returned no usable anchor")

            throttle_ms = pace_overpass(overpass_gate)
            raced = fetch_overpass_query(
                expanded_golf_query(float(anchor["lat"]), float(anchor["lon"])),
                validator=validate_nearby_payload,
            )
            choice, nearby_scored, nearby_error = choose_nearby_boundary(
                seed,
                raced["payload"],
                anchor,
            )
            if choice is None:
                raise RuntimeError(nearby_error or "expanded nearby boundary discovery failed")

            choice = dict(choice)
            choice["discoveryMethod"] = "nominatim-location-anchor-expanded-overpass-boundary"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(config_from_choice(seed, choice), indent=2) + "\n",
                encoding="utf-8",
            )

            discovery = load_json(discovery_path) or {
                "schemaVersion": "looper-course-discovery-v2",
                "courseId": seed["courseId"],
                "courseName": seed["courseName"],
                "location": seed["location"],
            }
            discovery.update({
                "completedAt": iso_now(),
                "success": True,
                "chosen": choice,
                "error": None,
                "locationAnchorRecovery": {
                    "query": location_query,
                    "radiusMeters": EXPANDED_COURSE_RADIUS_METERS,
                    "locationAttempts": location_attempts,
                    "locationCandidates": location_scored[:10],
                    "providerEndpoint": raced["endpoint"],
                    "batchThrottleMs": throttle_ms,
                    "overpassAttempts": raced["attempts"],
                    "boundaryCandidates": nearby_scored[:10],
                },
            })
            discovery_path.parent.mkdir(parents=True, exist_ok=True)
            discovery_path.write_text(
                json.dumps(discovery, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            results.append({
                "courseId": seed["courseId"],
                "status": "recovered",
                "name": choice.get("name"),
                "osmType": choice["osmType"],
                "osmId": choice["osmId"],
            })
        except SourceFetchError as exc:
            results.append({
                "courseId": seed["courseId"],
                "status": "failed",
                "error": f"expanded Overpass discovery failed: {exc}",
            })
        except Exception as exc:
            results.append({
                "courseId": seed["courseId"],
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
            })

    recovered_count = sum(row["status"] == "recovered" for row in results)
    failed_count = sum(row["status"] == "failed" for row in results)
    summary = {
        "schemaVersion": "looper-location-anchor-recovery-v1",
        "completedAt": iso_now(),
        "radiusMeters": EXPANDED_COURSE_RADIUS_METERS,
        "recoveredCount": recovered_count,
        "failedCount": failed_count,
        "results": results,
    }
    summary_path = repo_root / "artifacts" / "course-geometry" / "location-anchor-recovery-v1.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
