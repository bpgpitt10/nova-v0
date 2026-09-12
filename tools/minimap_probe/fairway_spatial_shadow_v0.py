#!/usr/bin/env python3
"""Project reviewed-candidate fairway pixels into Looper spatial coordinates.

Consumes fairway_surface_shadow_v0.json plus hole_spatial_model_v1.json.  This is
still shadow-only: it makes the geometry comparable to ball positions and hazards but
does not grant strategy authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import hole_spatial_model_v1 as spatial

SCHEMA_VERSION = "looper-fairway-spatial-shadow-v0"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def project(capture: Path) -> dict[str, Any]:
    fairway_path = capture / "fairway_surface_shadow_v0.json"
    spatial_path = capture / "hole_spatial_model_v1.json"
    if not fairway_path.is_file():
        raise FileNotFoundError(f"Missing {fairway_path.name}")
    if not spatial_path.is_file():
        raise FileNotFoundError(f"Missing {spatial_path.name}")
    fairway = read_json(fairway_path)
    model = read_json(spatial_path)
    transform = model.get("transform") or {}
    ident = dict(model.get("identity") or fairway.get("identity") or {})
    out: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "identity": ident,
        "strategy_authority": False,
        "promotion_decision": "none",
        "source_fairway": fairway_path.name,
        "source_spatial_model": spatial_path.name,
        "fairway_present": False,
        "fairway": None,
        "warnings": [],
    }
    surface = fairway.get("fairway")
    if not fairway.get("fairway_present") or not isinstance(surface, dict):
        out["warnings"].append("No accepted shadow fairway polygon to project")
        return out
    points = surface.get("polygon_minimap_pixel") or []
    if len(points) < 3:
        out["warnings"].append("Fairway polygon has fewer than three points")
        return out
    local = []
    world = []
    for raw in points:
        if not isinstance(raw, (list, tuple)) or len(raw) < 2:
            continue
        x, y = float(raw[0]), float(raw[1])
        lateral, forward = spatial.pixel_to_local(transform, x, y)
        wx, wz = spatial.local_to_world(transform, lateral, forward)
        local.append({"lateral_yds": lateral, "forward_yds": forward})
        world.append({"x": wx, "z": wz})
    if len(local) < 3:
        out["warnings"].append("Too few fairway vertices survived projection")
        return out
    lats = [p["lateral_yds"] for p in local]
    fwds = [p["forward_yds"] for p in local]
    out["fairway_present"] = True
    out["fairway"] = {
        "class": "fairway",
        "minimap_points_pixel": [[float(p[0]), float(p[1])] for p in points],
        "hole_local_yards": local,
        "gspro_world_xz": world,
        "bounds_local_yards": {
            "lateral_min": min(lats), "lateral_max": max(lats),
            "forward_min": min(fwds), "forward_max": max(fwds),
        },
        "source_semantic_confidence": surface.get("semantic_confidence"),
        "source_segmentation_quality_score": surface.get("segmentation_quality_score"),
        "source_topology": surface.get("topology"),
        "coordinate_authority": "shadow-fairway-via-hole-spatial-transform",
        "strategy_authority": False,
    }
    return out


def write_capture(capture: Path) -> Path:
    payload = project(capture)
    path = capture / "fairway_spatial_shadow_v0.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Project shadow fairway geometry into Looper hole-local/world coordinates")
    p.add_argument("--capture-dir", action="append", required=True)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    failures = 0
    for raw in args.capture_dir:
        capture = Path(raw).expanduser().resolve()
        try:
            path = write_capture(capture)
            payload = read_json(path)
            print(f"{capture.name}: fairway_spatial={'YES' if payload.get('fairway_present') else 'NO'} | {path.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
