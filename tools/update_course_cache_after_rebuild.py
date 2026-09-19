#!/usr/bin/env python3
"""Refresh cache-v1 metadata after a canonical static-geometry rebuild."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cache = json.loads(args.cache.read_text(encoding="utf-8"))
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    rebuilt_at = str(manifest.get("generatedAt") or now_iso())
    source_base = (snapshot.get("osm3s") or {}).get("timestamp_osm_base")
    snapshot_meta = snapshot.get("looperSnapshot") or {}
    source_provider = str(snapshot_meta.get("featureProvider") or "openstreetmap-overpass")

    cache["freshness"] = {
        "ageDays": 0,
        "evaluatedAt": rebuilt_at,
        "status": "current",
    }
    cache["lastBuild"] = {
        "reason": "reported-geometry-error",
        "usedNetworkForOsm": True,
    }

    package = cache.setdefault("package", {})
    package["builderVersion"] = str(manifest.get("compiler") or "build_osm_course_package_v5")
    package["builderFingerprintSha256"] = str(manifest.get("builderFingerprintSha256") or "")
    package["builtAt"] = rebuilt_at
    package["configSha256"] = sha256(args.config)
    package["sha256"] = sha256(args.package)
    package["terrainComposerVersion"] = "carry_forward_embedded_terrain_v1"

    source = cache.setdefault("source", {})
    source["provider"] = source_provider
    source["fetchedAt"] = rebuilt_at
    source["fetchedAtBasis"] = "source-provider-fetch"
    source["lastCheckedAt"] = rebuilt_at
    source["snapshotSha256"] = sha256(args.snapshot)
    if source_base:
        source["sourceBaseTimestamp"] = source_base
    else:
        source.pop("sourceBaseTimestamp", None)

    args.cache.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "courseId": cache.get("courseId"),
        "builder": package.get("builderVersion"),
        "sourceProvider": source.get("provider"),
        "packageSha256": package.get("sha256"),
        "snapshotSha256": source.get("snapshotSha256"),
        "sourceBaseTimestamp": source.get("sourceBaseTimestamp"),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
