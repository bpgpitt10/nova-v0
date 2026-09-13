#!/usr/bin/env python3
"""Rebuild strategy-evaluable fixtures from an archived Geometry Review bundle.

Geometry Review HTML embeds the original GSPro minimap and its manifest preserves
direct screenshot geometry. A watcher log restores per-hole scale from the tee Pin
target and preserved tee/pin pixel anchors. Reviewed bunker-recall polygons may
replace the older bunker layer; white OB geometry is replayed from the screenshot.

Offline only. No API calls. No GSPro input. Strategy authority OFF.
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
# Historical capture IDs exist both with and without the final sub-second chunk.
_TEE_DISTANCE_RE = re.compile(
    r"Base HoleModel:\s+READY.*?Pin target:\s+([0-9.]+) yd.*?"
    r"Capture folder:\s+[^\r\n]*?(tee_capture_\d+(?:_\d+){1,2})",
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
    return max(0.0, min(1.0, out)) if math.isfinite(out) else None


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
    matches = _DATA_PNG_RE.findall(review_html.read_text(encoding="utf-8", errors="replace"))
    if not matches:
        raise RuntimeError(f"No embedded PNG found in {review_html}")
    image = cv2.imdecode(np.frombuffer(base64.b64decode(matches[0]), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not decode embedded GSPro image in {review_html}")
    return image


def coordinate_transform(review: dict[str, Any], tee_pin_yds: float) -> dict[str, Any]:
    anchors = review.get("anchors") or {}
    tee, pin = anchors.get("tee_pixel") or [], anchors.get("pin_pixel") or []
    if len(tee) < 2 or len(pin) < 2:
        raise ValueError("Geometry Review manifest lacks tee/pin pixel anchors")
    tx, ty, px, py = float(tee[0]), float(tee[1]), float(pin[0]), float(pin[1])
    pixels = math.hypot(px - tx, py - ty)
    yards = float(tee_pin_yds)
    if pixels <= 1e-9 or not math.isfinite(yards) or yards <= 0:
        raise ValueError("invalid tee/pin scale anchors")
    return {
        "tee_pixel": {"x": tx, "y": ty},
        "pin_pixel": {"x": px, "y": py},
        "tee_to_pin_pixels": pixels,
        "tee_to_pin_target_yds": yards,
        "yards_per_pixel": yards / pixels,
        "scale_source": "watcher tee Pin target / preserved Geometry Review tee-pin pixels",
    }


def _valid_points(points: Any, width: int, height: int, minimum: int) -> list[list[float]]:
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
        if not (math.isfinite(x) and math.isfinite(y) and 0 <= x < width and 0 <= y < height):
            return []
        out.append([x, y])
    return out


def recalled_bunkers(root: Path | None, capture_id: str, width: int, height: int) -> list[dict[str, Any]]:
    path = root / capture_id / "bunker_recall_v1.json" if root else None
    if path is None or not path.is_file():
        return []
    rows = []
    for index, item in enumerate(read_json(path).get("accepted_bunkers") or []):
        polygon = _valid_points(item.get("polygon_pixel"), width, height, 3)
        if polygon:
            rows.append({
                "hazard_class": "bunker",
                "source": f"review-bundle:bunker_recall_v1:{item.get('source') or 'unknown'}",
                "source_object_id": item.get("source_object_id") or f"bunker-{index+1}",
                "geometry_type": "polygon",
                "coordinate_space": "minimap_pixel",
                "polygon_pixel": polygon,
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
        polygon = _valid_points(layer.get("direct_points"), width, height, 2)
        if not polygon:
            continue
        source, confidence = layer.get("source") or {}, layer.get("confidence") or {}
        rows.append({
            "hazard_class": cls,
            "source": f"review-bundle:{source.get('kind') or 'direct-minimap'}",
            "source_object_id": source.get("object_id") or layer.get("id") or f"{cls}-{index+1}",
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": polygon,
            "semantic_confidence": clamp01(confidence.get("semantic")),
            "geometry_confidence": clamp01(confidence.get("geometry")),
            "strategy_authority": False,
        })
    return rows


def ob_geometry(image: np.ndarray) -> list[dict[str, Any]]:
    _, objects = white_boundary.extract_components(image)
    return [{
        "hazard_class": "out_of_bounds",
        "source": "review-bundle:white_boundary_pixel_geometry_v1",
        "source_object_id": item.get("object_id"),
        "geometry_type": "polygon",
        "coordinate_space": "minimap_pixel",
        "polygon_pixel": item.get("polygon_pixel") or [],
        "strategy_authority": False,
    } for item in objects]


def fairway_payload_from_review(review: dict[str, Any], width: int, height: int) -> dict[str, Any] | None:
    for layer in review.get("layers") or []:
        if layer.get("class") != "fairway":
            continue
        polygon = _valid_points(layer.get("direct_points"), width, height, 3)
        if not polygon:
            continue
        confidence, source = layer.get("confidence") or {}, layer.get("source") or {}
        return {
            "schema_version": "looper-fairway-surface-shadow-v0",
            "identity": review.get("identity") or {"capture_id": review.get("capture_id")},
            "source_image": "gspro_actual.png",
            "fairway_present": True,
            "fairway": {
                "class": "fairway",
                "polygon_minimap_pixel": polygon,
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


def build_one(review: dict[str, Any], review_dir: Path, *, tee_pin_yds: float, output_dir: Path,
              bunker_root: Path | None) -> dict[str, Any]:
    capture_id = str(review.get("capture_id") or (review.get("identity") or {}).get("capture_id") or "")
    if not capture_id:
        raise ValueError("review lacks capture_id")
    image = extract_embedded_actual(review_dir / "review.html")
    height, width = image.shape[:2]
    output_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_dir / "gspro_actual.png"), image)
    precise = [
        *recalled_bunkers(bunker_root, capture_id, width, height),
        *review_direct_geometry(review, width, height),
        *ob_geometry(image),
    ]
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": review.get("identity") or {"capture_id": capture_id},
        "visual_truth": {"source_image": "gspro_actual.png", "image_width": width, "image_height": height,
                         "source": "first embedded GSPro Actual PNG from Geometry Review HTML"},
        "coordinate_transform": coordinate_transform(review, tee_pin_yds),
        "precise_pixel_geometry": precise,
        "strategy_authority": False,
        "promotion_decision": "none",
        "provenance": {
            "geometry_review_capture": capture_id,
            "tee_scale": "watcher Pin target / preserved tee-pin pixel distance",
            "bunker": "accepted bunker_recall_v1 polygons when supplied",
            "penalty_water": "Geometry Review direct-minimap layers",
            "out_of_bounds": "white_boundary_pixel_geometry_v1 replayed on embedded actual image",
        },
    }
    write_json(output_dir / "screenshot_strategy_geometry_v2.json", payload)
    fairway = fairway_payload_from_review(review, width, height)
    if fairway:
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
    built, errors = [], []
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
            payload = build_one(review, dirs[capture_id], tee_pin_yds=distances[capture_id],
                                output_dir=output_root / name, bunker_root=bunker_root)
            counts: dict[str, int] = {}
            for item in payload.get("precise_pixel_geometry") or []:
                cls = str(item.get("hazard_class")); counts[cls] = counts.get(cls, 0) + 1
            built.append({"capture_id": capture_id, "hole_display": hole,
                          "yards_per_pixel": payload["coordinate_transform"]["yards_per_pixel"],
                          "geometry_counts": counts, "output_dir": name})
            print(f"H{hole or '?'} fixture | scale={payload['coordinate_transform']['yards_per_pixel']:.4f} yd/px | {counts}")
        except Exception as exc:
            errors.append({"capture_id": capture_id, "error": f"{type(exc).__name__}: {exc}"})
            print(f"{capture_id}: ERROR {type(exc).__name__}: {exc}")
    write_json(output_root / "strategy_fixture_manifest_v0.json", {
        "schema_version": SCHEMA_VERSION, "review_root": str(review_root), "round_id": args.round_id,
        "built": built, "errors": errors, "strategy_authority": False,
    })
    print(f"Built {len(built)} archived strategy fixtures | errors={len(errors)} | GSPro input: NONE")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
