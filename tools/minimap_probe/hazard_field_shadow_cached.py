#!/usr/bin/env python3
"""Step 9 wrapper: run Step 8, then replace per-tee course archaeology with cache data.

This wrapper keeps the validated Step 8 worker intact while adding a fail-soft course
cache. Static GKD/Unity analysis is built once per course/version/hash and then reused
for later tee captures. A course-key-only lookup is deliberately diagnostic: without
fresh asset/version evidence we cannot claim the installed course version is exact.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

import course_hazard_cache as chc
import hazard_geometry_contract as hg


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, payload: Any) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _identity(capture: Path) -> tuple[str | None, str | None, dict[str, Any]]:
    context_path = capture / "capture_context.json"
    context: dict[str, Any] = {}
    if context_path.exists():
        try:
            context = _read(context_path)
        except Exception:
            context = {}
    nested = context.get("identity") if isinstance(context.get("identity"), dict) else {}
    course_key = context.get("course_key") or nested.get("course_key")
    course_name = context.get("course_name") or nested.get("course_name")

    # v3 capture_context predates an explicit top-level course_key. Recover it from
    # the watcher state when available instead of changing the validated watcher.
    state_path = context.get("watcher_state_file")
    if state_path and (not course_key or not course_name):
        try:
            state = _read(Path(state_path).expanduser())
            course_key = course_key or state.get("course_key")
            course_name = course_name or state.get("course_name")
            context["course_identity_recovered_from_watcher_state"] = bool(course_key)
        except Exception as exc:
            context["course_identity_recovery_warning"] = str(exc)
    return course_key, course_name, context


def _course_inputs(capture: Path, extras: list[str]) -> list[Path]:
    paths: list[Path] = []
    for name in ("features.json", "geometry_candidates.json"):
        path = capture / name
        if path.is_file():
            paths.append(path)
    paths.extend(Path(value).expanduser() for value in extras)
    unique: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        try:
            resolved = path.resolve()
        except Exception:
            resolved = path
        key = str(resolved)
        if key not in seen and resolved.is_file():
            seen.add(key)
            unique.append(resolved)
    return unique


def _status(result: dict[str, Any], *, built: bool) -> dict[str, Any]:
    manifest = result.get("manifest") or {}
    bundle = result.get("bundle") or {}
    return {
        "status": result.get("status"),
        "cache_action": "build-or-reuse" if built else "lookup",
        "match_mode": result.get("match_mode") or ("exact-analysis-fingerprint" if built else None),
        "entry_dir": result.get("entry_dir"),
        "cache_fingerprint": result.get("cache_fingerprint") or manifest.get("cache_fingerprint"),
        "analysis_fingerprint": result.get("analysis_fingerprint") or manifest.get("analysis_fingerprint"),
        "asset_fingerprint": result.get("asset_fingerprint") or manifest.get("asset_fingerprint"),
        "exact_analysis_match": result.get("exact_analysis_match"),
        "exact_asset_match": bool(result.get("exact_asset_match")),
        "object_count": bundle.get("object_count"),
        "source_counts": bundle.get("source_counts"),
        "strategy_authority": False,
        "per_tee_course_analysis": False,
        "latest_without_asset_fingerprint_is_diagnostic_only": True,
    }


def _apply_cache(capture: Path, result: dict[str, Any], cache_status: dict[str, Any]) -> None:
    bundle_path = capture / "hazard_geometry_v0.json"
    manifest_path = capture / "hazard_field_shadow_v0.json"
    if result.get("status") not in {"hit", "built", "reused"} or not bundle_path.exists():
        if manifest_path.exists():
            manifest = _read(manifest_path)
            manifest.setdefault("source_status", {})["course_cache"] = cache_status
            _write(manifest_path, manifest)
        return

    current = _read(bundle_path)
    cached = result.get("bundle") or {}
    # Step 8 may have directly normalized the same explicitly supplied Step 3/4
    # artifact. Once a valid cache exists, remove those per-tee GKD/Unity copies and
    # replace them with course-only cached objects to avoid identity-based duplicates.
    non_course = [
        row for row in current.get("objects") or []
        if ((row.get("source") or {}).get("kind") not in chc.COURSE_SOURCE_KINDS)
    ]
    merged_errors = list(current.get("adapter_errors") or []) + list(cached.get("adapter_errors") or [])
    merged = hg.bundle(non_course + list(cached.get("objects") or []), errors=merged_errors)
    _write(bundle_path, merged)

    if manifest_path.exists():
        manifest = _read(manifest_path)
        status = manifest.setdefault("source_status", {})
        status["course_cache"] = cache_status
        status["course_artifacts"] = {
            "status": "cache-owned",
            "per_tee_course_analysis": False,
            "cache_match_mode": cache_status.get("match_mode"),
            "exact_asset_match": cache_status.get("exact_asset_match"),
            "note": "GKD/Unity objects in this tee bundle come from the Step 9 course cache.",
        }
        manifest["object_count"] = merged.get("object_count")
        manifest["class_counts"] = merged.get("class_counts")
        manifest["source_counts"] = merged.get("source_counts")
        manifest["adapter_errors"] = merged.get("adapter_errors")
        manifest["step9_course_cache_applied_epoch"] = time.time()
        _write(manifest_path, manifest)

    model_path = capture / "hole_model.json"
    if model_path.exists():
        try:
            model = _read(model_path)
            field_shadow = model.setdefault("hazards", {}).setdefault("field_shadow", {})
            field_shadow.setdefault("source_status", {})["course_cache"] = cache_status
            field_shadow["hazard_geometry_bundle"] = bundle_path.name
            field_shadow["strategy_authority"] = False
            _write(model_path, model)
        except Exception:
            pass


def parse_args() -> tuple[argparse.Namespace, list[str]]:
    p = argparse.ArgumentParser(description="Looper Step 8 + Step 9 cached hazard shadow", add_help=True)
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--course-cache-root", default=str(chc.DEFAULT_ROOT))
    p.add_argument("--course-asset-version")
    p.add_argument("--course-fingerprint-input", action="append", default=[])
    p.add_argument("--extra-input", action="append", default=[])
    return p.parse_known_args()


def main() -> int:
    args, passthrough = parse_args()
    capture = Path(args.capture_dir).expanduser().resolve()
    step8 = Path(__file__).with_name("hazard_field_shadow.py")
    command = [sys.executable, str(step8), "--capture-dir", str(capture)]
    for value in args.extra_input:
        command += ["--extra-input", value]
    command += passthrough

    try:
        completed = subprocess.run(command, cwd=str(step8.parent), check=False)
    except Exception as exc:
        print(f"Step 9 wrapper could not launch Step 8 (non-blocking): {exc}")
        return 0

    # Step 8 itself is fail-soft. If it could not create a capture bundle there is
    # nothing for Step 9 to augment, and the wrapper must stay non-blocking too.
    if not capture.is_dir() or not (capture / "hazard_geometry_v0.json").exists():
        return completed.returncode

    try:
        course_key, course_name, _context = _identity(capture)
        if not course_key and not course_name:
            status = {
                "status": "skipped-course-identity-unavailable",
                "strategy_authority": False,
                "per_tee_course_analysis": False,
            }
            _apply_cache(capture, {}, status)
            return completed.returncode

        inputs = _course_inputs(capture, args.extra_input)
        fingerprint_paths = [Path(value).expanduser().resolve() for value in args.course_fingerprint_input if Path(value).expanduser().is_file()]
        cache_root = Path(args.course_cache_root).expanduser().resolve()
        built = False

        if inputs:
            result = chc.build_cache(
                course_key=course_key,
                course_name=course_name,
                analysis_inputs=inputs,
                cache_root=cache_root,
                asset_version=args.course_asset_version,
                fingerprint_inputs=fingerprint_paths,
            )
            built = True
        elif fingerprint_paths or args.course_asset_version:
            asset_fp, _ = chc.asset_fingerprint(fingerprint_paths, asset_version=args.course_asset_version)
            result = chc.lookup_cache(
                course_key=course_key,
                course_name=course_name,
                cache_root=cache_root,
                asset_fingerprint_value=asset_fp,
            )
        else:
            result = chc.lookup_cache(
                course_key=course_key,
                course_name=course_name,
                cache_root=cache_root,
            )

        cache_status = _status(result, built=built)
        _apply_cache(capture, result, cache_status)
        print(
            "Course hazard cache | "
            f"{cache_status.get('status')} | {cache_status.get('match_mode')} | "
            f"objects={cache_status.get('object_count')} | exact_asset={cache_status.get('exact_asset_match')} | strategy authority=OFF"
        )
    except Exception as exc:
        status = {
            "status": "error-non-blocking",
            "error": f"{type(exc).__name__}: {exc}",
            "strategy_authority": False,
            "per_tee_course_analysis": False,
        }
        try:
            _apply_cache(capture, {}, status)
        except Exception:
            pass
        print(f"Course hazard cache error (non-blocking): {status['error']}")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
