#!/usr/bin/env python3
"""Validate V7 surface precedence on one real imported hole plus a tight fixture."""

from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import Point

import build_osm_course_package_v7 as v7


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "public" / "course-geometry"
MAX_OVERLAP_AREA_SQ_YD = 0.02


def rect(x1: float, y1: float, x2: float, y2: float):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def assert_no_area_overlap(deep, blocker, label: str) -> None:
    overlap = deep.intersection(blocker).area
    assert overlap <= MAX_OVERLAP_AREA_SQ_YD, (
        f"deep-rough overlaps higher-priority {label}: {overlap:.4f} sq yd"
    )


def synthetic_precedence_test() -> None:
    model = {
        "hole": 1,
        "surfaces": {
            "tee": [rect(-4, -5, 4, 5)],
            "fairway": [rect(-10, 0, 10, 100)],
            "rough": [rect(-35, 0, 35, 105)],
            "green": [rect(-9, 90, 9, 110)],
            "bunker": [rect(12, 45, 20, 60)],
            "water": [rect(-30, 55, -18, 75)],
        },
        "context": {
            "woods": [rect(-32, 35, 28, 85)],
            "scrub": [],
        },
    }
    compiled = v7.apply_tactical_surface_semantics(model, simplify_yards=0)
    surfaces = compiled["surfaces"]
    deep = v7._shape_from_serialized(surfaces.get("deep-rough", []))

    assert not deep.is_empty
    assert deep.contains(Point(25, 45)), "woods inside ordinary rough should become deep-rough"
    for kind in ("fairway", "green", "tee", "bunker", "water"):
        assert_no_area_overlap(deep, v7._shape_from_serialized(surfaces[kind]), kind)


def real_candidate():
    for package_path in sorted(PACKAGE_ROOT.glob("*/course-v1.json")):
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        holes = package.get("holes") or {}
        if not isinstance(holes, dict):
            continue
        for hole_key, model in sorted(holes.items(), key=lambda item: int(item[0])):
            if not isinstance(model, dict):
                continue
            surfaces = model.get("surfaces") or {}
            context = model.get("context") or {}
            if not isinstance(surfaces, dict) or not isinstance(context, dict):
                continue
            has_context = bool(context.get("woods") or context.get("scrub"))
            has_bunker = bool(surfaces.get("bunker"))
            has_water = bool(surfaces.get("water") or surfaces.get("penalty"))
            has_fairway = bool(surfaces.get("fairway"))
            has_rough = bool(surfaces.get("rough"))
            if has_context and has_bunker and has_water and has_fairway and has_rough:
                return package_path, str(hole_key), model
    return None


def real_imported_hole_test() -> None:
    candidate = real_candidate()
    assert candidate is not None, (
        "No committed imported hole contains woods/scrub + bunker + water + fairway + rough; "
        "the single-hole acceptance fixture needs a representative package."
    )
    package_path, hole_key, model = candidate
    compiled = v7.apply_tactical_surface_semantics(model, simplify_yards=0.2)
    surfaces = compiled.get("surfaces") or {}
    deep = v7._shape_from_serialized(surfaces.get("deep-rough", []))
    assert not deep.is_empty, "real woods/scrub context did not produce tactical deep-rough"

    for kind in v7.CONTEXT_BLOCKER_SURFACE_KINDS:
        blocker = v7._shape_from_serialized(surfaces.get(kind, []))
        if blocker.is_empty:
            continue
        assert_no_area_overlap(deep, blocker, kind)

    rough = v7._shape_from_serialized(surfaces.get("rough", []))
    rough_overlap = deep.intersection(rough).area if not rough.is_empty else 0.0
    print(
        "Single-hole semantics acceptance:",
        package_path.parent.name,
        f"H{hole_key}",
        f"deep-rough={len(surfaces.get('deep-rough', []))}",
        f"bunker={len(surfaces.get('bunker', []))}",
        f"water={len(surfaces.get('water', []))}",
        f"rough/deep overlap={rough_overlap:.1f} sq yd",
    )


if __name__ == "__main__":
    synthetic_precedence_test()
    real_imported_hole_test()
    print("V7 surface precedence: ok")
