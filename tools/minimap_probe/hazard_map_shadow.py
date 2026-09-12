#!/usr/bin/env python3
"""Build a source-aware, non-authoritative canonical HazardMap from HazardGeometry.

This is the architectural bridge between extraction and live strategy, but remains
shadow-only. It intentionally does NOT invent transforms or promotion thresholds.

For tee minimap hazards:
- SAM2 prompted by the semantic model is preferred for bunker/water edge geometry;
- VLM-localized classical refinement is a fallback edge source;
- the VLM bbox remains semantic/localization evidence;
- deterministic red-boundary CV is the preferred penalty-area geometry source;
- whole-image legacy bunker/water CV is retained only as baseline/corroboration and
  never creates a primary bunker/water object by itself.

GKD and Unity/course-asset geometry are preserved in separate source-geometry layers
until a real field transform/validation makes them comparable to the canonical map.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
from typing import Any

import hazard_geometry_contract as hg

SCHEMA_VERSION = "looper-hazard-map-shadow-v0"
STRATEGY_AUTHORITY = False

PRIMARY_PRIORITY = {
    "sam2": 100,
    "prompt_segmentation": 100,
    "red_penalty_cv": 100,
    "legacy_cv": 70,
    "vlm": 50,
    "gemini_vlm": 50,
}
BASELINE_ONLY = {"legacy_bunker_cv", "legacy_water_cv"}
SOURCE_GEOMETRY = {"gkd", "unity_asset"}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def load_bundle(path: Path) -> list[dict[str, Any]]:
    payload = read_json(path)
    if payload.get("schema_version") != hg.BUNDLE_SCHEMA_VERSION:
        raise ValueError(f"not a HazardGeometry bundle: {path}")
    return [hg.validate_geometry(dict(row)) for row in payload.get("objects") or []]


def source_kind(item: dict[str, Any]) -> str:
    return str((item.get("source") or {}).get("kind") or "unknown")


def source_object_id(item: dict[str, Any]) -> str:
    return str((item.get("source") or {}).get("object_id") or item.get("geometry_id") or "unknown")


def has_space(item: dict[str, Any], space: str) -> bool:
    return any(rep.get("coordinate_space") == space for rep in item.get("representations") or [])


def best_representation(item: dict[str, Any]) -> dict[str, Any] | None:
    reps = list(item.get("representations") or [])
    preferred = [
        ("minimap_normalized", "polygon"),
        ("minimap_normalized", "polyline"),
        ("minimap_pixel", "polygon"),
        ("hole_local_yards", "polygon"),
        ("hole_local_yards", "polyline"),
        ("minimap_normalized", "bbox"),
        ("minimap_pixel", "bbox"),
        ("mask_ref", "mask_ref"),
    ]
    for space, geometry_type in preferred:
        for rep in reps:
            if geometry_type == "mask_ref":
                if rep.get("geometry_type") == "mask_ref":
                    return rep
            elif rep.get("coordinate_space") == space and rep.get("geometry_type") == geometry_type:
                return rep
    return reps[0] if reps else None


def chain_key(item: dict[str, Any]) -> tuple[str, str]:
    return str(item.get("hazard_class")), source_object_id(item)


def choose_primary(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [row for row in rows if source_kind(row) in PRIMARY_PRIORITY]
    if not eligible:
        return None
    eligible.sort(
        key=lambda row: (
            PRIMARY_PRIORITY.get(source_kind(row), 0),
            1 if best_representation(row) and best_representation(row).get("geometry_type") in {"polygon", "polyline"} else 0,
            float((row.get("confidence") or {}).get("geometry") or -1),
            float((row.get("confidence") or {}).get("semantic") or -1),
        ),
        reverse=True,
    )
    return eligible[0]


def summarize_object(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "geometry_id": item.get("geometry_id"),
        "hazard_class": item.get("hazard_class"),
        "source": item.get("source"),
        "confidence": item.get("confidence"),
        "validation": item.get("validation"),
        "representation": best_representation(item),
        "strategy_authority": False,
    }


def build_shadow_map(objects: list[dict[str, Any]], identity: dict[str, Any] | None = None) -> dict[str, Any]:
    identity = dict(identity or {})
    baseline = [row for row in objects if source_kind(row) in BASELINE_ONLY]
    source_geometry = [row for row in objects if source_kind(row) in SOURCE_GEOMETRY]
    active = [row for row in objects if source_kind(row) not in BASELINE_ONLY | SOURCE_GEOMETRY]

    semantic_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    red_groups: list[list[dict[str, Any]]] = []
    other: list[dict[str, Any]] = []
    for row in active:
        kind = source_kind(row)
        cls = str(row.get("hazard_class"))
        if kind == "red_penalty_cv":
            red_groups.append([row])
        elif cls in {"bunker", "water", "uncertain"} and kind in {"sam2", "prompt_segmentation", "legacy_cv", "vlm", "gemini_vlm"}:
            semantic_groups[chain_key(row)].append(row)
        else:
            other.append(row)

    hazards: list[dict[str, Any]] = []
    for (hazard_class, object_id), rows in sorted(semantic_groups.items()):
        primary = choose_primary(rows)
        if primary is None:
            continue
        hazards.append({
            "hazard_key": f"semantic:{hazard_class}:{object_id}",
            "hazard_class": hazard_class,
            "primary": summarize_object(primary),
            "evidence_chain": [summarize_object(row) for row in rows],
            "selection_reason": "SAM2 > VLM-localized classical refinement > VLM bbox; no promotion implied",
            "strategy_authority": False,
        })

    for rows in red_groups:
        primary = rows[0]
        hazards.append({
            "hazard_key": f"red-penalty:{source_object_id(primary)}",
            "hazard_class": "penalty_area",
            "primary": summarize_object(primary),
            "evidence_chain": [summarize_object(primary)],
            "selection_reason": "deterministic GSPro red-boundary CV retained as penalty-area geometry",
            "strategy_authority": False,
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "identity": identity,
        "strategy_authority": False,
        "promotion_decision": "none",
        "canonical_hazard_count": len(hazards),
        "canonical_class_counts": dict(Counter(row["hazard_class"] for row in hazards)),
        "hazards": hazards,
        "source_geometry_candidates": [summarize_object(row) for row in source_geometry],
        "source_geometry_note": "GKD/Unity candidates are preserved but not projected into the minimap without a proven transform.",
        "legacy_baseline": {
            "object_count": len(baseline),
            "source_counts": dict(Counter(source_kind(row) for row in baseline)),
            "class_counts": dict(Counter(str(row.get("hazard_class")) for row in baseline)),
            "role": "diagnostic/corroboration-only; cannot create a canonical primary hazard",
        },
        "unassigned_objects": [summarize_object(row) for row in other],
    }


def identity_from_capture(capture: Path) -> dict[str, Any]:
    context_path = capture / "capture_context.json"
    if not context_path.is_file():
        return {"capture_id": capture.name}
    context = read_json(context_path)
    structured = context.get("structured_trigger") or {}
    return {
        "capture_id": capture.name,
        "course_key": structured.get("course_key"),
        "course_name": context.get("course_name"),
        "round_id": context.get("round_id"),
        "hole_display": context.get("hole_number"),
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build shadow canonical HazardMap from HazardGeometry")
    p.add_argument("--bundle", action="append", default=[])
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--output")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    bundle_paths = [Path(x).expanduser().resolve() for x in args.bundle]
    capture_dirs = [Path(x).expanduser().resolve() for x in args.capture_dir]
    for capture in capture_dirs:
        path = capture / "hazard_geometry_v0.json"
        if path.is_file():
            bundle_paths.append(path)
    if not bundle_paths:
        print("No HazardGeometry bundles supplied.")
        return 1

    outputs = []
    for bundle_path in bundle_paths:
        capture = bundle_path.parent
        objects = load_bundle(bundle_path)
        payload = build_shadow_map(objects, identity_from_capture(capture))
        out = Path(args.output).expanduser().resolve() if args.output and len(bundle_paths) == 1 else capture / "hazard_map_shadow_v0.json"
        write_json(out, payload)
        outputs.append({"capture": capture.name, "output": str(out), "hazards": payload["canonical_hazard_count"], "classes": payload["canonical_class_counts"]})
        print(f"{capture.name}: canonical_shadow={payload['canonical_hazard_count']} {payload['canonical_class_counts']} | baseline={payload['legacy_baseline']['object_count']}")
    print("Strategy authority: OFF | Promotion decision: NONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
