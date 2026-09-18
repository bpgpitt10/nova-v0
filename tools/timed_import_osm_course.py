#!/usr/bin/env python3
"""Run the Looper OSM importer with persistent timing history.

Every course import attempt writes one NDJSON row under the course artifact
folder, including failures. Cold-source acquisition is timed separately from
package compilation so later optimization can distinguish provider latency from
geometry complexity.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fetch_osm_course_snapshot import SourceFetchError, fetch_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--refresh-osm", action="store_true")
    parser.add_argument("--offline", action="store_true")
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


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def slug_for(config: dict[str, Any], config_path: Path) -> str:
    slug = config.get("slug")
    if isinstance(slug, str) and slug.strip():
        return slug.strip()
    return re.sub(r"-v\d+$", "", config_path.stem)


def append_log(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True, separators=(",", ":")))
        handle.write("\n")


def patch_cache_after_provider_fetch(
    cache_path: Path,
    *,
    fetched_at: str,
    endpoint: str,
    reason: str,
) -> None:
    cache = load_json(cache_path)
    if not cache:
        return
    source = cache.setdefault("source", {})
    if isinstance(source, dict):
        source["provider"] = "openstreetmap-overpass"
        source["providerEndpoint"] = endpoint
        source["fetchedAt"] = fetched_at
        source["fetchedAtBasis"] = "source-provider-fetch"
        source["lastCheckedAt"] = fetched_at
    last_build = cache.setdefault("lastBuild", {})
    if isinstance(last_build, dict):
        last_build["usedNetworkForOsm"] = True
        last_build["reason"] = reason
    cache_path.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    slug = slug_for(config, config_path)
    artifact_dir = repo_root / "artifacts" / "course-geometry" / slug
    timing_path = artifact_dir / "import-timings.ndjson"
    cache_path = artifact_dir / "cache-v1.json"
    topology_path = artifact_dir / "topology-audit-v1.json"
    snapshot_path = artifact_dir / "osm-snapshot.json"

    started_at = iso_now()
    total_start = time.perf_counter()
    source_fetch_ms: float | None = None
    import_ms: float | None = None
    audit_ms: float | None = None
    source_fetch_attempts: list[dict[str, Any]] = []
    source_endpoint: str | None = None
    used_network = False
    return_code = 1
    error_text: str | None = None

    try:
        needs_source = args.refresh_osm or not snapshot_path.exists()
        if needs_source and not args.offline:
            used_network = True
            phase_start = time.perf_counter()
            try:
                fetch_result = fetch_snapshot(config, snapshot_path)
                source_fetch_ms = elapsed_ms(phase_start)
                source_fetch_attempts = fetch_result["attempts"]
                source_endpoint = fetch_result["endpoint"]
            except SourceFetchError as exc:
                source_fetch_ms = elapsed_ms(phase_start)
                source_fetch_attempts = exc.attempts
                error_text = str(exc)
                return_code = 1
                return return_code

        command = [
            sys.executable,
            str(repo_root / "tools" / "import_osm_course.py"),
            "--config",
            str(config_path),
            "--offline",
        ]

        phase_start = time.perf_counter()
        completed = subprocess.run(command, cwd=repo_root, check=False)
        import_ms = elapsed_ms(phase_start)
        if completed.returncode != 0:
            return_code = completed.returncode
            error_text = f"import_osm_course.py exited {completed.returncode}"
            return return_code

        if used_network and source_endpoint:
            fetched_at = iso_now()
            patch_cache_after_provider_fetch(
                cache_path,
                fetched_at=fetched_at,
                endpoint=source_endpoint,
                reason="explicit-refresh-build" if args.refresh_osm else "cold-source-fetch-build",
            )

        phase_start = time.perf_counter()
        completed = subprocess.run(
            [
                sys.executable,
                str(repo_root / "tools" / "audit_osm_topology.py"),
                "--osm",
                str(snapshot_path),
                "--output",
                str(topology_path),
            ],
            cwd=repo_root,
            check=False,
        )
        audit_ms = elapsed_ms(phase_start)
        return_code = completed.returncode
        if completed.returncode != 0:
            error_text = f"audit_osm_topology.py exited {completed.returncode}"
        return return_code
    except BaseException as exc:
        error_text = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        cache = load_json(cache_path) or {}
        last_build = cache.get("lastBuild") if isinstance(cache.get("lastBuild"), dict) else {}
        freshness = cache.get("freshness") if isinstance(cache.get("freshness"), dict) else {}
        source = cache.get("source") if isinstance(cache.get("source"), dict) else {}
        ended_at = iso_now()
        row = {
            "schemaVersion": "looper-course-import-timing-v1",
            "courseId": config.get("courseId"),
            "courseName": config.get("courseName"),
            "slug": slug,
            "startedAt": started_at,
            "endedAt": ended_at,
            "success": return_code == 0,
            "exitCode": return_code,
            "mode": (
                "offline"
                if args.offline
                else "explicit-refresh"
                if args.refresh_osm
                else "normal"
            ),
            "usedNetworkForOsm": used_network or last_build.get("usedNetworkForOsm") is True,
            "buildReason": last_build.get("reason"),
            "freshnessStatus": freshness.get("status"),
            "sourceFetchedAt": source.get("fetchedAt"),
            "sourceProviderEndpoint": source_endpoint or source.get("providerEndpoint"),
            "sourceFetchAttempts": source_fetch_attempts,
            "timingMs": {
                "sourceFetch": source_fetch_ms,
                "importer": import_ms,
                "topologyAudit": audit_ms,
                "total": elapsed_ms(total_start),
            },
            "error": error_text,
        }
        append_log(timing_path, row)
        print(json.dumps({
            "courseId": row["courseId"],
            "success": row["success"],
            "usedNetworkForOsm": row["usedNetworkForOsm"],
            "sourceProviderEndpoint": row["sourceProviderEndpoint"],
            "timingMs": row["timingMs"],
            "timingLog": str(timing_path.relative_to(repo_root)),
        }, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
