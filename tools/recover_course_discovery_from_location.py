#!/usr/bin/env python3
"""Second-stage course discovery using the seed location as a wider search anchor.

This path is intentionally conservative: a location match is only accepted when
the selected golf-course boundary also matches distinctive tokens in the
requested course name. A weak match is left unresolved rather than silently
binding Looper to the wrong course.
"""

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
    normalize,
    pace_overpass,
    request_nominatim,
    validate_nearby_payload,
)
from fetch_osm_course_snapshot import SourceFetchError, fetch_overpass_query

EXPANDED_COURSE_RADIUS_METERS = 30000
RECOVERY_METHOD = "nominatim-location-anchor-expanded-overpass-boundary"
IDENTITY_ALGORITHM = "distinctive-token-coverage-v1"
MIN_IDENTITY_COVERAGE = 0.50
MIN_IDENTITY_NAME_RATIO = 0.45
GENERIC_IDENTITY_TOKENS = {
    "a",
    "an",
    "and",
    "at",
    "club",
    "country",
    "course",
    "golf",
    "links",
    "of",
    "resort",
    "the",
}
STALE_IDENTITY_OUTPUTS = (
    "osm-snapshot.json",
    "overpass-query.txt",
    "cache-v1.json",
    "validation-v1.json",
    "topology-audit-v1.json",
    "terrain-v1.json",
    "terrain-source-v1.json",
    "terrain-cache-v1.json",
    "terrain-validation-v1.json",
    "terrain-compose-v1.json",
)


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


def identity_tokens(value: str) -> list[str]:
    return sorted({
        token
        for token in normalize(value).split()
        if len(token) >= 3 and token not in GENERIC_IDENTITY_TOKENS
    })


def requested_identity_names(seed: dict[str, Any]) -> list[str]:
    names = [str(seed["courseName"])]
    aliases = seed.get("aliases")
    if isinstance(aliases, list):
        names.extend(str(alias) for alias in aliases if isinstance(alias, str) and alias.strip())
    return names


def add_identity_metrics(seed: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(candidate)
    candidate_tokens = set(identity_tokens(str(candidate.get("name") or candidate.get("displayName") or "")))
    best_requested: list[str] = []
    best_overlap: list[str] = []
    best_coverage = 0.0

    for requested_name in requested_identity_names(seed):
        requested_tokens = identity_tokens(requested_name)
        overlap = sorted(set(requested_tokens) & candidate_tokens)
        coverage = len(overlap) / len(requested_tokens) if requested_tokens else 0.0
        if (coverage, len(overlap), len(requested_tokens)) > (
            best_coverage,
            len(best_overlap),
            len(best_requested),
        ):
            best_requested = requested_tokens
            best_overlap = overlap
            best_coverage = coverage

    precision = len(best_overlap) / len(candidate_tokens) if candidate_tokens else 0.0
    enriched.update({
        "identityRequestedTokens": best_requested,
        "identityCandidateTokens": sorted(candidate_tokens),
        "identityOverlapTokens": best_overlap,
        "identityOverlapCount": len(best_overlap),
        "identityTokenCoverage": round(best_coverage, 4),
        "identityTokenPrecision": round(precision, 4),
    })
    return enriched


def choose_identity_safe_boundary(
    seed: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    ranked = [add_identity_metrics(seed, item) for item in candidates if isinstance(item, dict)]
    ranked.sort(
        key=lambda item: (
            float(item.get("identityTokenCoverage") or 0.0),
            int(item.get("identityOverlapCount") or 0),
            float(item.get("identityTokenPrecision") or 0.0),
            float(item.get("nameRatio") or 0.0),
            float(item.get("score") or 0.0),
        ),
        reverse=True,
    )
    if not ranked:
        return None, ranked, "identity guard found no named golf-course boundary candidates"

    top = ranked[0]
    requested_tokens = top.get("identityRequestedTokens") or []
    coverage = float(top.get("identityTokenCoverage") or 0.0)
    name_ratio = float(top.get("nameRatio") or 0.0)

    if requested_tokens:
        if int(top.get("identityOverlapCount") or 0) < 1 or coverage < MIN_IDENTITY_COVERAGE:
            return (
                None,
                ranked,
                "identity guard rejected top boundary "
                f"{top.get('name')!r}: distinctive-token coverage {coverage:.2f} "
                f"< {MIN_IDENTITY_COVERAGE:.2f}",
            )
        if name_ratio < MIN_IDENTITY_NAME_RATIO:
            return (
                None,
                ranked,
                "identity guard rejected top boundary "
                f"{top.get('name')!r}: name similarity {name_ratio:.2f} "
                f"< {MIN_IDENTITY_NAME_RATIO:.2f}",
            )
    elif name_ratio < 0.75:
        return None, ranked, f"identity guard could not establish a strong name match: {name_ratio:.2f}"

    if len(ranked) > 1:
        runner_up = ranked[1]
        same_coverage = abs(
            coverage - float(runner_up.get("identityTokenCoverage") or 0.0)
        ) < 0.001
        same_overlap = int(top.get("identityOverlapCount") or 0) == int(
            runner_up.get("identityOverlapCount") or 0
        )
        close_score = abs(float(top.get("score") or 0.0) - float(runner_up.get("score") or 0.0)) < 4.0
        if same_coverage and same_overlap and close_score:
            return None, ranked, "identity guard found multiple equally plausible course boundaries"

    return top, ranked, None


def verification_payload(
    seed: dict[str, Any],
    candidate: dict[str, Any] | None,
    *,
    status: str,
    error: str | None,
) -> dict[str, Any]:
    metrics = add_identity_metrics(seed, candidate) if candidate is not None else None
    return {
        "schemaVersion": "looper-course-identity-verification-v1",
        "algorithmVersion": IDENTITY_ALGORITHM,
        "status": status,
        "minimumCoverage": MIN_IDENTITY_COVERAGE,
        "minimumNameRatio": MIN_IDENTITY_NAME_RATIO,
        "requestedCourseName": seed["courseName"],
        "requestedTokens": (metrics or {}).get("identityRequestedTokens") or identity_tokens(str(seed["courseName"])),
        "candidateName": (metrics or {}).get("name"),
        "candidateTokens": (metrics or {}).get("identityCandidateTokens") or [],
        "overlapTokens": (metrics or {}).get("identityOverlapTokens") or [],
        "coverage": (metrics or {}).get("identityTokenCoverage"),
        "nameRatio": (metrics or {}).get("nameRatio"),
        "error": error,
    }


def invalidate_stale_course_outputs(repo_root: Path, slug: str, config_path: Path) -> None:
    if config_path.exists():
        config_path.unlink()
    artifact_dir = repo_root / "artifacts" / "course-geometry" / slug
    for filename in STALE_IDENTITY_OUTPUTS:
        path = artifact_dir / filename
        if path.exists():
            path.unlink()
    public_package = repo_root / "public" / "course-geometry" / slug / "course-v1.json"
    if public_package.exists():
        public_package.unlink()


def write_discovery(discovery_path: Path, discovery: dict[str, Any]) -> None:
    discovery_path.parent.mkdir(parents=True, exist_ok=True)
    discovery_path.write_text(
        json.dumps(discovery, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


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
        discovery = load_json(discovery_path) or {
            "schemaVersion": "looper-course-discovery-v2",
            "courseId": seed["courseId"],
            "courseName": seed["courseName"],
            "location": seed["location"],
        }
        chosen = discovery.get("chosen") if isinstance(discovery.get("chosen"), dict) else None
        verification = (
            discovery.get("identityVerification")
            if isinstance(discovery.get("identityVerification"), dict)
            else None
        )
        legacy_location_recovery = bool(
            config_path.exists()
            and chosen
            and chosen.get("discoveryMethod") == RECOVERY_METHOD
            and not (
                verification
                and verification.get("algorithmVersion") == IDENTITY_ALGORITHM
                and verification.get("status") == "pass"
            )
        )

        if config_path.exists() and not legacy_location_recovery:
            results.append({"courseId": seed["courseId"], "slug": slug, "status": "preserved"})
            continue

        cached_boundary_candidates: list[dict[str, Any]] = []
        if legacy_location_recovery:
            location_recovery = discovery.get("locationAnchorRecovery")
            if isinstance(location_recovery, dict) and isinstance(location_recovery.get("boundaryCandidates"), list):
                cached_boundary_candidates = [
                    item for item in location_recovery["boundaryCandidates"] if isinstance(item, dict)
                ]
            invalidate_stale_course_outputs(repo_root, slug, config_path)

        cached_choice, cached_ranked, cached_error = choose_identity_safe_boundary(
            seed,
            cached_boundary_candidates,
        )
        if cached_choice is not None:
            cached_choice = dict(cached_choice)
            cached_choice["discoveryMethod"] = RECOVERY_METHOD
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(config_from_choice(seed, cached_choice), indent=2) + "\n",
                encoding="utf-8",
            )
            discovery.update({
                "completedAt": iso_now(),
                "success": True,
                "chosen": cached_choice,
                "error": None,
                "identityVerification": verification_payload(
                    seed,
                    cached_choice,
                    status="pass",
                    error=None,
                ),
            })
            location_recovery = discovery.get("locationAnchorRecovery")
            if not isinstance(location_recovery, dict):
                location_recovery = {}
            location_recovery.update({
                "recoverySource": "cached-boundary-candidates",
                "boundaryCandidates": cached_ranked[:10],
            })
            discovery["locationAnchorRecovery"] = location_recovery
            write_discovery(discovery_path, discovery)
            results.append({
                "courseId": seed["courseId"],
                "slug": slug,
                "status": "recovered",
                "name": cached_choice.get("name"),
                "osmType": cached_choice["osmType"],
                "osmId": cached_choice["osmId"],
                "source": "cached-boundary-candidates",
            })
            continue

        ranked_candidates = cached_ranked
        identity_error = cached_error
        try:
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
            _unsafe_choice, nearby_scored, nearby_error = choose_nearby_boundary(
                seed,
                raced["payload"],
                anchor,
            )
            choice, ranked_candidates, identity_error = choose_identity_safe_boundary(seed, nearby_scored)
            if choice is None:
                raise RuntimeError(identity_error or nearby_error or "expanded nearby boundary identity failed")

            choice = dict(choice)
            choice["discoveryMethod"] = RECOVERY_METHOD
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(config_from_choice(seed, choice), indent=2) + "\n",
                encoding="utf-8",
            )

            discovery.update({
                "completedAt": iso_now(),
                "success": True,
                "chosen": choice,
                "error": None,
                "identityVerification": verification_payload(seed, choice, status="pass", error=None),
                "locationAnchorRecovery": {
                    "query": location_query,
                    "radiusMeters": EXPANDED_COURSE_RADIUS_METERS,
                    "locationAttempts": location_attempts,
                    "locationCandidates": location_scored[:10],
                    "providerEndpoint": raced["endpoint"],
                    "batchThrottleMs": throttle_ms,
                    "overpassAttempts": raced["attempts"],
                    "boundaryCandidates": ranked_candidates[:10],
                    "recoverySource": "fresh-expanded-overpass",
                },
            })
            write_discovery(discovery_path, discovery)
            results.append({
                "courseId": seed["courseId"],
                "slug": slug,
                "status": "recovered",
                "name": choice.get("name"),
                "osmType": choice["osmType"],
                "osmId": choice["osmId"],
                "source": "fresh-expanded-overpass",
            })
        except SourceFetchError as exc:
            error = f"expanded Overpass discovery failed: {exc}"
            discovery.update({
                "completedAt": iso_now(),
                "success": False,
                "chosen": None,
                "error": error,
                "identityVerification": verification_payload(
                    seed,
                    ranked_candidates[0] if ranked_candidates else None,
                    status="failed",
                    error=identity_error or error,
                ),
            })
            write_discovery(discovery_path, discovery)
            results.append({"courseId": seed["courseId"], "slug": slug, "status": "failed", "error": error})
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            discovery.update({
                "completedAt": iso_now(),
                "success": False,
                "chosen": None,
                "error": error,
                "identityVerification": verification_payload(
                    seed,
                    ranked_candidates[0] if ranked_candidates else None,
                    status="failed",
                    error=identity_error or error,
                ),
            })
            location_recovery = discovery.get("locationAnchorRecovery")
            if not isinstance(location_recovery, dict):
                location_recovery = {}
            if ranked_candidates:
                location_recovery["boundaryCandidates"] = ranked_candidates[:10]
            discovery["locationAnchorRecovery"] = location_recovery
            write_discovery(discovery_path, discovery)
            results.append({"courseId": seed["courseId"], "slug": slug, "status": "failed", "error": error})

    recovered_count = sum(row["status"] == "recovered" for row in results)
    failed_count = sum(row["status"] == "failed" for row in results)
    summary = {
        "schemaVersion": "looper-location-anchor-recovery-v2",
        "completedAt": iso_now(),
        "radiusMeters": EXPANDED_COURSE_RADIUS_METERS,
        "identityAlgorithmVersion": IDENTITY_ALGORITHM,
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
