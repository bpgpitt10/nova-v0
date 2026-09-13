#!/usr/bin/env python3
"""Extract exact GSPro red penalty-boundary pixels from a saved tee minimap.

The existing tee probe already measures red boundaries in hole-local yards, but its
PenaltyObject contract intentionally kept only extents/crossings.  That is useful for
strategy math but is not drawable geometry.  This replay keeps the actual red pixels
and simplified contours in the coordinate frame of the saved minimap.

Offline/read-only.  No GSPro input.  No API calls.  Strategy authority remains off.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import probe as base

SCHEMA_VERSION = "looper-red-penalty-pixel-geometry-v1"
STRATEGY_AUTHORITY = False


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def source_image(capture: Path) -> Path:
    # Prefer the hazard-safe normal minimap.  All coordinates remain local to this
    # exact image; do not mix full-screen or differently cropped frames.
    for name in (
        "tee_hazard_safe_minimap.png",
        "tee_canonical_minimap.png",
        "tee_initial_minimap.png",
        "watcher_prelaunch_minimap.png",
    ):
        path = capture / name
        if path.is_file():
            return path
    raise FileNotFoundError(f"No saved normal tee minimap found in {capture}")


def ball_pixel(model: dict[str, Any]) -> tuple[int, int] | None:
    raw = (model.get("minimap") or {}).get("ball_pixel")
    if not isinstance(raw, dict) or raw.get("x") is None or raw.get("y") is None:
        return None
    return round(float(raw["x"])), round(float(raw["y"]))


def _simplified_contour(component: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    # Red boundaries are thin irregular strokes.  Keep more detail than a hazard
    # surface polygon while avoiding thousands of nearly identical vertices.
    epsilon = max(0.35, cv2.arcLength(contour, True) * 0.0015)
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    return [[int(x), int(y)] for x, y in approx[:4000]]


def extract(
    image: np.ndarray,
    *,
    player_xy: tuple[int, int] | None,
    player_mask_radius_px: int = 13,
    min_area_px: int = 20,
    min_span_px: int = 12,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    if image is None or image.size == 0:
        raise ValueError("image is empty")
    mask = base.penalty_mask(image)
    if player_xy is not None:
        cv2.circle(mask, player_xy, int(player_mask_radius_px), 0, -1)

    # One tiny close reconnects anti-aliased gaps without the large yard-scaled
    # dilation used by the measurement extractor.  We want the visible boundary,
    # not a broad envelope.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    objects: list[dict[str, Any]] = []
    object_id = 1
    h, w = mask.shape[:2]
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        bw = int(stats[label, cv2.CC_STAT_WIDTH])
        bh = int(stats[label, cv2.CC_STAT_HEIGHT])
        if area < int(min_area_px) or max(bw, bh) < int(min_span_px):
            continue
        comp = (labels == label).astype(np.uint8) * 255
        contour = _simplified_contour(comp)
        if len(contour) < 3:
            continue
        xs = [p[0] for p in contour]
        ys = [p[1] for p in contour]
        # Coordinate contract invariant: a minimap-pixel contour must be drawable
        # on its named source image.  Never clamp bad coordinates into validity.
        if min(xs) < 0 or min(ys) < 0 or max(xs) >= w or max(ys) >= h:
            continue
        objects.append({
            "object_id": object_id,
            "hazard_class": "penalty_area",
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": contour,
            "bbox_pixel": [min(xs), min(ys), max(xs), max(ys)],
            "area_px": area,
            "component_span_px": [bw, bh],
            "coordinate_authority": "exact-saved-minimap-red-cv",
            "strategy_authority": False,
        })
        object_id += 1
    return mask, objects


def process_capture(capture: Path, *, force: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    out_json = capture / "red_penalty_pixel_geometry_v1.json"
    if out_json.is_file() and not force:
        return read_json(out_json)

    model_path = capture / "hole_model.json"
    model = read_json(model_path) if model_path.is_file() else {}
    image_path = source_image(capture)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")

    player = ball_pixel(model)
    mask, objects = extract(image, player_xy=player)
    mask_name = "red_penalty_pixel_mask_v1.png"
    overlay_name = "red_penalty_pixel_overlay_v1.png"
    cv2.imwrite(str(capture / mask_name), mask)

    overlay = image.copy()
    for row in objects:
        pts = np.asarray(row["polygon_pixel"], dtype=np.int32).reshape((-1, 1, 2))
        cv2.polylines(overlay, [pts], True, (0, 255, 255), 2, cv2.LINE_AA)
    cv2.imwrite(str(capture / overlay_name), overlay)

    identity: dict[str, Any] = {"capture_id": capture.name}
    context = capture / "capture_context.json"
    if context.is_file():
        try:
            raw = read_json(context)
            nested = raw.get("identity") if isinstance(raw.get("identity"), dict) else {}
            identity.update({k: v for k, v in {
                "course_key": raw.get("course_key") or nested.get("course_key"),
                "course_name": raw.get("course_name") or nested.get("course_name"),
                "round_id": raw.get("round_id") or nested.get("round_id"),
                "hole_display": raw.get("hole_number") or nested.get("hole_number"),
            }.items() if v is not None})
        except Exception:
            pass

    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": identity,
        "source_image": image_path.name,
        "image_width": int(image.shape[1]),
        "image_height": int(image.shape[0]),
        "player_marker_masked": player is not None,
        "player_pixel": list(player) if player else None,
        "mask_artifact": mask_name,
        "overlay_artifact": overlay_name,
        "objects": objects,
        "strategy_authority": False,
        "promotion_decision": "none",
        "interpretation": "red pixels are GSPro penalty-boundary evidence; contours describe the boundary stroke, not the entire penalty-area interior",
    }
    atomic_json(out_json, payload)
    return payload


def discover(root: Path) -> list[Path]:
    return sorted({p.parent for p in root.rglob("hole_model.json") if p.parent.name.startswith("tee_capture_")})


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay exact red penalty pixel geometry on saved tee minimaps")
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--latest", type=int, default=0)
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    captures: list[Path] = []
    for raw in args.capture_dir:
        captures.append(Path(raw).expanduser().resolve())
    roots = [Path(x).expanduser().resolve() for x in args.capture_root]
    if not captures and not roots:
        roots = [Path(__file__).resolve().parent / "output"]
    for root in roots:
        if root.exists():
            captures.extend(discover(root))
    captures = sorted({p for p in captures}, key=lambda p: p.name)
    if args.latest > 0:
        captures = captures[-args.latest:]

    failures = 0
    for capture in captures:
        try:
            payload = process_capture(capture, force=args.force)
            hole = (payload.get("identity") or {}).get("hole_display", "?")
            print(f"H{hole} red pixel geometry={len(payload.get('objects') or [])} component(s) | {capture.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("No GSPro input. No API calls. Strategy authority: OFF")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
