#!/usr/bin/env python3
"""Promote an existing cached route package to V7 tactical surface semantics.

This intentionally does not rebuild OSM geometry or terrain. It is for cached
packages whose source geometry/context is already accepted and where V7 only
needs to expose existing woods/scrub context as tactical deep-rough.

The original geometry compiler identity remains intact. A separate semantic
compiler marker records the non-destructive promotion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_osm_course_package_v7 as v7


SEMANTIC_COMPILER = "build_osm_course_package_v7"
SEMANTIC_POLICY_VERSION = 2


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def promote_package(package: dict[str, Any]) -> dict[str, Any]:
    holes = package.get("holes")
    if not isinstance(holes, dict):
        raise ValueError("Package must contain a keyed holes object")

    promoted_counts: dict[str, int] = {}
    for hole_number in range(1, 19):
        key = str(hole_number)
        hole = holes.get(key)
        if not isinstance(hole, dict):
            raise ValueError(f"Package is missing Hole {hole_number}")
        promoted = v7.apply_tactical_surface_semantics(hole)
        holes[key] = promoted
        promoted_counts[key] = len((promoted.get("surfaces") or {}).get("deep-rough", []))

    package["semanticCompiler"] = SEMANTIC_COMPILER
    package["semanticSurfacePolicy"] = {
        "version": SEMANTIC_POLICY_VERSION,
        "promotedAt": now_iso(),
        "method": "cached-context-to-tactical-deep-rough",
        "geometryRebuilt": False,
        "terrainRebuilt": False,
        "deepRoughPolygonsByHole": promoted_counts,
    }

    provenance = package.get("provenance")
    if isinstance(provenance, dict):
        note = str(provenance.get("note") or "").strip()
        addition = (
            "Cached woods/scrub context is mirrored as tactical deep-rough by V7; "
            "source geometry and embedded terrain are unchanged."
        )
        provenance["note"] = f"{note} {addition}".strip()

    return package


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--cache", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    package = json.loads(args.package.read_text(encoding="utf-8"))
    promoted = promote_package(package)
    args.package.write_text(
        json.dumps(promoted, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    package_sha = sha256(args.package)
    if args.cache is not None:
        cache = json.loads(args.cache.read_text(encoding="utf-8"))
        package_meta = cache.setdefault("package", {})
        package_meta["sha256"] = package_sha
        package_meta["semanticCompiler"] = SEMANTIC_COMPILER
        package_meta["semanticSurfacePolicyVersion"] = SEMANTIC_POLICY_VERSION
        cache["lastBuild"] = {
            "reason": "cached-semantic-promotion",
            "usedNetworkForOsm": False,
        }
        args.cache.write_text(
            json.dumps(cache, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    print(json.dumps({
        "courseId": promoted.get("courseId"),
        "semanticCompiler": SEMANTIC_COMPILER,
        "semanticSurfacePolicyVersion": SEMANTIC_POLICY_VERSION,
        "geometryRebuilt": False,
        "terrainRebuilt": False,
        "packageSha256": package_sha,
        "deepRoughPolygonsByHole": promoted["semanticSurfacePolicy"]["deepRoughPolygonsByHole"],
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
