#!/usr/bin/env python3
"""Screenshot-first strategy geometry v2.

Extends v1 by consuming the reviewed recall-first bunker layer when available and
long neutral-white OB boundaries from the saved GSPro minimap. The original GSPro
tee minimap remains visual truth. Red penalty pixel geometry remains exact
screenshot-derived geometry. Semantic boxes never become collision geometry.

Offline/read-only. No API calls. No GSPro input. Strategy authority remains off.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import screenshot_strategy_geometry_v1 as v1
import white_boundary_pixel_geometry_v1 as white_boundary

SCHEMA_VERSION = "looper-screenshot-strategy-geometry-v2"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def clamp01(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except Exception:
        return None
    if not math.isfinite(out):
        return None
    return max(0.0, min(1.0, out))


def recall_bunkers(capture: Path, width: int, height: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    path = capture / "bunker_recall_v1.json"
    if not path.is_file():
        return [], [{"reason": "bunker_recall_v1.json unavailable", "strategy_authority": False}]
    raw = read_json(path)
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for row in raw.get("accepted_bunkers") or []:
        poly = v1._valid_polygon(row.get("polygon_pixel"), width, height)
        if not poly:
            rejected.append({
                "source_object_id": row.get("source_object_id"),
                "reason": "recall bunker polygon missing or outside image",
                "strategy_authority": False,
            })
            continue
        accepted.append({
            "hazard_class": "bunker",
            "source": f"bunker_recall_v1:{row.get('source') or 'unknown'}",
            "source_object_id": row.get("source_object_id"),
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": poly,
            "semantic_confidence": clamp01(row.get("semantic_confidence")),
            "geometry_confidence": clamp01(row.get("geometry_confidence")),
            "coordinate_authority": "reviewed-recall-bunker-polygon",
            "validation_state": "greywolf-18-hole-visual-review-shadow",
            "strategy_authority": False,
        })
    return accepted, rejected


def white_boundaries(capture: Path, width: int, height: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw = white_boundary.process_capture(capture)
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for row in raw.get("objects") or []:
        poly = v1._valid_polygon(row.get("polygon_pixel"), width, height)
        if not poly:
            rejected.append({
                "source_object_id": row.get("object_id"),
                "reason": "white boundary polygon missing or outside image",
                "strategy_authority": False,
            })
            continue
        accepted.append({
            "hazard_class": "out_of_bounds",
            "source": "white_boundary_pixel_geometry_v1",
            "source_object_id": row.get("object_id"),
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": poly,
            "coordinate_authority": "exact-saved-minimap-white-pixels",
            "validation_state": "greywolf-18-hole-pixel-topology-shadow",
            "strategy_authority": False,
        })
    return accepted, rejected


def build(capture: Path, *, force_red: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    base = v1.build(capture, force_red=force_red)
    visual = base.get("visual_truth") or {}
    width = int(visual.get("image_width") or 0)
    height = int(visual.get("image_height") or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError("v1 visual truth lacks valid image dimensions")

    # Keep v1 precise geometry except bunkers/OB; v2 owns those selection paths.
    precise = [
        dict(row) for row in (base.get("precise_pixel_geometry") or [])
        if row.get("hazard_class") not in {"bunker", "out_of_bounds"}
    ]
    bunkers, bunker_rejected = recall_bunkers(capture, width, height)
    obs, ob_rejected = white_boundaries(capture, width, height)
    precise.extend(bunkers)
    precise.extend(obs)

    image_path = capture / str(visual.get("source_image"))
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")
    overlay = image.copy()
    colors = {
        "penalty_area": (0, 220, 255),
        "bunker": (255, 255, 0),
        "water": (255, 170, 50),
        "out_of_bounds": (80, 255, 80),
    }
    for row in precise:
        poly = v1._valid_polygon(row.get("polygon_pixel"), width, height)
        if not poly:
            continue
        pts = np.asarray(poly, dtype=np.int32).reshape((-1, 1, 2))
        cv2.polylines(overlay, [pts], True, colors.get(str(row.get("hazard_class")), (255, 0, 255)), 2, cv2.LINE_AA)

    overlay_name = "screenshot_strategy_geometry_overlay_v2.png"
    cv2.imwrite(str(capture / overlay_name), overlay)

    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": base.get("identity") or {"capture_id": capture.name},
        "visual_truth": visual,
        "coordinate_transform": base.get("coordinate_transform") or {},
        "precise_pixel_geometry": precise,
        "semantic_localization_evidence": base.get("semantic_localization_evidence") or [],
        "rejected_or_nonprecise_evidence": (base.get("rejected_or_nonprecise_evidence") or []) + bunker_rejected + ob_rejected,
        "overlay_artifact": overlay_name,
        "strategy_authority": False,
        "promotion_decision": "none",
        "policy": {
            "synthetic_course_redraw": False,
            "original_gspro_minimap_is_visual_truth": True,
            "red_boundary_pixel_geometry": True,
            "bunker_geometry": "bunker_recall_v1 accepted/deduped polygons when available",
            "out_of_bounds_geometry": "long neutral-white screenshot pixel components",
            "semantic_bbox_is_collision_geometry": False,
            "confidence_range": "clamped to [0,1] on v2 ingestion",
        },
    }
    write_json(capture / "screenshot_strategy_geometry_v2.json", payload)
    return payload


def discover(root: Path) -> list[Path]:
    return sorted({p.parent for p in root.rglob("hole_model.json") if p.parent.name.startswith("tee_capture_")})


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build screenshot-first strategy geometry v2")
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--latest", type=int, default=0)
    p.add_argument("--force-red", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    captures = [Path(x).expanduser().resolve() for x in args.capture_dir]
    roots = [Path(x).expanduser().resolve() for x in args.capture_root]
    if not captures and not roots:
        roots = [Path(__file__).resolve().parent / "output"]
    for root in roots:
        if root.exists():
            captures.extend(discover(root))
    captures = sorted(set(captures), key=lambda p: p.name)
    if args.latest > 0:
        captures = captures[-args.latest:]

    failures = 0
    for capture in captures:
        try:
            payload = build(capture, force_red=args.force_red)
            counts: dict[str, int] = {}
            for row in payload.get("precise_pixel_geometry") or []:
                cls = str(row.get("hazard_class"))
                counts[cls] = counts.get(cls, 0) + 1
            ident = payload.get("identity") or {}
            print(f"H{ident.get('hole_display','?')} strategy geometry v2 | {counts} | {capture.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("GSPro screenshot is visual truth. No redraw. No API calls. Strategy authority: OFF")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
