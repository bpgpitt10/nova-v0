#!/usr/bin/env python3
"""Rebuild strategy-evaluable fixtures from a saved Geometry Review bundle.

Purpose: Geometry Review HTML already embeds the original GSPro minimap and its
manifest preserves direct screenshot geometry.  This adapter makes those archived
artifacts replayable by the newer strategy-risk tools without requiring GSPro or
the original tee-capture folders.

A watcher log can restore per-hole scale because the tee HoleModel's displayed Pin
target is the tee-to-pin yardage and Geometry Review preserves the same tee/pin
pixel anchors.  Scale is therefore:

    yards_per_pixel = tee_pin_target_yards / tee_pin_pixel_distance

Reviewed bunker-recall polygons can optionally replace the older bunker layer.
White OB geometry is re-extracted from the embedded original screenshot.

Offline/read-only input. No API calls. No GSPro input. Strategy authority OFF.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import white_boundary_pixel_geometry_v1 as white_boundary

SCHEMA_VERSION = "looper-review-strategy-fixture-v0"
_TEE_DISTANCE_RE = re.compile(
    r"Base HoleModel:\s+READY.*?Pin target:\s+([0-9.]+) yd.*?"
    r"Capture folder:\s+[^\r\n]*?(tee_capture_\d+_\d+)",
    re.S,
)
_DATA_PNG_RE = re.compile(r"data:image/png;base64,([A-Za-z0-9+/=]+)")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


def parse_tee_distances(text: str) -> dict[str, float]:
    rows: dict[str, float] = {}
    for distance, capture_id in _TEE_DISTANCE_RE.findall(text):
        value = float(distance)
        if math.isfinite(value) and value > 0:
            rows[capture_id] = value
    return rows


def review_dirs(root: Path) -> dict[str, Path]:
    rows: dict[str, Path] = {}
    for manifest in root.rglob("manifest.json"):
        try:
            payload = read_json(manifest)
        except Exception:
            continue
        capture_id = payload.get("capture_id") or (payload.get("identity") or {}).get("capture_id")
        if capture_id:
            rows[str(capture_id)] = manifest.parent
    return rows


def extract_embedded_actual(review_html: Path) -> np.ndarray:
    text = review_html.read_text(encoding="utf-8", errors="replace")
    matches = _DATA_PNG_RE.findall(text)
    if not matches:
        raise RuntimeError(f"No embedded PNG found in {review_html}")
    raw = base64.b64decode(matches[0])
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not decode embedded GSPro image in {review_html}")
    return image


def coordinate_transform(review: dict[str, Any], tee_pin_yds: float) -> dict[str, Any]:
    anchors = review.get("anchors") or {}
    tee = anchors.get("tee_pixel") or []
    pin = anchors.get("pin_pixel") or []
    if len(tee) < 2 or len(pin) < 2:
        raise ValueError("Geometry Review manifest lacks tee/pin pixel anchors")
    tx, ty = float(tee[0]), float(tee[1])
    px, py = float(pin[0]), float(pin[1])
    pixel_distance = math.hypot(px - tx, py - ty)
    if pixel_distance <= 1e-9:
        raise ValueError("tee/pin pixel anchors coincide")
    distance = float(tee_pin_yds)
    if not math.isfinite(distance) or distance <= 0:
        raise ValueError("tee-to-pin target distance must be > 0")
    return {
        "tee_pixel": {"x": tx, "y": ty},
        "pin_pixel": {"x": px, "y": py},
        "tee_to_pin_pixels": pixel_distance,
        "tee_to_pin_target_yds": distance,
        "yards_per_pixel": distance / pixel_distance,
        "scale_source": "watcher tee Pin target / preserved Geometry Review tee-pin pixels",
    }


def _valid_points(points: Any, width: int, height: int, *, minimum: int) -> list[list[float]]:
    if not isinstance(points, list) or len(points) < minimum:
        return []
    out = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            return []
        try:
            x, y = float(point[0]), float(point[1])
        except Exception:
            return []
        if not math.isfinite(x) or not math.isfinite(y) or x < 0 or y < 0 or x >= width or y >= height:
            return []
        out.append([x, y])
    return out


def recalled_bunkers(bunker_root: Path | None, capture_id: str, width: int, height: int) -> list[dict[str, Any]]:
    if bunker_root is None:
        return []
    path = bunker_root / capture_id / "bunker_recall_v1.json"
    if not path.is_file():
        return []
    raw = read_json(path)
    rows = []
    for index, item in enumerate(raw.get("accepted_bunkers") or []):
        points = _valid_points(item.get("polygon_pixel"), width, height, minimum=3)
        if not points:
            continue
        rows.append({
            "hazard_class": "bunker",
            "source": f"review-bundle:bunker_recall_v1:{item.get('source') or 'unknown'}",
            "source_object_id": item.get("source_object_id") or f"bunker-{index+1}",
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": points,
            "semantic_confidence": clamp01(item.get("semantic_confidence")),
            "geometry_confidence": clamp01(item.get("geometry_confidence")),
            "strategy_authority": False,
        })
    return rows


def review_direct_geometry(review: dict[str, Any], width: int, height: int) -> list[dict[str, Any]]:
    rows = []
    for index, layer in enumerate(review.get("layers") or []):
        cls = str(layer.get("class") or "")
        if cls not in {"penalty_area", "water"}:
            continue
        points = _valid_points(layer.get("direct_points"), width, height, minimum=2)
        if not points:
            continue
        source = layer.get("source") or {}
        rows.append({
            "hazard_class": cls,
            "source": f"review-bundle:{source.get('kind') or 'direct-minimap'}",
            "source_object_id": source.get("object_id") or layer.get("id") or f"{cls}-{index+1}",
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": points,
            "semantic_confidence": clamp01((layer.get("confidence") or {}).get("semantic")),
            "geometry_confidence": clamp01((layer.get("confidence") or {}).get("geometry")),
            "strategy_authority": False,
        })
    return rows


def ob_geometry(image: np.ndarray) -> list[dict[str, Any]]:
    _, objects = white_boundary.extract_components(image)
    rows = []
    for item in objects:
        rows.append({
            "hazard_class": "out_of_bounds",
            "source": "review-bundle:white_boundary_pixel_geometry_v1",
            "source_object_id": item.get("object_id"),
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": item.get("polygon_pixel") or [],
            "strategy_authority": False,
        })
    return rows


def fairway_payload_from_review(review: dict[str, Any], width: int, height: int) -> dict[str, Any] | None:
    candidates = [layer for layer in (review.get("layers") or []) if layer.get("class") == "fairway"]
    for layer in candidates:
        points = _valid_points(layer.get("direct_points"), width, height, minimum=3)
        if not points:
            continue
        confidence = layer.get("confidence") or {}
        source = layer.get("source") or {}
        return {
            "schema_version": "looper-fairway-surface-shadow-v0",
            "identity": review.get("identity") or {"capture_id": review.get("capture_id")},
            "source_image": "gspro_actual.png",
            "fairway_present": True,
            "fairway": {
                "class": "fairway",
                "polygon_minimap_pixel": points,
                "semantic_confidence": clamp01(confidence.get("semantic")),
                "segmentation_quality_score": confidence.get("geometry"),
                "topology": layer.get("validation"),
                "coordinate_authority": "archived-geometry-review-direct-minimap",
                "strategy_authority": False,
            },
            "strategy_authority": False,
            "promotion_decision": "none",
            "provenance": {"source_kind": source.get("kind"), "source_object_id": source.get("object_id")},
        }
    return None


def build_one(
    review: dict[str, Any],
    review_dir: Path,
    *,
    tee_pin_yds: float,
    output_dir: Path,
    bunker_root: Path | None,
) -> dict[str, Any]:
    capture_id = str(review.get("capture_id") or (review.get("identity") or {}).get("capture_id") or "")
    if not capture_id:
        raise ValueError("review lacks capture_id")
    image = extract_embedded_actual(review_dir / "review.html")
    height, width = image.shape[:2]
    output_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_dir / "gspro_actual.png"), image)
    transform = coordinate_transform(review, tee_pin_yds)

    bunkers = recalled_bunkers(bunker_root, capture_id, width, height)
    direct = review_direct_geometry(review, width, height)
    precise = [*bunkers, *direct, *ob_geometry(image)]
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": review.get("identity") or {"capture_id": capture_id},
        "visual_truth": {
            "source_image": "gspro_actual.png",
            "image_width": width,
            "image_height": height,
            "source": "first embedded GSPro Actual PNG from Geometry Review HTML",
        },
        "coordinate_transform": transform,
        "precise_pixel_geometry": precise,
        "strategy_authority": False,
        "promotion_decision": "none",
        "provenance": {
            "geometry_review_capture": capture_id,
            "tee_scale": "watcher log Pin target divided by tee-pin pixel anchor distance",
            "bunker": "accepted bunker_recall_v1 polygons when supplied",
            "penalty_water": "Geometry Review direct-minimap layers",
            "out_of_bounds": "replayed white_boundary_pixel_geometry_v1 on embedded actual image",
        },
    }
    write_json(output_dir / "screenshot_strategy_geometry_v2.json", payload)
    fairway = fairway_payload_from_review(review, width, height)
    if fairway is not None:
        write_json(output_dir / "fairway_surface_shadow_v0.json", fairway)
    return payload


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build strategy fixtures from archived Geometry Review output")
    p.add_argument("--review-root", required=True)
    p.add_argument("--watcher-log", required=True)
    p.add_argument("--output-root", required=True)
    p.add_argument("--bunker-recall-root")
    p.add_argument("--round-id", type=int)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    review_root = Path(args.review_root).expanduser().resolve()
    aggregate = read_json(review_root / "geometry_review_manifest.json")
    dirs = review_dirs(review_root)
    distances = parse_tee_distances(Path(args.watcher_log).expanduser().resolve().read_text(encoding="utf-8", errors="replace"))
    bunker_root = Path(args.bunker_recall_root).expanduser().resolve() if args.bunker_recall_root else None
    output_root = Path(args.output_root).expanduser().resolve()

    built = []
    errors = []
    for review in aggregate.get("reviews") or []:
        identity = review.get("identity") or {}
        if args.round_id is not None and identity.get("round_id") != args.round_id:
            continue
        capture_id = str(review.get("capture_id") or identity.get("capture_id") or "")
        try:
            if capture_id not in dirs:
                raise RuntimeError("review folder unavailable")
            if capture_id not in distances:
                raise RuntimeError("tee Pin target distance unavailable in watcher log")
            hole = identity.get("hole_display")
            name = f"hole_{int(hole):02d}" if hole is not None else capture_id
            payload = build_one(
                review,
                dirs[capture_id],
                tee_pin_yds=distances[capture_id],
                output_dir=output_root / name,
                bunker_root=bunker_root,
            )
            counts: dict[str, int] = {}
            for item in payload.get("precise_pixel_geometry") or []:
                cls = str(item.get("hazard_class"))
                counts[cls] = counts.get(cls, 0) + 1
            built.append({
                "capture_id": capture_id,
                "hole_display": hole,
                "yards_per_pixel": payload["coordinate_transform"]["yards_per_pixel"],
                "geometry_counts": counts,
                "output_dir": name,
            })
            print(f"H{hole or '?'} fixture | scale={payload['coordinate_transform']['yards_per_pixel']:.4f} yd/px | {counts}")
        except Exception as exc:
            errors.append({"capture_id": capture_id, "error": f"{type(exc).__name__}: {exc}"})
            print(f"{capture_id}: ERROR {type(exc).__name__}: {exc}")
    write_json(output_root / "strategy_fixture_manifest_v0.json", {
        "schema_version": SCHEMA_VERSION,
        "review_root": str(review_root),
        "round_id": args.round_id,
        "built": built,
        "errors": errors,
        "strategy_authority": False,
    })
    print(f"Built {len(built)} archived strategy fixtures | errors={len(errors)} | GSPro input: NONE")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
