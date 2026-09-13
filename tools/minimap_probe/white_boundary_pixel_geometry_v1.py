#!/usr/bin/env python3
"""Extract long neutral-white GSPro boundary lines from saved tee minimaps.

Screenshot-first shadow geometry.  The goal is the obvious thick white OB/course
boundary line, not generic bright UI/text/markers.  Long connected components are
retained as exact pixel masks/contours; compact white markers and yardage glyphs are
rejected by topology.  No GSPro input and no strategy authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

SCHEMA_VERSION = "looper-white-boundary-pixel-geometry-v1"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def source_image(capture: Path) -> Path:
    for name in (
        "tee_hazard_safe_minimap.png",
        "tee_canonical_minimap.png",
        "tee_initial_minimap.png",
        "watcher_prelaunch_minimap.png",
        "tee_heatmap_minimap.png",
    ):
        p = capture / name
        if p.is_file():
            return p
    raise FileNotFoundError("No saved tee minimap image found")


def neutral_white_mask(image: np.ndarray) -> np.ndarray:
    b, g, r = cv2.split(image)
    maximum = np.maximum.reduce([b, g, r])
    minimum = np.minimum.reduce([b, g, r])
    chroma = maximum.astype(np.int16) - minimum.astype(np.int16)
    return ((minimum >= 215) & (chroma <= 28)).astype(np.uint8) * 255


def extract_components(image: np.ndarray) -> tuple[np.ndarray, list[dict[str, Any]]]:
    height, width = image.shape[:2]
    mask = neutral_white_mask(image)

    # GSPro HUD occupies the top band; never allow HUD glyphs/icons into geometry.
    hud_cut = max(1, round(height * 0.12))
    mask[:hud_cut, :] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    accepted_mask = np.zeros_like(mask)
    rows: list[dict[str, Any]] = []
    for label in range(1, count):
        x, y, box_w, box_h, area = [int(v) for v in stats[label]]
        if area < 180 or max(box_w, box_h) < 70:
            continue
        extent = area / max(1, box_w * box_h)
        # Compact white circles/markers/text blocks are not boundary lines.
        if extent > 0.55 and min(box_w, box_h) > 35:
            continue
        component = (labels == label).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, max(0.75, perimeter * 0.0015), True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        accepted_mask[labels == label] = 255
        rows.append({
            "object_id": f"white-boundary-{len(rows)+1}",
            "hazard_class": "out_of_bounds",
            "geometry_type": "polygon",
            "coordinate_space": "minimap_pixel",
            "polygon_pixel": [[int(px), int(py)] for px, py in approx[:4000]],
            "bbox_pixel": [x, y, x + box_w, y + box_h],
            "pixel_area": area,
            "bbox_extent": extent,
            "coordinate_authority": "exact-saved-minimap-white-pixels",
            "strategy_authority": False,
        })
    return accepted_mask, rows


def process_capture(capture: Path, *, force: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    out = capture / "white_boundary_pixel_geometry_v1.json"
    if out.is_file() and not force:
        return read_json(out)
    image_path = source_image(capture)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")
    height, width = image.shape[:2]
    mask, objects = extract_components(image)

    mask_name = "white_boundary_pixel_mask_v1.png"
    overlay_name = "white_boundary_pixel_overlay_v1.png"
    cv2.imwrite(str(capture / mask_name), mask)
    overlay = image.copy()
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(overlay, contours, -1, (0, 215, 255), 2, cv2.LINE_AA)
    cv2.imwrite(str(capture / overlay_name), overlay)

    payload = {
        "schema_version": SCHEMA_VERSION,
        "capture_id": capture.name,
        "source_image": image_path.name,
        "image_width": width,
        "image_height": height,
        "object_count": len(objects),
        "objects": objects,
        "mask_artifact": mask_name,
        "overlay_artifact": overlay_name,
        "strategy_authority": False,
        "promotion_decision": "none",
        "policy": {
            "visual_truth": "original-gspro-minimap",
            "semantic_class": "long neutral-white boundary line",
            "hud_mask_fraction": 0.12,
            "compact_white_objects_rejected": True,
        },
    }
    write_json(out, payload)
    return payload


def discover(root: Path) -> list[Path]:
    return sorted({p.parent for p in root.rglob("hole_model.json") if p.parent.name.startswith("tee_capture_")})


def main() -> int:
    p = argparse.ArgumentParser(description="Extract screenshot white boundary geometry")
    p.add_argument("--capture-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--latest", type=int, default=18)
    p.add_argument("--force", action="store_true")
    args = p.parse_args()
    captures = discover(Path(args.capture_root).expanduser().resolve())
    if args.latest > 0:
        captures = captures[-args.latest:]
    failures = 0
    for capture in captures:
        try:
            payload = process_capture(capture, force=args.force)
            print(f"{capture.name} | white_boundaries={payload['object_count']}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("White boundary pixel geometry: shadow only | GSPro input: NONE")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
