#!/usr/bin/env python3
"""Refresh cache-v1 metadata after a canonical course import/rebuild."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_REFRESH_POLICY = {
    "deleteOnAge": False,
    "implicitRefreshOnBuild": False,
    "localRebuildTriggers": [
        "package-schema-change",
        "builder-fingerprint-change",
    ],
    "refreshEligibleAfterDays": 365,
    "refreshTriggers": [
        "explicit-refresh",
        "reported-geometry-error",
        "known-course-renovation",
        "source-age-eligible-and-course-used",
    ],
    "serveCachedRegardlessOfAge": True,
    "staleReviewAfterDays": 1095,
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def repo_path(path: Path) -> str:
    """Persist stable repository-relative paths instead of CI runner paths."""
    resolved = path.resolve()
    root = Path.cwd().resolve()
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--green-detail", type=Path)
    parser.add_argument("--build-reason")
    return parser.parse_args()


def bootstrap_cache(args: argparse.Namespace, config: dict, course_package: dict) -> dict:
    """Create the cache envelope required for a first-time course import."""
    return {
        "schemaVersion": "looper-course-cache-v1",
        "courseId": config.get("courseId"),
        "courseName": config.get("courseName"),
        "refreshPolicy": dict(DEFAULT_REFRESH_POLICY),
        "package": {
            "configPath": repo_path(args.config),
            "path": repo_path(args.package),
            "schemaVersion": course_package.get("schemaVersion"),
        },
        "source": {
            "element": config.get("osmCourseElement"),
            "snapshotPath": repo_path(args.snapshot),
        },
    }


def terrain_composer_version(course_package: dict) -> str | None:
    provenance = course_package.get("terrainProvenance")
    if not isinstance(provenance, dict):
        return None
    schema = provenance.get("schemaVersion")
    if schema == "looper-course-terrain-v1":
        return "compose_course_package_canonical_v1"
    if schema == "looper-greywolf-terrain-v1":
        return "compose_course_package_legacy_greywolf_v1"
    return "embedded-terrain-unknown-composer"


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    course_package = json.loads(args.package.read_text(encoding="utf-8"))

    cache_existed = args.cache.exists()
    if cache_existed:
        cache = json.loads(args.cache.read_text(encoding="utf-8"))
    else:
        cache = bootstrap_cache(args, config, course_package)

    rebuilt_at = str(manifest.get("generatedAt") or now_iso())
    source_base = (snapshot.get("osm3s") or {}).get("timestamp_osm_base")
    snapshot_meta = snapshot.get("looperSnapshot") or {}
    source_provider = str(snapshot_meta.get("featureProvider") or "openstreetmap-overpass")

    cache["schemaVersion"] = "looper-course-cache-v1"
    cache["courseId"] = config.get("courseId") or cache.get("courseId")
    cache["courseName"] = config.get("courseName") or cache.get("courseName")
    cache.setdefault("refreshPolicy", dict(DEFAULT_REFRESH_POLICY))
    cache["freshness"] = {
        "ageDays": 0,
        "evaluatedAt": rebuilt_at,
        "status": "current",
    }
    cache["lastBuild"] = {
        "reason": args.build_reason or ("reported-geometry-error" if cache_existed else "new-course-canonical-import"),
        "usedNetworkForOsm": True,
    }

    package = cache.setdefault("package", {})
    package["builderVersion"] = str(manifest.get("compiler") or "build_osm_course_package_v5")
    package["builderFingerprintSha256"] = str(manifest.get("builderFingerprintSha256") or "")
    package["builtAt"] = rebuilt_at
    package["configPath"] = repo_path(args.config)
    package["configSha256"] = sha256(args.config)
    package["path"] = repo_path(args.package)
    package["schemaVersion"] = course_package.get("schemaVersion")
    package["sha256"] = sha256(args.package)
    composer = terrain_composer_version(course_package)
    if composer:
        package["terrainComposerVersion"] = composer
    else:
        package.pop("terrainComposerVersion", None)

    green_detail_path = args.green_detail
    if green_detail_path and green_detail_path.exists():
        green_detail = json.loads(green_detail_path.read_text(encoding="utf-8"))
        package["greenDetail"] = {
            "schemaVersion": green_detail.get("schemaVersion"),
            "sha256": sha256(green_detail_path),
            "spacingYds": (green_detail.get("runtimeTerrain") or {}).get("spacingYds"),
            "marginYds": (green_detail.get("runtimeTerrain") or {}).get("marginYds"),
            "sourceDataset": (green_detail.get("source") or {}).get("dataset"),
        }
    else:
        package.pop("greenDetail", None)

    terrain_provenance = course_package.get("terrainProvenance")
    if isinstance(terrain_provenance, dict):
        terrain_source = terrain_provenance.get("source") or {}
        package["terrain"] = {
            "schemaVersion": terrain_provenance.get("schemaVersion"),
            "sourceProvider": terrain_source.get("provider"),
            "sourceDataset": terrain_source.get("dataset"),
            "sourceResolutionMeters": terrain_source.get("sourceResolutionMeters"),
        }
    else:
        package.pop("terrain", None)

    source = cache.setdefault("source", {})
    source["element"] = config.get("osmCourseElement") or source.get("element")
    source["provider"] = source_provider
    source["fetchedAt"] = rebuilt_at
    source["fetchedAtBasis"] = "source-provider-fetch"
    source["lastCheckedAt"] = rebuilt_at
    source["snapshotPath"] = repo_path(args.snapshot)
    source["snapshotSha256"] = sha256(args.snapshot)
    if source_base:
        source["sourceBaseTimestamp"] = source_base
    else:
        source.pop("sourceBaseTimestamp", None)

    args.cache.parent.mkdir(parents=True, exist_ok=True)
    args.cache.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "cacheCreated": not cache_existed,
        "courseId": cache.get("courseId"),
        "builder": package.get("builderVersion"),
        "sourceProvider": source.get("provider"),
        "terrainComposer": package.get("terrainComposerVersion"),
        "packageSha256": package.get("sha256"),
        "greenDetailSha256": (package.get("greenDetail") or {}).get("sha256"),
        "snapshotSha256": source.get("snapshotSha256"),
        "sourceBaseTimestamp": source.get("sourceBaseTimestamp"),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
