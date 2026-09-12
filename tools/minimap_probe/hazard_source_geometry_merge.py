#!/usr/bin/env python3
"""Merge fresh GKD/Unity archaeology into existing tee HazardGeometry bundles.

Unlike rerunning the whole Step 8 collector, this preserves the saved Luna evidence
from the field run. Course-source geometry is intentionally given course-level
identity only: no capture/hole transform is invented, and Unity remains explicitly
transform-blocked by HazardGeometry.

Only hazard-relevant source semantics are merged. Greens/fairways/tees/terrain and
unknown coordinate structures remain in the archaeology output for review but are
not silently relabeled as generic hazards in this comparison path.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import hazard_geometry_contract as hg

GKD_HAZARD_SEMANTICS = {"bunker_or_sand", "water", "penalty_area", "out_of_bounds", "hazard_unspecified"}
UNITY_HAZARD_SEMANTICS = {"bunker", "water", "penalty", "out_of_bounds"}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def _filtered_payload(path: Path, payload: Any) -> tuple[Any, dict[str, int]]:
    name = path.name.lower()
    if name == "features.json" and isinstance(payload, dict) and isinstance(payload.get("features"), list):
        source = payload["features"]
        kept = [
            row for row in source if isinstance(row, dict)
            and set(row.get("semantic_candidates") or []) & GKD_HAZARD_SEMANTICS
        ]
        return {**payload, "features": kept}, {"input": len(source), "kept": len(kept)}
    if "geometry" in name and isinstance(payload, dict) and isinstance(payload.get("geometry"), list):
        source = payload["geometry"]
        kept = []
        for row in source:
            if not isinstance(row, dict):
                continue
            hits = row.get("seed_semantic_hits") or row.get("semantic_hits") or {}
            keys = set(hits.keys()) if isinstance(hits, dict) else set()
            if keys & UNITY_HAZARD_SEMANTICS:
                kept.append(row)
        return {**payload, "geometry": kept}, {"input": len(source), "kept": len(kept)}
    return payload, {"input": 0, "kept": 0}


def normalize_source(path: Path, identity: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    payload = read_json(path)
    filtered, counts = _filtered_payload(path, payload)
    hint = "gkd" if path.name.lower() == "features.json" else "unity" if "geometry" in path.name.lower() else None
    rows, errors = hg.normalize_payload(filtered, artifact=str(path), source_hint=hint, identity=identity)
    return rows, errors, counts


def merge_capture(capture: Path, source_paths: list[Path], identity: dict[str, Any]) -> dict[str, Any]:
    bundle_path = capture / "hazard_geometry_v0.json"
    if not bundle_path.is_file():
        raise RuntimeError(f"hazard_geometry_v0.json missing in {capture}")
    current = read_json(bundle_path)
    existing = [row for row in current.get("objects") or [] if (row.get("source") or {}).get("kind") not in {"gkd", "unity_asset"}]
    errors = list(current.get("adapter_errors") or [])
    additions: list[dict[str, Any]] = []
    filter_counts: dict[str, dict[str, int]] = {}
    for path in source_paths:
        rows, problems, counts = normalize_source(path, identity)
        additions.extend(rows)
        errors.extend(problems)
        filter_counts[path.name] = counts
    merged = hg.bundle(existing + additions, errors=errors)
    write_json(bundle_path, merged)

    manifest_path = capture / "hazard_field_shadow_v0.json"
    if manifest_path.is_file():
        manifest = read_json(manifest_path)
        manifest.setdefault("source_status", {})["fresh_course_archaeology"] = {
            "status": "merged",
            "artifacts": [str(p) for p in source_paths],
            "filter_counts": filter_counts,
            "geometry_objects": len(additions),
            "course_identity": identity,
            "note": "Hazard semantics only; course-level identity only; no per-hole/capture transform was invented.",
            "strategy_authority": False,
        }
        manifest["object_count"] = merged.get("object_count")
        manifest["class_counts"] = merged.get("class_counts")
        manifest["source_counts"] = merged.get("source_counts")
        manifest["hazard_geometry_bundle"] = bundle_path.name
        manifest["strategy_authority"] = False
        write_json(manifest_path, manifest)

    return {
        "capture": capture.name,
        "source_objects_added": len(additions),
        "filter_counts": filter_counts,
        "bundle_object_count": merged.get("object_count"),
        "source_counts": merged.get("source_counts"),
        "adapter_error_count": len(merged.get("adapter_errors") or []),
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Merge GKD/Unity archaeology into existing HazardGeometry bundles")
    p.add_argument("--capture-dir", action="append", required=True)
    p.add_argument("--source", action="append", required=True)
    p.add_argument("--course-key")
    p.add_argument("--course-name")
    p.add_argument("--round-id")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    captures = [Path(x).expanduser().resolve() for x in args.capture_dir]
    sources = [Path(x).expanduser().resolve() for x in args.source]
    missing = [str(p) for p in sources if not p.is_file()]
    if missing:
        print(f"Missing source archaeology files: {missing}")
        return 1
    identity = {
        "course_key": args.course_key,
        "course_name": args.course_name,
        "round_id": args.round_id,
    }
    identity = {k: v for k, v in identity.items() if v not in (None, "")}

    print("Looper fresh source-geometry merge")
    print("Existing Luna/SAM/red evidence is preserved. Strategy authority: OFF")
    failures = 0
    for capture in captures:
        try:
            row = merge_capture(capture, sources, identity)
            print(
                f"PASS {capture.name} | source_added={row['source_objects_added']} | "
                f"filters={row['filter_counts']} | bundle={row['bundle_object_count']} | {row['source_counts']}"
            )
        except Exception as exc:
            failures += 1
            print(f"FAIL {capture.name} | {type(exc).__name__}: {exc}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
