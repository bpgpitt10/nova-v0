#!/usr/bin/env python3
"""Bind terrain source-quality proof and validation to a cached terrain manifest."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()

    config = read_json(args.config)
    proof = read_json(args.proof)
    validation = read_json(args.validation)
    package = read_json(args.package)
    cache = read_json(args.cache)

    course_id = config["courseId"]
    provider = (config.get("terrain") or {}).get("provider")
    for label, payload in (("proof", proof), ("validation", validation), ("package", package), ("cache", cache)):
        if payload.get("courseId") != course_id:
            raise SystemExit(f"{label} courseId mismatch: {payload.get('courseId')} != {course_id}")
    if proof.get("provider") != provider or validation.get("provider") != provider or cache.get("provider") != provider:
        raise SystemExit("terrain provider mismatch across config/proof/validation/cache")
    if proof.get("passed") is not True:
        raise SystemExit("terrain source-quality proof did not pass")
    if validation.get("allHolesTerrainReady") is not True or validation.get("readyHoleCount") != 18:
        raise SystemExit("terrain validation is not 18/18 ready")
    if package.get("schemaVersion") != "looper-course-terrain-v1" or len(package.get("holes") or {}) != 18:
        raise SystemExit("terrain package schema/hole count is invalid")

    package_sha = sha256_file(args.package)
    if cache.get("terrainPackageSha256") != package_sha:
        raise SystemExit("terrain package hash does not match cache manifest")

    cache["sourceProofPath"] = str(args.proof)
    cache["sourceProofSha256"] = sha256_file(args.proof)
    cache["sourceProofSchemaVersion"] = proof.get("schemaVersion")
    cache["sourceProofVerifiedAt"] = proof.get("verifiedAt")
    cache["validationSha256"] = sha256_file(args.validation)
    cache["qualityGate"] = {
        "sourceProofPassed": True,
        "allHolesTerrainReady": True,
        "readyHoleCount": 18,
    }
    args.cache.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "courseId": course_id,
        "provider": provider,
        "packageSha256": package_sha,
        "sourceProofSha256": cache["sourceProofSha256"],
        "validationSha256": cache["validationSha256"],
        "qualityGate": cache["qualityGate"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
