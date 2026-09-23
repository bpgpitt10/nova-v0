#!/usr/bin/env python3
"""Validate V7 semantic promotion on one real imported hole plus a tight fixture."""

from __future__ import annotations

import json
from pathlib import Path

import build_osm_course_package_v7 as v7


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "public" / "course-geometry"


def rect(x1: float, y1: float, x2: float, y2: float):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def synthetic_promotion_test() -> None:
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
            "scrub": [rect(22, 10, 34, 25)],
        },
    }
    compiled = v7.apply_tactical_surface_semantics(model)
    surfaces = compiled["surfaces"]

    assert surfaces["deep-rough"] == model["context"]["woods"] + model["context"]["scrub"]
    for kind, polygons in model["surfaces"].items():
        assert surfaces[kind] == polygons, f"V7 changed explicit {kind} geometry"
    assert compiled["context"] == model["context"], "V7 changed source context geometry"
    assert compiled["semanticSurfacePolicy"]["topologyStrategy"] == (
        "preserve-source-polygons-resolve-overlap-at-runtime"
    )


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
    original_surfaces = json.loads(json.dumps(model.get("surfaces") or {}))
    original_context = json.loads(json.dumps(model.get("context") or {}))

    compiled = v7.apply_tactical_surface_semantics(model)
    surfaces = compiled.get("surfaces") or {}
    context = compiled.get("context") or {}
    expected_deep_rough = list(original_context.get("woods") or []) + list(original_context.get("scrub") or [])

    assert expected_deep_rough, "representative hole did not actually contain tactical vegetation"
    assert surfaces.get("deep-rough") == expected_deep_rough
    assert context == original_context, "source context geometry changed during semantic promotion"

    for kind in ("fairway", "rough", "green", "bunker", "water", "penalty", "tee"):
        if kind in original_surfaces:
            assert surfaces.get(kind) == original_surfaces[kind], f"explicit {kind} geometry changed"

    print(
        "Single-hole semantic promotion:",
        package_path.parent.name,
        f"H{hole_key}",
        f"deep-rough={len(surfaces.get('deep-rough', []))}",
        f"bunker={len(surfaces.get('bunker', []))}",
        f"water={len(surfaces.get('water', []))}",
        "explicit geometry preserved",
    )


if __name__ == "__main__":
    synthetic_promotion_test()
    real_imported_hole_test()
    print("V7 semantic promotion: ok")
