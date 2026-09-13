#!/usr/bin/env python3
"""Clean the isolated OSM proof models after tee selection.

The raw nearest-route association is intentionally generous. Once a GSPro tee is
selected we can remove polygons wholly behind that tee and guarantee that only the
chosen target green survives. This keeps adjacent/back-tee course geometry from
leaking into the strategy model while preserving the raw OSM proof upstream.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from osm_geometry_poc import render_svg

BEHIND_TEE_TOLERANCE_YARDS = 35.0
PAST_GREEN_TOLERANCE_YARDS = 50.0


def polygon_forward_range(feature: dict) -> tuple[float, float]:
    vals = [float(p["forward_yards"]) for p in feature.get("polygon", [])]
    if not vals:
        c = float(feature.get("centroid", {}).get("forward_yards", 0.0))
        return c, c
    return min(vals), max(vals)


def recalc_model(model: dict) -> list[dict]:
    removed: list[dict] = []
    target_green_id = model["anchors"]["target_green_osm_id"]
    target_forward = float(model["anchors"]["tee_to_green_centroid_yards"])
    cleaned: dict[str, list[dict]] = {}

    for golf, group in model.get("features", {}).items():
        kept: list[dict] = []
        for feature in group:
            reason = None
            if golf == "green" and feature.get("osm_id") != target_green_id:
                reason = "non_target_green"
            elif golf != "tee":
                min_f, max_f = polygon_forward_range(feature)
                if max_f < -BEHIND_TEE_TOLERANCE_YARDS:
                    reason = "wholly_behind_selected_tee"
                elif min_f > target_forward + PAST_GREEN_TOLERANCE_YARDS:
                    reason = "wholly_beyond_target_green"
            if reason:
                removed.append(
                    {
                        "golf": golf,
                        "osm_id": feature.get("osm_id"),
                        "reason": reason,
                        "forward_range_yards": [round(x, 1) for x in polygon_forward_range(feature)],
                    }
                )
            else:
                kept.append(feature)
        if kept:
            cleaned[golf] = kept

    model["features"] = cleaned
    all_points: list[tuple[float, float]] = [
        (float(p["right_yards"]), float(p["forward_yards"])) for p in model.get("route", [])
    ]
    for group in cleaned.values():
        for feature in group:
            all_points.extend(
                (float(p["right_yards"]), float(p["forward_yards"]))
                for p in feature.get("polygon", [])
            )
    if all_points:
        model["bounds"] = {
            "min_right_yards": round(min(p[0] for p in all_points), 1),
            "max_right_yards": round(max(p[0] for p in all_points), 1),
            "min_forward_yards": round(min(p[1] for p in all_points), 1),
            "max_forward_yards": round(max(p[1] for p in all_points), 1),
        }

    checks = model.setdefault("checks", {})
    fairways = cleaned.get("fairway", [])
    checks.update(
        {
            "fairway_count": len(fairways),
            "bunker_count": len(cleaned.get("bunker", [])),
            "rough_count": len(cleaned.get("rough", [])),
            "water_count": len(cleaned.get("lateral_water_hazard", [])) + len(cleaned.get("water_hazard", [])),
            "target_green_count": len(cleaned.get("green", [])),
            "static_geometry_ready": bool(fairways and len(cleaned.get("green", [])) == 1 and cleaned.get("tee")),
            "in_play_window": {
                "min_forward_yards": -BEHIND_TEE_TOLERANCE_YARDS,
                "max_forward_yards": round(target_forward + PAST_GREEN_TOLERANCE_YARDS, 1),
            },
        }
    )
    model["cleanup"] = {
        "policy": "selected target green only; drop polygons wholly behind selected tee or wholly beyond target green",
        "removed_feature_count": len(removed),
        "removed": removed,
    }
    return removed


def rebuild_manifest(out_dir: Path, models: list[dict], removed: list[dict]) -> None:
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    totals = Counter()
    for model in models:
        for golf, group in model.get("features", {}).items():
            totals[golf] += len(group)
    manifest["feature_totals_in_play_window"] = dict(sorted(totals.items()))
    manifest["all_holes_static_geometry_ready"] = all(m["checks"]["static_geometry_ready"] for m in models)
    manifest["cleanup"] = {
        "behind_tee_tolerance_yards": BEHIND_TEE_TOLERANCE_YARDS,
        "past_green_tolerance_yards": PAST_GREEN_TOLERANCE_YARDS,
        "removed_feature_count": len(removed),
        "removed": removed,
    }
    manifest["holes"] = [
        {
            "hole": m["hole"],
            "gspro_yards": m["input"]["gspro_tee_to_pin_yards"],
            "osm_tee_green_yards": m["anchors"]["tee_to_green_centroid_yards"],
            "residual_yards": m["anchors"]["gspro_distance_residual_yards"],
            "heading_degrees_true": m["transform"]["heading_degrees_true"],
            "fairways": m["checks"]["fairway_count"],
            "bunkers": m["checks"]["bunker_count"],
            "rough": m["checks"]["rough_count"],
            "water": m["checks"]["water_count"],
            "target_greens": m["checks"]["target_green_count"],
            "removed_out_of_play": m["cleanup"]["removed_feature_count"],
            "ready": m["checks"]["static_geometry_ready"],
        }
        for m in models
    ]
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()

    models: list[dict] = []
    removed_all: list[dict] = []
    for path in sorted(args.out_dir.glob("greywolf-hole-*.json")):
        model = json.loads(path.read_text(encoding="utf-8"))
        removed = recalc_model(model)
        for item in removed:
            removed_all.append({"hole": model["hole"], **item})
        path.write_text(json.dumps(model, indent=2, sort_keys=True), encoding="utf-8")
        render_svg(model, path.with_suffix(".svg"))
        models.append(model)

    if len(models) != 18:
        raise SystemExit(f"Expected 18 models to clean, got {len(models)}")
    rebuild_manifest(args.out_dir, models, removed_all)
    print(json.dumps({"models": 18, "removed": removed_all}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
