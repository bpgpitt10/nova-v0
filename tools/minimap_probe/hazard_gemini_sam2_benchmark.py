#!/usr/bin/env python3
"""Benchmark Gemini semantic boxes -> local SAM2 exact masks on saved tee captures.

No GSPro actuation occurs here. This operates only on already-saved capture folders.
All outputs are diagnostic and strategy_authority=False.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import traceback
import zipfile
from typing import Any

import cv2
import numpy as np

import hazard_prompt_segment
import hazard_vlm_contract
import hazard_vlm_gemini_boxes
import hazard_vlm_refine

SCHEMA_VERSION = "looper-hazard-gemini-sam2-benchmark-v0"
IMAGE_ORDER = (
    "tee_hazard_safe_minimap.png",
    "tee_canonical_minimap.png",
    "tee_initial_minimap.png",
    "watcher_prelaunch_minimap.png",
)
HEATMAP_FALLBACK = "tee_heatmap_minimap.png"


def slug(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)


def resolve_image(capture: Path, allow_heatmap: bool = False) -> tuple[Path, str]:
    for name in IMAGE_ORDER:
        path = capture / name
        if path.exists():
            return path, "hazard-safe-preferred"
    heatmap = capture / HEATMAP_FALLBACK
    if allow_heatmap and heatmap.exists():
        return heatmap, "heatmap-fallback-explicitly-allowed"
    if heatmap.exists():
        raise RuntimeError(
            "Only tee_heatmap_minimap.png is available. Step 6 refuses it by default because a prior "
            "field benchmark misclassified green heatmap coloring as water. Use --allow-heatmap only for diagnostics."
        )
    raise RuntimeError("No tee minimap found")


def capture_dirs(root: Path) -> list[Path]:
    if root.is_dir() and root.name.startswith("tee_capture_"):
        return [root]
    try:
        rows = [p for p in root.rglob("tee_capture_*") if p.is_dir()]
    except Exception:
        rows = []
    rows = [p for p in rows if any((p / name).exists() for name in (*IMAGE_ORDER, HEATMAP_FALLBACK))]
    return sorted(rows, key=lambda p: p.stat().st_mtime)


def raster_polygon(poly: list[list[int]], shape: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    if len(poly) >= 3:
        cv2.fillPoly(mask, [np.asarray(poly, dtype=np.int32).reshape((-1, 1, 2))], 1)
    return mask.astype(bool)


def iou(a: np.ndarray, b: np.ndarray) -> float | None:
    a, b = np.asarray(a) > 0, np.asarray(b) > 0
    union = int(np.logical_or(a, b).sum())
    if not union:
        return None
    return int(np.logical_and(a, b).sum()) / union


def compare_to_legacy(image: np.ndarray, hazards: list[hazard_vlm_contract.VlmHazard], sam_payload: dict[str, Any], sam_masks: dict[str, np.ndarray]) -> list[dict[str, Any]]:
    legacy = hazard_vlm_refine.refine_all(image, hazards)
    by_id = {x.hazard_id: x for x in legacy}
    out = []
    h, w = image.shape[:2]
    for row in sam_payload.get("objects", []):
        hid = row["hazard_id"]
        old = by_id.get(hid)
        old_mask = raster_polygon(old.polygon_px, (h, w)) if old else np.zeros((h, w), bool)
        new_mask = sam_masks.get(hid, np.zeros((h, w), bool))
        out.append({
            "hazard_id": hid,
            "hazard_class": row["hazard_class"],
            "sam2_status": row["segmentation_status"],
            "sam2_area_px": int(new_mask.sum()),
            "legacy_refinement_status": old.refinement_status if old else None,
            "legacy_area_px": int(old_mask.sum()),
            "sam2_vs_legacy_iou": iou(new_mask, old_mask),
            "interpretation": "agreement-metric-only; neither source has strategy authority",
        })
    return out


def draw_box_overlay(image: np.ndarray, hazards: list[hazard_vlm_contract.VlmHazard]) -> np.ndarray:
    canvas = image.copy()
    h, w = image.shape[:2]
    for item in hazards:
        x1, y1, x2, y2 = hazard_vlm_contract.bbox_px(item, w, h)
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (255, 255, 255), 1)
        text = f"{item.hazard_class[0].upper()} {item.confidence:.2f}"
        cv2.putText(canvas, text, (max(2, x1), max(13, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(canvas, text, (max(2, x1), max(13, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (255, 255, 255), 1, cv2.LINE_AA)
    return canvas


def process_capture(
    capture: Path,
    backend: hazard_prompt_segment.PromptSegmentationBackend,
    *,
    gemini_model: str,
    thinking_level: str | None,
    timeout_seconds: float,
    allow_heatmap: bool,
    reuse_boxes: bool,
) -> dict[str, Any]:
    started = time.perf_counter()
    image_path, image_policy = resolve_image(capture, allow_heatmap)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")

    model_slug = slug(gemini_model)
    contract_path = capture / f"hazard_vlm_response_{model_slug}_boxes_v0.json"
    raw_path = capture / f"hazard_vlm_provider_raw_{model_slug}_boxes_v0.json"
    meta_path = capture / f"hazard_vlm_meta_{model_slug}_boxes_v0.json"

    if reuse_boxes and contract_path.exists():
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {"reused": True}
        native = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else {}
        gemini_source = "reused-artifact"
    else:
        contract, meta, native = hazard_vlm_gemini_boxes.call_gemini_boxes(
            image_path=image_path,
            model=gemini_model,
            thinking_level=thinking_level,
            timeout_seconds=timeout_seconds,
        )
        contract_path.write_text(json.dumps(contract, indent=2), encoding="utf-8")
        raw_path.write_text(json.dumps(native, indent=2), encoding="utf-8")
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        gemini_source = "fresh-api-call"

    hazards = hazard_vlm_contract.parse_response(contract)
    box_overlay = capture / f"hazard_vlm_boxes_overlay_{model_slug}_v0.png"
    cv2.imwrite(str(box_overlay), draw_box_overlay(image, hazards))

    sam_payload = hazard_prompt_segment.segment_hazards(image, hazards, backend)
    sam_masks = dict(sam_payload.get("_accepted_masks") or {})
    comparison = compare_to_legacy(image, hazards, sam_payload, sam_masks)
    artifacts = hazard_prompt_segment.save_artifacts(capture, image, sam_payload, prefix=f"hazard_sam2_{model_slug}")
    comparison_path = capture / f"hazard_sam2_vs_legacy_{model_slug}_v0.json"
    comparison_path.write_text(json.dumps(comparison, indent=2), encoding="utf-8")

    return {
        "capture": capture.name,
        "capture_path": str(capture),
        "source_image": image_path.name,
        "image_policy": image_policy,
        "gemini_model": gemini_model,
        "gemini_source": gemini_source,
        "gemini_latency_seconds": meta.get("latency_seconds"),
        "gemini_usage_metadata": meta.get("usage_metadata") or {},
        "hazard_counts": meta.get("hazard_counts") or {
            "bunker": sum(x.hazard_class == "bunker" for x in hazards),
            "water": sum(x.hazard_class == "water" for x in hazards),
            "uncertain": sum(x.hazard_class == "uncertain" for x in hazards),
        },
        "sam_backend": sam_payload.get("backend"),
        "sam_model": sam_payload.get("model_id"),
        "sam_device": sam_payload.get("device"),
        "sam_latency_seconds": sam_payload.get("latency_seconds"),
        "sam_accepted": sam_payload.get("accepted_count"),
        "sam_total": sam_payload.get("object_count"),
        "comparison": comparison,
        "artifacts": {
            "gemini_contract": contract_path.name,
            "gemini_raw": raw_path.name,
            "gemini_meta": meta_path.name,
            "box_overlay": box_overlay.name,
            "sam_result": artifacts["result"],
            "sam_overlay": artifacts["overlay"],
            "sam_mask_dir": artifacts["mask_dir"],
            "sam_vs_legacy": comparison_path.name,
        },
        "elapsed_seconds": time.perf_counter() - started,
        "strategy_authority": False,
    }


def make_review_zip(rows: list[dict[str, Any]], output_root: Path, summary_path: Path) -> Path:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = output_root / f"gemini_sam2_hazard_review_{stamp}.zip"
    wanted_names = set()
    for row in rows:
        wanted_names.add(row.get("source_image"))
        wanted_names.update((row.get("artifacts") or {}).values())
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(summary_path, summary_path.name)
        for row in rows:
            capture = Path(row["capture_path"])
            prefix = row["capture"]
            for name in wanted_names:
                if not isinstance(name, str):
                    continue
                candidate = capture / name
                if candidate.is_file():
                    zf.write(candidate, f"{prefix}/{candidate.name}")
                elif candidate.is_dir():
                    for item in candidate.rglob("*"):
                        if item.is_file():
                            zf.write(item, f"{prefix}/{candidate.name}/{item.relative_to(candidate)}")
    return path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Gemini boxes -> local SAM2 hazard benchmark")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--latest", type=int, default=5)
    p.add_argument("--gemini-model", default=hazard_vlm_gemini_boxes.DEFAULT_MODEL)
    p.add_argument("--thinking-level")
    p.add_argument("--sam-model", default=hazard_prompt_segment.DEFAULT_SAM2_MODEL)
    p.add_argument("--device", default="auto")
    p.add_argument("--timeout", type=float, default=90.0)
    p.add_argument("--allow-heatmap", action="store_true")
    p.add_argument("--reuse-boxes", action="store_true")
    p.add_argument("--no-review-zip", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    captures = [Path(x).expanduser().resolve() for x in args.capture_dir]
    if not captures:
        captures = capture_dirs(output_root)[-max(1, args.latest):]
    if not captures:
        print("No saved tee captures found.")
        return 1

    backend = hazard_prompt_segment.Sam2TransformersBackend(args.sam_model, args.device)
    rows = []
    errors = []
    for capture in captures:
        try:
            row = process_capture(
                capture,
                backend,
                gemini_model=args.gemini_model,
                thinking_level=args.thinking_level,
                timeout_seconds=args.timeout,
                allow_heatmap=args.allow_heatmap,
                reuse_boxes=args.reuse_boxes,
            )
            rows.append(row)
            counts = row["hazard_counts"]
            print(f"{capture.name}: Gemini B={counts.get('bunker',0)} W={counts.get('water',0)} U={counts.get('uncertain',0)} | SAM {row['sam_accepted']}/{row['sam_total']} | {row['elapsed_seconds']:.2f}s")
        except Exception as exc:
            errors.append({"capture": str(capture), "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()})
            print(f"{capture.name}: ERR {type(exc).__name__}: {exc}")

    summary = {
        "schema_version": SCHEMA_VERSION,
        "created_epoch": time.time(),
        "gemini_model": args.gemini_model,
        "sam_model": args.sam_model,
        "requested_device": args.device,
        "captures_requested": len(captures),
        "successes": len(rows),
        "failures": len(errors),
        "rows": rows,
        "errors": errors,
        "strategy_authority": False,
    }
    summary_path = output_root / "hazard_gemini_sam2_benchmark_v0.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Benchmark JSON: {summary_path}")
    if not args.no_review_zip and rows:
        review = make_review_zip(rows, output_root, summary_path)
        print(f"Review ZIP: {review}")
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
