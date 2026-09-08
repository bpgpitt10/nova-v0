#!/usr/bin/env python3
"""Offline/read-only GSPro bunker probe v0.

Runs on a saved tee capture. It does not focus GSPro, press keys, alter zoom,
or mutate the canonical HoleModel. The output is a review artifact that can be
promoted into tee capture only after field validation.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys

import cv2

import bunker_extractor


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Offline GSPro bunker extractor v0")
    p.add_argument("--capture-dir", help="A tee_capture_* directory containing hole_model.json and a saved minimap.")
    p.add_argument("--image", help="Explicit saved minimap image. Overrides capture-dir image discovery.")
    p.add_argument("--hole-model", help="Explicit hole_model.json. Overrides capture-dir model discovery.")
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    p.add_argument("--corridor", type=float, default=40.0)
    p.add_argument("--min-confidence", type=float, default=0.45)
    p.add_argument("--min-area-px", type=int, default=12)
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def _latest_capture(output_root: Path) -> Path:
    candidates = [
        p for p in output_root.glob("tee_capture_*")
        if p.is_dir() and (p / "hole_model.json").exists()
    ]
    if not candidates:
        raise RuntimeError(f"No tee_capture_* folders with hole_model.json under {output_root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _resolve_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    root = Path(args.output_root)
    capture = Path(args.capture_dir) if args.capture_dir else None
    if capture is None and (not args.image or not args.hole_model):
        capture = _latest_capture(root)

    model_path = Path(args.hole_model) if args.hole_model else capture / "hole_model.json"
    if args.image:
        image_path = Path(args.image)
    else:
        # This is the normal visual geometry restored under transient Y changes.
        preferred = capture / "tee_hazard_safe_minimap.png"
        fallback = capture / "tee_heatmap_minimap.png"
        image_path = preferred if preferred.exists() else fallback

    if not model_path.exists():
        raise RuntimeError(f"HoleModel not found: {model_path}")
    if not image_path.exists():
        raise RuntimeError(f"Saved minimap not found: {image_path}")

    out = capture if capture is not None else image_path.parent
    return image_path, model_path, out


def _load_model(path: Path) -> tuple[dict, dict, dict, float]:
    model = json.loads(path.read_text(encoding="utf-8"))
    minimap = model.get("minimap") or {}
    ball = minimap.get("ball_pixel")
    pin = minimap.get("pin_pixel")
    scale = minimap.get("yards_per_pixel")
    if ball is None or pin is None or scale is None:
        raise RuntimeError("HoleModel is missing minimap.ball_pixel, pin_pixel, or yards_per_pixel")
    return model, ball, pin, float(scale)


def _write_outputs(out: Path, image, result, ball, pin) -> dict:
    mask_path = out / "bunker_mask_v0.png"
    candidates_path = out / "bunker_candidates_v0.png"
    overlay_path = out / "bunker_debug_overlay_v0.png"
    json_path = out / "bunkers_v0.json"
    preview_model_path = out / "hole_model_bunkers_preview_v0.json"

    cv2.imwrite(str(mask_path), result.mask)
    cv2.imwrite(str(candidates_path), result.candidate_mask)
    cv2.imwrite(
        str(overlay_path),
        bunker_extractor.draw_debug_overlay(image, result, ball_xy=ball, pin_xy=pin),
    )
    payload = result.to_dict()
    payload["artifacts"] = {
        "accepted_mask": mask_path.name,
        "candidate_mask": candidates_path.name,
        "debug_overlay": overlay_path.name,
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {
        "payload": payload,
        "json_path": json_path,
        "overlay_path": overlay_path,
        "preview_model_path": preview_model_path,
    }


def _preview_hole_model(model: dict, result, image_path: Path) -> dict:
    preview = json.loads(json.dumps(model))
    hazards = preview.setdefault("hazards", {})
    hazards["bunker_objects"] = [asdict(obj) for obj in result.objects]
    hazards["bunker_source"] = "visual-segmentation:sand-fill-v0"
    hazards["bunker_validation_state"] = "offline-preview-unvalidated"
    hazards["bunker_source_image"] = image_path.name
    # Deliberately keep the original schema_version. This preview is not an
    # integrated tee-capture contract yet.
    return preview


def _side_text(value: float) -> str:
    if abs(value) < 3.0:
        return "center"
    return f"{abs(value):.0f} yd {'right' if value > 0 else 'left'}"


def main() -> int:
    args = parse_args()
    if args.self_test:
        result = bunker_extractor.synthetic_self_test()
        print(json.dumps(result, indent=2))
        return 0 if result.get("pass") else 1

    try:
        image_path, model_path, out = _resolve_inputs(args)
        model, ball, pin, scale = _load_model(model_path)
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"Could not read image: {image_path}")

        result = bunker_extractor.extract_bunkers(
            image,
            ball_xy=ball,
            pin_xy=pin,
            yards_per_pixel=scale,
            corridor_half_width_yds=args.corridor,
            min_confidence=args.min_confidence,
            min_area_px=args.min_area_px,
        )
        written = _write_outputs(out, image, result, ball, pin)
        preview = _preview_hole_model(model, result, image_path)
        written["preview_model_path"].write_text(json.dumps(preview, indent=2), encoding="utf-8")

        if args.json:
            print(json.dumps(written["payload"], indent=2))
            return 0

        print()
        print("GSPro BUNKER IDENTIFICATION PROBE v0")
        print("====================================")
        print("Mode:                  OFFLINE / READ-ONLY")
        print(f"Source minimap:        {image_path}")
        print(f"HoleModel:             {model_path}")
        print(f"Map scale:             {scale:.4f} yd/px")
        print(f"Candidate components:  {result.candidate_count}")
        print(f"Accepted bunkers:      {result.accepted_count}")
        if not result.objects:
            print("  None accepted. Review candidate mask/diagnostics before lowering thresholds.")
        for obj in result.objects:
            corridor = (
                f"corridor {obj.corridor_entry_yds:.0f}-{obj.corridor_exit_yds:.0f} yd"
                if obj.corridor_entry_yds is not None and obj.corridor_exit_yds is not None
                else f"outside +/-{args.corridor:.0f} yd corridor"
            )
            print(
                f"  B{obj.object_id}: conf {obj.confidence:.2f}; "
                f"forward {obj.forward_min_yds:.0f}-{obj.forward_max_yds:.0f} yd; "
                f"{_side_text(obj.median_lateral_yds)}; {corridor}"
            )
        print()
        print(f"JSON:                  {written['json_path']}")
        print(f"Debug overlay:         {written['overlay_path']}")
        print(f"Preview HoleModel:     {written['preview_model_path']}")
        print()
        print("Validation rule: do not integrate into tee capture until the overlay is visually correct on multiple holes.")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
