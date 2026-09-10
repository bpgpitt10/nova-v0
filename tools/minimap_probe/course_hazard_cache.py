#!/usr/bin/env python3
"""Step 9 course/version/hash cache for Looper hazard archaeology.

The expensive/static side of hazard discovery belongs to the course, not to a tee
capture.  This module fingerprints Step 3/4 analysis artifacts (and, when supplied,
raw course assets/version evidence), normalizes them into HazardGeometry v0 once,
and stores a reusable shadow-only bundle.

Production note: this is field-lab validation tooling.  The hosted looper.golf port
should use browser/server persistence around the same cache contract; it must not
require a Python/PowerShell/Tauri/local-helper install.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any, Iterable

import hazard_geometry_contract as hg

SCHEMA_VERSION = "looper-course-hazard-cache-v0"
DEFAULT_ROOT = Path(__file__).with_name("output") / "course_hazard_cache_v0"
COURSE_SOURCE_KINDS = {"gkd", "unity_asset"}


def _canonical(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str).encode("utf-8")


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _slug(value: str) -> str:
    out = re.sub(r"[^a-z0-9_-]+", "-", str(value).strip().lower()).strip("-")
    return out or "unknown-course"


def _norm_course_name(value: str | None) -> str | None:
    if not value:
        return None
    return " ".join(str(value).strip().lower().split()) or None


def course_id(course_key: str | None, course_name: str | None = None) -> str:
    if course_key and str(course_key).strip():
        return str(course_key).strip().lower()
    name = _norm_course_name(course_name)
    if name:
        return f"name:{name}"
    raise ValueError("course_key or course_name is required")


def infer_source_hint(path: str | Path) -> str | None:
    name = Path(path).name.lower()
    if name == "features.json" or "gkd" in name:
        return "gkd"
    if name == "geometry_candidates.json" or "unity" in name or "geometry" in name:
        return "unity"
    return None


def source_descriptor(path: str | Path, source_hint: str | None = None) -> dict[str, Any]:
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(p)
    return {
        "name": p.name,
        "size_bytes": p.stat().st_size,
        "sha256": _sha256_file(p),
        "source_hint": source_hint or infer_source_hint(p),
        # Absolute paths are provenance only and intentionally excluded from hashes.
        "path": str(p),
    }


def _descriptor_hash_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        [
            {
                "name": row.get("name"),
                "size_bytes": row.get("size_bytes"),
                "sha256": row.get("sha256"),
                "source_hint": row.get("source_hint"),
            }
            for row in rows
        ],
        key=lambda row: (str(row.get("source_hint") or ""), str(row.get("name") or ""), str(row.get("sha256") or "")),
    )


def fingerprint_descriptors(rows: Iterable[dict[str, Any]], *, label: str, version: str | None = None) -> str | None:
    normalized = _descriptor_hash_rows(rows)
    if not normalized and not version:
        return None
    return hashlib.sha256(_canonical({"label": label, "version": version, "files": normalized})).hexdigest()


def analysis_fingerprint(paths: Iterable[str | Path]) -> tuple[str, list[dict[str, Any]]]:
    descriptors = [source_descriptor(path) for path in paths]
    value = fingerprint_descriptors(descriptors, label="analysis")
    if value is None:
        raise ValueError("at least one analysis artifact is required")
    return value, descriptors


def asset_fingerprint(paths: Iterable[str | Path], *, asset_version: str | None = None) -> tuple[str | None, list[dict[str, Any]]]:
    descriptors = [source_descriptor(path, source_hint="course-asset") for path in paths]
    return fingerprint_descriptors(descriptors, label="course-assets", version=asset_version), descriptors


def cache_fingerprint(
    *,
    course_key: str | None,
    course_name: str | None,
    analysis_fp: str,
    asset_fp: str | None,
) -> str:
    cid = course_id(course_key, course_name)
    return hashlib.sha256(_canonical({
        "course_id": cid,
        "analysis_fingerprint": analysis_fp,
        "asset_fingerprint": asset_fp,
        "hazard_geometry_schema": hg.SCHEMA_VERSION,
    })).hexdigest()


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _entry_dir(root: Path, cid: str, fingerprint: str) -> Path:
    return root / _slug(cid) / fingerprint


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _course_identity(course_key: str | None, course_name: str | None) -> dict[str, Any]:
    return {k: v for k, v in {"course_key": course_key, "course_name": course_name}.items() if v}


def build_cache(
    *,
    course_key: str | None,
    course_name: str | None,
    analysis_inputs: Iterable[str | Path],
    cache_root: str | Path = DEFAULT_ROOT,
    asset_version: str | None = None,
    fingerprint_inputs: Iterable[str | Path] = (),
) -> dict[str, Any]:
    analysis_paths = [Path(path).expanduser().resolve() for path in analysis_inputs]
    if not analysis_paths:
        raise ValueError("analysis_inputs cannot be empty")
    asset_paths = [Path(path).expanduser().resolve() for path in fingerprint_inputs]
    analysis_fp, analysis_desc = analysis_fingerprint(analysis_paths)
    asset_fp, asset_desc = asset_fingerprint(asset_paths, asset_version=asset_version)
    cid = course_id(course_key, course_name)
    fingerprint = cache_fingerprint(
        course_key=course_key,
        course_name=course_name,
        analysis_fp=analysis_fp,
        asset_fp=asset_fp,
    )
    root = Path(cache_root).expanduser().resolve()
    entry = _entry_dir(root, cid, fingerprint)
    manifest_path = entry / "course_hazard_cache_manifest.json"
    bundle_path = entry / "hazard_geometry_v0.json"

    if manifest_path.exists() and bundle_path.exists():
        try:
            manifest = _read_json(manifest_path)
            if (
                manifest.get("schema_version") == SCHEMA_VERSION
                and manifest.get("cache_fingerprint") == fingerprint
                and manifest.get("strategy_authority") is False
            ):
                # Validate the stored bundle before declaring reuse.
                stored = _read_json(bundle_path)
                checked = hg.bundle(stored.get("objects") or [], errors=stored.get("adapter_errors") or [])
                return {
                    "status": "reused",
                    "reused": True,
                    "entry_dir": str(entry),
                    "manifest": manifest,
                    "bundle": checked,
                    "cache_fingerprint": fingerprint,
                    "analysis_fingerprint": analysis_fp,
                    "asset_fingerprint": asset_fp,
                    "exact_analysis_match": True,
                    "exact_asset_match": bool(asset_fp),
                }
        except Exception:
            # A malformed partial entry is rebuilt atomically below.
            pass

    objects: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    identity = _course_identity(course_key, course_name)
    artifact_status: list[dict[str, Any]] = []
    for path, descriptor in zip(analysis_paths, analysis_desc):
        before = len(objects)
        try:
            payload = _read_json(path)
            rows, problems = hg.normalize_payload(
                payload,
                artifact=descriptor["name"],
                source_hint=descriptor.get("source_hint"),
                identity=identity,
            )
            objects.extend(rows)
            errors.extend(problems)
            artifact_status.append({
                "name": descriptor["name"],
                "source_hint": descriptor.get("source_hint"),
                "geometry_objects": len(objects) - before,
                "adapter_errors": len(problems),
            })
        except Exception as exc:
            problem = {"artifact": descriptor["name"], "error": f"{type(exc).__name__}: {exc}"}
            errors.append(problem)
            artifact_status.append({
                "name": descriptor["name"],
                "source_hint": descriptor.get("source_hint"),
                "geometry_objects": 0,
                "adapter_errors": 1,
                "error": problem["error"],
            })

    bundle = hg.bundle(objects, errors=errors)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "created_epoch": time.time(),
        "course_id": cid,
        "course_key": course_key,
        "course_name": course_name,
        "cache_fingerprint": fingerprint,
        "analysis_fingerprint": analysis_fp,
        "asset_fingerprint": asset_fp,
        "asset_version": asset_version,
        "exact_asset_identity_available": bool(asset_fp),
        "fingerprint_policy": {
            "absolute_paths_excluded": True,
            "analysis_files": "sha256+size+basename+source-hint",
            "asset_files": "sha256+size+basename plus optional asset_version",
            "asset_hashing": "build/explicit-validation only; never required per tee",
        },
        "analysis_sources": analysis_desc,
        "asset_fingerprint_sources": asset_desc,
        "artifact_status": artifact_status,
        "hazard_geometry_bundle": bundle_path.name,
        "object_count": bundle.get("object_count"),
        "class_counts": bundle.get("class_counts"),
        "source_counts": bundle.get("source_counts"),
        "strategy_authority": False,
        "validation_state": "course-cache-shadow-unvalidated",
        "production_architecture": "field-lab cache contract only; hosted looper.golf remains no-required-local-companion",
    }
    _atomic_json(bundle_path, bundle)
    _atomic_json(manifest_path, manifest)
    return {
        "status": "built",
        "reused": False,
        "entry_dir": str(entry),
        "manifest": manifest,
        "bundle": bundle,
        "cache_fingerprint": fingerprint,
        "analysis_fingerprint": analysis_fp,
        "asset_fingerprint": asset_fp,
        "exact_analysis_match": True,
        "exact_asset_match": bool(asset_fp),
    }


def _manifests_for_course(root: Path, cid: str) -> list[tuple[Path, dict[str, Any]]]:
    course_root = root / _slug(cid)
    if not course_root.is_dir():
        return []
    rows: list[tuple[Path, dict[str, Any]]] = []
    for path in course_root.glob("*/course_hazard_cache_manifest.json"):
        try:
            payload = _read_json(path)
        except Exception:
            continue
        if (
            payload.get("schema_version") == SCHEMA_VERSION
            and payload.get("course_id") == cid
            and payload.get("strategy_authority") is False
        ):
            rows.append((path, payload))
    rows.sort(key=lambda item: (float(item[1].get("created_epoch") or 0.0), item[0].stat().st_mtime), reverse=True)
    return rows


def lookup_cache(
    *,
    course_key: str | None,
    course_name: str | None = None,
    cache_root: str | Path = DEFAULT_ROOT,
    cache_fingerprint_value: str | None = None,
    asset_fingerprint_value: str | None = None,
) -> dict[str, Any]:
    cid = course_id(course_key, course_name)
    root = Path(cache_root).expanduser().resolve()
    rows = _manifests_for_course(root, cid)
    if cache_fingerprint_value:
        rows = [item for item in rows if item[1].get("cache_fingerprint") == cache_fingerprint_value]
        mode = "exact-cache-fingerprint"
        exact_asset = bool(rows and rows[0][1].get("asset_fingerprint"))
    elif asset_fingerprint_value:
        rows = [item for item in rows if item[1].get("asset_fingerprint") == asset_fingerprint_value]
        mode = "exact-asset-fingerprint"
        exact_asset = bool(rows)
    else:
        mode = "course-key-latest-diagnostic"
        exact_asset = False

    if not rows:
        return {
            "status": "miss",
            "course_id": cid,
            "match_mode": mode,
            "exact_asset_match": False,
            "strategy_authority": False,
        }
    manifest_path, manifest = rows[0]
    bundle_path = manifest_path.parent / str(manifest.get("hazard_geometry_bundle") or "hazard_geometry_v0.json")
    if not bundle_path.exists():
        return {
            "status": "miss-bundle-missing",
            "course_id": cid,
            "match_mode": mode,
            "entry_dir": str(manifest_path.parent),
            "exact_asset_match": False,
            "strategy_authority": False,
        }
    bundle = _read_json(bundle_path)
    checked = hg.bundle(bundle.get("objects") or [], errors=bundle.get("adapter_errors") or [])
    return {
        "status": "hit",
        "course_id": cid,
        "match_mode": mode,
        "exact_asset_match": exact_asset,
        "exact_analysis_match": bool(cache_fingerprint_value),
        "strategy_authority": False,
        "entry_dir": str(manifest_path.parent),
        "manifest": manifest,
        "bundle": checked,
        "cache_fingerprint": manifest.get("cache_fingerprint"),
        "analysis_fingerprint": manifest.get("analysis_fingerprint"),
        "asset_fingerprint": manifest.get("asset_fingerprint"),
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Looper Step 9 course hazard cache")
    p.add_argument("--cache-root", default=str(DEFAULT_ROOT))
    sub = p.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="Normalize Step 3/4 outputs once and cache by course/version/hash")
    build.add_argument("--course-key")
    build.add_argument("--course-name")
    build.add_argument("--input", action="append", required=True)
    build.add_argument("--fingerprint-input", action="append", default=[])
    build.add_argument("--asset-version")

    lookup = sub.add_parser("lookup", help="Resolve an exact or latest diagnostic course cache entry")
    lookup.add_argument("--course-key")
    lookup.add_argument("--course-name")
    lookup.add_argument("--cache-fingerprint")
    lookup.add_argument("--asset-fingerprint")
    return p.parse_args()


def _summary(result: dict[str, Any]) -> dict[str, Any]:
    manifest = result.get("manifest") or {}
    bundle = result.get("bundle") or {}
    return {
        "status": result.get("status"),
        "course_id": result.get("course_id") or manifest.get("course_id"),
        "match_mode": result.get("match_mode"),
        "entry_dir": result.get("entry_dir"),
        "cache_fingerprint": result.get("cache_fingerprint"),
        "analysis_fingerprint": result.get("analysis_fingerprint"),
        "asset_fingerprint": result.get("asset_fingerprint"),
        "exact_analysis_match": result.get("exact_analysis_match"),
        "exact_asset_match": result.get("exact_asset_match"),
        "object_count": bundle.get("object_count", manifest.get("object_count")),
        "source_counts": bundle.get("source_counts", manifest.get("source_counts")),
        "strategy_authority": False,
    }


def main() -> int:
    args = parse_args()
    try:
        if args.command == "build":
            result = build_cache(
                course_key=args.course_key,
                course_name=args.course_name,
                analysis_inputs=args.input,
                cache_root=args.cache_root,
                asset_version=args.asset_version,
                fingerprint_inputs=args.fingerprint_input,
            )
        else:
            result = lookup_cache(
                course_key=args.course_key,
                course_name=args.course_name,
                cache_root=args.cache_root,
                cache_fingerprint_value=args.cache_fingerprint,
                asset_fingerprint_value=args.asset_fingerprint,
            )
        print(json.dumps(_summary(result), indent=2))
        return 0 if result.get("status") not in {"miss", "miss-bundle-missing"} else 2
    except Exception as exc:
        print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}", "strategy_authority": False}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
