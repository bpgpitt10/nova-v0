#!/usr/bin/env python3
"""Generic offline importer for Looper OSM-backed static course packages.

Runtime never talks to OpenStreetMap. This tool:
1. builds a bounded Overpass query from course config,
2. refreshes or reuses the cached OSM snapshot,
3. fills any missing per-hole reference metadata from OSM routes,
4. runs the topology-safe generic package compiler,
5. validates the resulting package before it can be published,
6. records durable cache/freshness metadata without expiring usable data.

A cached OSM snapshot is reused indefinitely by default. Age only changes its
refresh eligibility; it never makes a validated package unavailable and never
causes an implicit upstream fetch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_osm_course_package as base

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
USER_AGENT = "LooperCoursePackage/0.3 (+https://github.com/bpgpitt10/nova-v0)"
DEFAULT_CONTEXT_RADIUS_METERS = 1600
DEFAULT_MIN_ELEMENTS = 50
CACHE_SCHEMA_VERSION = "looper-course-cache-v1"
BUILDER_VERSION = "build_osm_course_package_v3"
REFRESH_ELIGIBLE_AFTER_DAYS = 365
STALE_REVIEW_AFTER_DAYS = 1095
BUILDER_FILES = (
    "tools/build_osm_course_package.py",
    "tools/build_osm_course_package_v2.py",
    "tools/build_osm_course_package_v3.py",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--refresh-osm",
        action="store_true",
        help="Explicitly fetch a fresh OSM snapshot even when a cached snapshot exists.",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Require an existing cached OSM snapshot; never call Overpass.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser.parse_args()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def builder_fingerprint(repo_root: Path) -> str:
    digest = hashlib.sha256()
    for relative_path in BUILDER_FILES:
        path = repo_root / relative_path
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_json_if_present(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else None


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != "looper-course-build-config-v1":
        raise SystemExit(f"{path}: unsupported course build config schema")
    for key in ("courseId", "courseName", "location", "osmCenter"):
        if not config.get(key):
            raise SystemExit(f"{path}: missing required {key}")
    center = config["osmCenter"]
    if (
        not isinstance(center, list)
        or len(center) != 2
        or not all(isinstance(value, (int, float)) for value in center)
    ):
        raise SystemExit(f"{path}: osmCenter must be [lat, lon]")
    return config


def slug_from_config(config: dict[str, Any], path: Path) -> str:
    slug = config.get("slug")
    if isinstance(slug, str) and slug.strip():
        return slug.strip()
    stem = re.sub(r"-v\d+$", "", path.stem)
    if stem:
        return stem
    raise SystemExit(f"{path}: could not derive course slug")


def osm_course_element(config: dict[str, Any]) -> tuple[str, int]:
    raw = config.get("osmCourseElement")
    if isinstance(raw, dict):
        element_type = raw.get("type")
        element_id = raw.get("id")
    else:
        element_type = "way"
        element_id = config.get("osmCourseWayId")

    if element_type not in {"way", "relation"}:
        raise SystemExit("osmCourseElement.type must be 'way' or 'relation'")
    if not isinstance(element_id, int) or element_id <= 0:
        raise SystemExit("course config requires a positive OSM course element id")
    return element_type, element_id


def build_overpass_query(config: dict[str, Any]) -> str:
    element_type, element_id = osm_course_element(config)
    lat, lon = config["osmCenter"]
    radius = int(config.get("osmContextRadiusMeters") or DEFAULT_CONTEXT_RADIUS_METERS)
    selector = "way" if element_type == "way" else "rel"
    return f"""[out:json][timeout:120];
{selector}({element_id});
map_to_area -> .courseArea;
(
  nwr(area.courseArea)["golf"];
  nwr(area.courseArea)["natural"="water"];
  nwr(area.courseArea)["landuse"="reservoir"];
  nwr(around:{radius},{lat},{lon})["natural"~"^(wood|scrub)$"];
  nwr(around:{radius},{lat},{lon})["landuse"~"^(forest|grass|meadow)$"];
);
out body geom;
"""


def fetch_overpass(query: str) -> dict[str, Any]:
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=encoded,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise ValueError("Overpass returned a non-object payload")
            return payload
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            print(f"Overpass fetch failed at {endpoint}: {exc}", file=sys.stderr)
    raise SystemExit(f"All Overpass endpoints failed: {last_error}")


def validate_snapshot(payload: dict[str, Any], config: dict[str, Any]) -> None:
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise SystemExit("OSM snapshot does not contain an elements array")
    minimum = int(config.get("minimumOsmElements") or DEFAULT_MIN_ELEMENTS)
    if len(elements) < minimum:
        raise SystemExit(
            f"OSM snapshot unexpectedly small: {len(elements)} elements; expected at least {minimum}"
        )


def source_base_timestamp(payload: dict[str, Any]) -> str | None:
    osm3s = payload.get("osm3s")
    if not isinstance(osm3s, dict):
        return None
    value = osm3s.get("timestamp_osm_base")
    return value if isinstance(value, str) and value else None


def route_length_yards(route: dict[str, Any]) -> float:
    points = route["geometry"]
    return sum(base.haversine_yards(a, b) for a, b in zip(points, points[1:]))


def effective_config(
    config: dict[str, Any],
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[int]]:
    """Fill missing hole metadata from OSM without overriding reviewed config."""
    resolved = deepcopy(config)

    # The v2 package core still writes a legacy way-only metadata field. Supply
    # it internally; normalize emitted provenance after V3 completes.
    _element_type, element_id = osm_course_element(resolved)
    resolved.setdefault("osmCourseWayId", element_id)

    _features, hole_routes = base.normalize_osm(payload)
    missing_routes = sorted(set(range(1, 19)) - set(hole_routes))
    if missing_routes:
        raise SystemExit(f"Missing OSM golf=hole routes: {missing_routes}")

    holes = resolved.setdefault("holes", {})
    inferred: list[int] = []
    for hole_number in range(1, 19):
        key = str(hole_number)
        raw_hole = holes.setdefault(key, {})
        route = hole_routes[hole_number]

        if not raw_hole.get("par"):
            par = route.get("par")
            if isinstance(par, str) and par.isdigit():
                raw_hole["par"] = int(par)
            elif isinstance(par, (int, float)):
                raw_hole["par"] = int(par)

        if not isinstance(raw_hole.get("targetYards"), (int, float)):
            raw_hole["targetYards"] = round(route_length_yards(route), 1)
            inferred.append(hole_number)

    return resolved, inferred


def run_compiler(
    *,
    repo_root: Path,
    config: dict[str, Any],
    snapshot_path: Path,
    output_path: Path,
    manifest_path: Path,
) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".json",
        delete=False,
    ) as handle:
        json.dump(config, handle, indent=2)
        effective_path = Path(handle.name)

    try:
        command = [
            sys.executable,
            str(repo_root / "tools" / "build_osm_course_package_v3.py"),
            "--osm",
            str(snapshot_path),
            "--config",
            str(effective_path),
            "--output",
            str(output_path),
            "--manifest",
            str(manifest_path),
        ]
        subprocess.run(command, cwd=repo_root, check=True)
    finally:
        effective_path.unlink(missing_ok=True)


def normalize_source_metadata(
    *,
    config: dict[str, Any],
    output_path: Path,
    manifest_path: Path,
    snapshot_sha256: str,
    builder_sha256: str,
) -> None:
    """Normalize generic OSM identity and record the actual V3 build provenance."""
    element_type, element_id = osm_course_element(config)
    source_element = {"type": element_type, "id": element_id}
    source_url = f"https://www.openstreetmap.org/{element_type}/{element_id}"

    package = json.loads(output_path.read_text(encoding="utf-8"))
    provenance = package.setdefault("provenance", {})
    provenance["sourceUrl"] = source_url
    provenance["sourceElement"] = source_element
    provenance["sourceSnapshotSha256"] = snapshot_sha256
    provenance["builderVersion"] = BUILDER_VERSION
    provenance["builderFingerprintSha256"] = builder_sha256
    output_path.write_text(json.dumps(package, indent=2, sort_keys=True), encoding="utf-8")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["compiler"] = BUILDER_VERSION
    manifest["osmCourseElement"] = source_element
    manifest["sourceSnapshotSha256"] = snapshot_sha256
    manifest["builderFingerprintSha256"] = builder_sha256
    if element_type == "relation":
        manifest.pop("osmCourseWayId", None)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def validate_manifest(manifest_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("osmHoleRoutes") != 18:
        raise SystemExit(f"Expected 18 OSM hole routes; got {manifest.get('osmHoleRoutes')}")
    if manifest.get("readyHoleCount") != 18:
        raise SystemExit(
            f"Expected 18 ready holes; got {manifest.get('readyHoleCount')}: "
            f"{manifest.get('readyHoles')}"
        )
    if manifest.get("allHolesStaticGeometryReady") is not True:
        raise SystemExit("Static geometry validation did not pass for all 18 holes")
    return manifest


def freshness_status(fetched_at: str | None, evaluated_at: datetime) -> tuple[str, float | None]:
    fetched = parse_iso(fetched_at)
    if fetched is None:
        return "unknown", None
    age_days = max(0.0, (evaluated_at - fetched).total_seconds() / 86400.0)
    if age_days < REFRESH_ELIGIBLE_AFTER_DAYS:
        return "current", age_days
    if age_days < STALE_REVIEW_AFTER_DAYS:
        return "refresh-eligible", age_days
    return "stale-review", age_days


def write_cache_metadata(
    *,
    repo_root: Path,
    config_path: Path,
    config: dict[str, Any],
    payload: dict[str, Any],
    snapshot_path: Path,
    output_path: Path,
    cache_path: Path,
    fetched_upstream: bool,
    build_started_at: datetime,
    snapshot_sha256: str,
    builder_sha256: str,
) -> dict[str, Any]:
    previous = load_json_if_present(cache_path) or {}
    previous_source = previous.get("source") if isinstance(previous.get("source"), dict) else {}
    now = utc_now()
    upstream_base = source_base_timestamp(payload)

    if fetched_upstream:
        fetched_at = iso_z(build_started_at)
        fetched_at_basis = "upstream-fetch"
        last_checked_at = fetched_at
    else:
        fetched_at = previous_source.get("fetchedAt")
        fetched_at_basis = previous_source.get("fetchedAtBasis")
        last_checked_at = previous_source.get("lastCheckedAt")
        if not isinstance(fetched_at, str) or not fetched_at:
            # First cache-manifest build for an already-preserved snapshot.
            # OSM's base timestamp is the best conservative bootstrap available;
            # future explicit refreshes will record the exact fetch time.
            fetched_at = upstream_base
            fetched_at_basis = "osm-base-timestamp-bootstrap" if upstream_base else "unknown"

    status, age_days = freshness_status(fetched_at, now)
    package_payload = json.loads(output_path.read_text(encoding="utf-8"))
    element_type, element_id = osm_course_element(config)

    cache = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "source": {
            "provider": "openstreetmap-overpass",
            "element": {"type": element_type, "id": element_id},
            "snapshotPath": str(snapshot_path.relative_to(repo_root)),
            "snapshotSha256": snapshot_sha256,
            "sourceBaseTimestamp": upstream_base,
            "fetchedAt": fetched_at,
            "fetchedAtBasis": fetched_at_basis,
            "lastCheckedAt": last_checked_at,
        },
        "package": {
            "path": str(output_path.relative_to(repo_root)),
            "schemaVersion": package_payload.get("schemaVersion"),
            "sha256": sha256_file(output_path),
            "builtAt": iso_z(now),
            "builderVersion": BUILDER_VERSION,
            "builderFingerprintSha256": builder_sha256,
            "configPath": str(config_path.relative_to(repo_root)),
            "configSha256": sha256_file(config_path),
        },
        "freshness": {
            "status": status,
            "evaluatedAt": iso_z(now),
            "ageDays": round(age_days, 2) if age_days is not None else None,
        },
        "refreshPolicy": {
            "serveCachedRegardlessOfAge": True,
            "deleteOnAge": False,
            "implicitRefreshOnBuild": False,
            "refreshEligibleAfterDays": REFRESH_ELIGIBLE_AFTER_DAYS,
            "staleReviewAfterDays": STALE_REVIEW_AFTER_DAYS,
            "refreshTriggers": [
                "explicit-refresh",
                "reported-geometry-error",
                "known-course-renovation",
                "source-age-eligible-and-course-used",
            ],
            "localRebuildTriggers": [
                "package-schema-change",
                "builder-fingerprint-change",
            ],
        },
        "lastBuild": {
            "reason": "source-refresh" if fetched_upstream else "cached-source-rebuild",
            "usedNetworkForOsm": fetched_upstream,
        },
    }
    cache_path.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")
    return cache


def topology_diagnostics(payload: dict[str, Any]) -> dict[str, int]:
    relations = 0
    multipolygons = 0
    inner_members = 0
    for element in payload.get("elements", []):
        if element.get("type") != "relation":
            continue
        relations += 1
        if (element.get("tags") or {}).get("type") == "multipolygon":
            multipolygons += 1
        inner_members += sum(
            1 for member in (element.get("members") or []) if member.get("role") == "inner"
        )
    return {
        "relations": relations,
        "multipolygons": multipolygons,
        "innerMembers": inner_members,
    }


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    config_path = args.config.resolve()
    config = load_config(config_path)
    slug = slug_from_config(config, config_path)

    artifact_dir = repo_root / "artifacts" / "course-geometry" / slug
    public_dir = repo_root / "public" / "course-geometry" / slug
    artifact_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)

    snapshot_path = artifact_dir / "osm-snapshot.json"
    query_path = artifact_dir / "overpass-query.txt"
    manifest_path = artifact_dir / "validation-v1.json"
    cache_path = artifact_dir / "cache-v1.json"
    output_path = public_dir / "course-v1.json"

    query = build_overpass_query(config)
    query_path.write_text(query, encoding="utf-8")

    if args.offline and args.refresh_osm:
        raise SystemExit("--offline and --refresh-osm cannot be used together")

    # Deliberately NO age check here. Existing source data stays usable forever
    # unless an explicit refresh is requested. Freshness is advisory metadata.
    should_fetch = args.refresh_osm or not snapshot_path.exists()
    build_started_at = utc_now()
    if should_fetch:
        if args.offline:
            raise SystemExit(f"No cached OSM snapshot at {snapshot_path}")
        payload = fetch_overpass(query)
        snapshot_path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))

    validate_snapshot(payload, config)
    snapshot_sha256 = sha256_file(snapshot_path)
    builder_sha256 = builder_fingerprint(repo_root)
    resolved_config, inferred_holes = effective_config(config, payload)
    run_compiler(
        repo_root=repo_root,
        config=resolved_config,
        snapshot_path=snapshot_path,
        output_path=output_path,
        manifest_path=manifest_path,
    )
    normalize_source_metadata(
        config=config,
        output_path=output_path,
        manifest_path=manifest_path,
        snapshot_sha256=snapshot_sha256,
        builder_sha256=builder_sha256,
    )
    manifest = validate_manifest(manifest_path)
    cache = write_cache_metadata(
        repo_root=repo_root,
        config_path=config_path,
        config=config,
        payload=payload,
        snapshot_path=snapshot_path,
        output_path=output_path,
        cache_path=cache_path,
        fetched_upstream=should_fetch,
        build_started_at=build_started_at,
        snapshot_sha256=snapshot_sha256,
        builder_sha256=builder_sha256,
    )

    element_type, element_id = osm_course_element(config)
    summary = {
        "courseId": config["courseId"],
        "slug": slug,
        "osmCourseElement": {"type": element_type, "id": element_id},
        "snapshot": str(snapshot_path.relative_to(repo_root)),
        "package": str(output_path.relative_to(repo_root)),
        "manifest": str(manifest_path.relative_to(repo_root)),
        "cacheMetadata": str(cache_path.relative_to(repo_root)),
        "cacheStatus": cache["freshness"]["status"],
        "usedNetworkForOsm": should_fetch,
        "inferredReferenceYardageHoles": inferred_holes,
        "topology": topology_diagnostics(payload),
        "readyHoleCount": manifest.get("readyHoleCount"),
        "registrationStatus": manifest.get("registrationStatus"),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
