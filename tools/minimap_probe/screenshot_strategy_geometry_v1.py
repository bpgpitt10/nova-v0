#!/usr/bin/env python3
"""Build Looper strategy geometry on top of the original GSPro tee minimap.

Product rule:
- the saved GSPro minimap is visual truth;
- Looper overlays only geometry with an explicit image-space coordinate contract;
- VLM/semantic boxes are evidence, not collision geometry;
- no synthetic course redraw is attempted.

This remains shadow/evaluation tooling.  No GSPro input, no API calls, and no
strategy authority is granted by this file.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import red_penalty_pixel_geometry_v1 as red_pixel

SCHEMA_VERSION = "looper-screenshot-strategy-geometry-v1"
STRATEGY_AUTHORITY = False
MIN_PRECISE_GEOMETRY_CONFIDENCE = 0.50


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def finite(value: Any) -> float | None:
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def _valid_polygon(points: Any, width: int, height: int) -> list[list[float]]:
    if not isinstance(points, list) or len(points) < 3:
        return []
    out: list[list[float]] = []
    for raw in points:
        if isinstance(raw, dict):
            x, y = finite(raw.get("x")), finite(raw.get("y"))
        elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
            x, y = finite(raw[0]), finite(raw[1])
        else:
            return []
        if x is None or y is None or not (0 <= x < width and 0 <= y < height):
            return []
        out.append([x, y])
    return out


def local_to_pixel(model: dict[str, Any], lateral_yds: float, forward_yds: float) -> tuple[float, float]:
    """Project hole-local yards onto the canonical tee screenshot.

    Local lateral is golfer-right positive.  Image coordinates are x-right/y-down,
    so image-right perpendicular is (-forward_y, +forward_x).
    """
    mm = model.get("minimap") or {}
    tee = mm.get("ball_pixel") or {}
    pin = mm.get("pin_pixel") or {}
    scale = finite(mm.get("yards_per_pixel"))
    tx, ty = finite(tee.get("x")), finite(tee.get("y"))
    px, py = finite(pin.get("x")), finite(pin.get("y"))
    if None in (tx, ty, px, py, scale) or float(scale) <= 0:
        raise RuntimeError("HoleModel lacks a valid tee/pin/scale transform")
    dx, dy = float(px) - float(tx), float(py) - float(ty)
    dist = math.hypot(dx, dy)
    if dist <= 1e-6:
        raise RuntimeError("HoleModel tee and pin pixels coincide")
    fx, fy = dx / dist, dy / dist
    rx, ry = -fy, fx
    return (
        float(tx) + (float(forward_yds) * fx + float(lateral_yds) * rx) / float(scale),
        float(ty) + (float(forward_yds) * fy + float(lateral_yds) * ry) / float(scale),
    )


def pixel_to_local(model: dict[str, Any], x: float, y: float) -> tuple[float, float]:
    mm = model.get("minimap") or {}
    tee = mm.get("ball_pixel") or {}
    pin = mm.get("pin_pixel") or {}
    scale = finite(mm.get("yards_per_pixel"))
    tx, ty = finite(tee.get("x")), finite(tee.get("y"))
    px, py = finite(pin.get("x")), finite(pin.get("y"))
    if None in (tx, ty, px, py, scale) or float(scale) <= 0:
        raise RuntimeError("HoleModel lacks a valid tee/pin/scale transform")
    dx, dy = float(px) - float(tx), float(py) - float(ty)
    dist = math.hypot(dx, dy)
    if dist <= 1e-6:
        raise RuntimeError("HoleModel tee and pin pixels coincide")
    fx, fy = dx / dist, dy / dist
    rx, ry = -fy, fx
    qx, qy = float(x) - float(tx), float(y) - float(ty)
    return (qx * rx + qy * ry) * float(scale), (qx * fx + qy * fy) * float(scale)


def _canonical_precise_layers(capture: Path, width: int, height: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Use only canonical in-bounds image polygons as precise collision geometry.

    This intentionally ignores semantic bboxes.  The Greywolf review showed that the
    canonical VLM-localized CV bunker polygons are useful while zero-quality four-point
    rectangles are obvious artifacts.  Geometry confidence < 0.50 therefore remains
    evidence-only in this shadow layer.
    """
    path = capture / "hazard_map_shadow_v0.json"
    if not path.is_file():
        return [], []
    raw = read_json(path)
    precise: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    for hazard in raw.get("hazards") or []:
        if not isinstance(hazard, dict):
            continue
        hazard_class = str(hazard.get("hazard_class") or "")
        if hazard_class not in {"bunker", "water"}:
            continue
        primary = hazard.get("primary") or {}
        rep = primary.get("representation") or {}
        source = primary.get("source") or {}
        confidence = primary.get("confidence") or {}
        geometry_conf = finite(confidence.get("geometry"))
        record = {
            "hazard_class": hazard_class,
            "source": source.get("kind") or source.get("name") or "unknown",
            "source_object_id": source.get("object_id"),
            "semantic_confidence": finite(confidence.get("semantic")),
            "geometry_confidence": geometry_conf,
            "strategy_authority": False,
        }
        if rep.get("geometry_type") != "polygon" or rep.get("coordinate_space") != "minimap_pixel":
            evidence.append(record | {
                "reason": "canonical primary is not a minimap-pixel polygon",
                "geometry_type": rep.get("geometry_type"),
                "coordinate_space": rep.get("coordinate_space"),
            })
            continue
        polygon = _valid_polygon(rep.get("points"), width, height)
        if not polygon:
            evidence.append(record | {"reason": "canonical pixel polygon is missing or out of image bounds"})
            continue
        if geometry_conf is not None and geometry_conf < MIN_PRECISE_GEOMETRY_CONFIDENCE:
            evidence.append(record | {
                "reason": f"geometry confidence below {MIN_PRECISE_GEOMETRY_CONFIDENCE:.2f}",
                "polygon_pixel": polygon,
            })
            continue
        precise.append(record | {
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": polygon,
            "coordinate_authority": "canonical-saved-minimap-polygon",
            "validation_state": "shadow-needs-visual-review",
        })
    return precise, evidence


def _semantic_evidence(capture: Path) -> list[dict[str, Any]]:
    """Preserve semantic detections without pretending boxes are precise edges."""
    path = capture / "hazard_map_shadow_v0.json"
    if not path.is_file():
        return []
    raw = read_json(path)
    out: list[dict[str, Any]] = []
    for hazard in raw.get("hazards") or []:
        primary = hazard.get("primary") or {}
        source = primary.get("source") or {}
        rep = primary.get("representation") or {}
        if rep.get("geometry_type") != "bbox":
            continue
        out.append({
            "hazard_class": hazard.get("hazard_class"),
            "source": source.get("kind") or source.get("name"),
            "geometry_type": "bbox",
            "coordinate_space": rep.get("coordinate_space"),
            "bbox": rep.get("bbox"),
            "role": "semantic-localization-only-not-collision-geometry",
            "strategy_authority": False,
        })
    return out


def build(capture: Path, *, force_red: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    model_path = capture / "hole_model.json"
    if not model_path.is_file():
        raise FileNotFoundError(f"Missing {model_path}")
    model = read_json(model_path)

    red = red_pixel.process_capture(capture, force=force_red)
    image_path = capture / str(red["source_image"])
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")
    height, width = image.shape[:2]

    precise: list[dict[str, Any]] = []
    for row in red.get("objects") or []:
        polygon = _valid_polygon(row.get("polygon_pixel"), width, height)
        if not polygon:
            continue
        precise.append({
            "hazard_class": "penalty_area",
            "source": "red_penalty_cv",
            "source_object_id": row.get("object_id"),
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": polygon,
            "coordinate_authority": "exact-saved-minimap-red-cv",
            "validation_state": "pixel-exact-shadow",
            "strategy_authority": False,
        })

    canonical_precise, rejected_evidence = _canonical_precise_layers(capture, width, height)
    precise.extend(canonical_precise)
    semantic = _semantic_evidence(capture)

    # Draw evaluation overlay.  This is intentionally not a course reconstruction;
    # the original screenshot remains the background.
    overlay = image.copy()
    colors = {
        "penalty_area": (0, 220, 255),  # gold/yellow, distinct from GSPro red
        "bunker": (255, 255, 0),       # cyan
        "water": (255, 170, 50),
    }
    for row in precise:
        pts = np.asarray(row["polygon_pixel"], dtype=np.int32).reshape((-1, 1, 2))
        color = colors.get(str(row.get("hazard_class")), (255, 0, 255))
        cv2.polylines(overlay, [pts], True, color, 2, cv2.LINE_AA)
    overlay_name = "screenshot_strategy_geometry_overlay_v1.png"
    cv2.imwrite(str(capture / overlay_name), overlay)

    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": red.get("identity") or {"capture_id": capture.name},
        "visual_truth": {
            "source_image": image_path.name,
            "image_width": width,
            "image_height": height,
            "policy": "original GSPro tee minimap is the rendered course; Looper does not redraw it",
        },
        "coordinate_transform": {
            "tee_pixel": (model.get("minimap") or {}).get("ball_pixel"),
            "pin_pixel": (model.get("minimap") or {}).get("pin_pixel"),
            "yards_per_pixel": (model.get("minimap") or {}).get("yards_per_pixel"),
            "lateral_axis": "golfer-right-positive",
            "forward_axis": "tee-toward-pin-positive",
        },
        "precise_pixel_geometry": precise,
        "semantic_localization_evidence": semantic,
        "rejected_or_nonprecise_evidence": rejected_evidence,
        "overlay_artifact": overlay_name,
        "strategy_authority": False,
        "promotion_decision": "none",
        "policy": {
            "synthetic_course_redraw": False,
            "semantic_bbox_is_collision_geometry": False,
            "red_boundary_pixel_geometry": True,
            "minimum_precise_geometry_confidence": MIN_PRECISE_GEOMETRY_CONFIDENCE,
        },
    }
    atomic_json(capture / "screenshot_strategy_geometry_v1.json", payload)
    return payload


def discover(root: Path) -> list[Path]:
    return sorted({p.parent for p in root.rglob("hole_model.json") if p.parent.name.startswith("tee_capture_")})


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build screenshot-first Looper strategy geometry from saved tee captures")
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
            ident = payload.get("identity") or {}
            counts: dict[str, int] = {}
            for row in payload.get("precise_pixel_geometry") or []:
                cls = str(row.get("hazard_class"))
                counts[cls] = counts.get(cls, 0) + 1
            print(f"H{ident.get('hole_display','?')} screenshot geometry | {counts} | {capture.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Original GSPro minimap is visual truth. No redraw. No API calls. Strategy authority: OFF")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
