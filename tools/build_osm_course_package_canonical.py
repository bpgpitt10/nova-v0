#!/usr/bin/env python3
"""Run the canonical V7 course compiler and stamp reproducible metadata."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import build_osm_course_package as base
import build_osm_course_package_v4 as v4
import build_osm_course_package_v5 as v5
import build_osm_course_package_v6 as v6
import build_osm_course_package_v7 as v7


COMPILER_NAME = "build_osm_course_package_v7"


def fingerprint() -> str:
    digest = hashlib.sha256()
    for source in (
        Path(base.__file__),
        Path(v4.__file__),
        Path(v5.__file__),
        Path(v6.__file__),
        Path(v7.__file__),
        Path(__file__),
    ):
        digest.update(source.name.encode("utf-8"))
        digest.update(source.read_bytes())
    return digest.hexdigest()


def main() -> int:
    # V5 remains authoritative for topology, ownership, route orientation and
    # selected-tee anchoring. V6 retains all confidently route-owned OSM tee
    # candidates. V7 adds deterministic tactical semantics for woods/scrub
    # without changing the underlying source context geometry.
    base.CONTEXT_NATURAL.update({
        "grassland": "native-grass",
        "heath": "scrub",
        "sand": "dune-sand",
        "beach": "dune-sand",
    })
    base.CONTEXT_LANDUSE["meadow"] = "native-grass"
    base.normalize_osm = v6.normalize_osm
    v4.model_for_hole = v7.model_for_hole
    result = v4.main()

    args = v4.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    manifest["compiler"] = COMPILER_NAME
    manifest["builderFingerprintSha256"] = fingerprint()
    manifest["registrationNote"] = (
        "Static geometry preserves cached route-axis orientation, rebases the "
        "origin to a mapped tee when confidently owned, packages true heading "
        "metadata and route-owned OSM tee candidates, and preserves woods/scrub as source context while mirroring them "
        "to tactical deep-rough; runtime precedence resolves overlaps."
    )
    args.manifest.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    package = json.loads(args.output.read_text(encoding="utf-8"))
    package["compiler"] = COMPILER_NAME
    package["builderFingerprintSha256"] = manifest["builderFingerprintSha256"]
    args.output.write_text(
        json.dumps(package, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return result


if __name__ == "__main__":
    raise SystemExit(main())
