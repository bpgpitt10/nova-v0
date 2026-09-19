#!/usr/bin/env python3
"""Run the canonical V5 course compiler and stamp reproducible metadata."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import build_osm_course_package_v4 as v4
import build_osm_course_package_v5 as v5


COMPILER_NAME = "build_osm_course_package_v5"


def fingerprint() -> str:
    digest = hashlib.sha256()
    for source in (
        Path(v4.__file__),
        Path(v5.__file__),
        Path(__file__),
    ):
        digest.update(source.name.encode("utf-8"))
        digest.update(source.read_bytes())
    return digest.hexdigest()


def main() -> int:
    # Importing V5 replaces V4's model_for_hole with the route-axis-preserving,
    # selected-tee implementation. V4 still owns the stable package writer/CLI.
    v4.model_for_hole = v5.model_for_hole
    result = v4.main()

    args = v4.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    manifest["compiler"] = COMPILER_NAME
    manifest["builderFingerprintSha256"] = fingerprint()
    manifest["registrationNote"] = (
        "Static geometry preserves the cached route-axis orientation, rebases "
        "the origin to a mapped tee, and packages true heading metadata."
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
