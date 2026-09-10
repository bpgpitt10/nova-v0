#!/usr/bin/env python3
"""Shadow-run hazard semantics on saved tee minimap imagery.

Two tracks run in parallel conceptually:
1. legacy whole-image bunker/water CV remains a noisy training baseline;
2. VLM semantics always get a request artifact and, when a model response exists,
   are locally refined into tighter polygons.

Nothing here can block live play or gain strategy authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import cv2
import numpy as np

import bunker_extractor
import hazard_vlm_shadow
import water_extractor


def parse_args():
    p = argparse.ArgumentParser(description="Looper semantic hazard shadow runner")
    p.add_argument("--capture-dir")
    p.add_argument("--image")
    p.add_argument("--hole-model")
    p.add_argument("--min-area-px", type=int, default=12)
    p.add_argument("--corridor", type=float, default=40.0)
    return p.parse_args()


def _candidate_count(mask: np.ndarray, min_area_px: int) -> int:
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    return sum(1 for label in range(1, count) if int(stats[label, cv2.CC_STAT_AREA]) >= int(min_area_px))


def _resolve(args):
    capture = Path(args.capture_dir) if args.capture_dir else None
    model_path = Path(args.hole_model) if args.hole_model else ((capture / "hole_model.json") if capture else None)
    model = None
    if model_path is not None and model_path.exists():
        try:
            model = json.loads(model_path.read_text(encoding="utf-8"))
        except Exception:
            model = None

    if args.image:
        image_path = Path(args.image)
    elif capture:
        candidates = [
            capture / "tee_hazard_safe_minimap.png",
            capture / "tee_canonical_minimap.png",
            capture / "tee_initial_minimap.png",
            capture / "watcher_prelaunch_minimap.png",
            capture / "tee_heatmap_minimap.png",
        ]
        image_path = next((p for p in candidates if p.exists()), None)
    else:
        image_path = None

    if image_path is None or not image_path.exists():
        raise RuntimeError("No saved tee minimap image found for hazard shadow review")

    out = capture or image_path.parent
    out.mkdir(parents=True, exist_ok=True)
    return capture, image_path, model_path, model, out


def _geometry(model):
    if not isinstance(model, dict):
        return None
    minimap = model.get("minimap") or {}
    ball = minimap.get("ball_pixel")
    pin = minimap.get("pin_pixel")
    scale = minimap.get("yards_per_pixel")
    if ball is None or pin is None or scale is None:
        return None
    try:
        scale = float(scale)
    except Exception:
        return None
    return (ball, pin, scale) if 0.03 <= scale <= 3.0 else None


def _write_overlay(path, image, detector_name, result, geom):
    try:
        if detector_name == "bunker":
            overlay = bunker_extractor.draw_debug_overlay(image, result, ball_xy=geom[0] if geom else None, pin_xy=geom[1] if geom else None)
        else:
            overlay = water_extractor.draw_debug_overlay(image, result, ball_xy=geom[0] if geom else None, pin_xy=geom[1] if geom else None)
        cv2.imwrite(str(path), overlay)
    except Exception:
        pass


def _run_bunker(image, out, geom, args):
    candidate_mask = bunker_extractor.sand_candidate_mask(image)
    cv2.imwrite(str(out / "bunker_shadow_candidates_v0.png"), candidate_mask)
    payload = {
        "detector": "bunker-whole-image-v0",
        "role": "legacy-training-baseline-not-primary-semantic-recognizer",
        "status": "candidate-only" if geom is None else "full",
        "trusted_for_strategy": False,
        "candidate_count_without_geometry": _candidate_count(candidate_mask, args.min_area_px),
        "accepted_count": None,
        "objects": [],
        "error": None,
        "artifacts": {"candidate_mask": "bunker_shadow_candidates_v0.png"},
    }
    if geom is None:
        return payload
    try:
        result = bunker_extractor.extract_bunkers(
            image,
            ball_xy=geom[0], pin_xy=geom[1], yards_per_pixel=geom[2],
            corridor_half_width_yds=args.corridor,
            min_confidence=0.45, min_area_px=args.min_area_px,
        )
        cv2.imwrite(str(out / "bunker_shadow_accepted_v0.png"), result.mask)
        _write_overlay(out / "bunker_shadow_overlay_v0.png", image, "bunker", result, geom)
        full = result.to_dict()
        payload.update({
            "status": "full",
            "candidate_count": full.get("candidate_count"),
            "accepted_count": full.get("accepted_count"),
            "objects": full.get("bunker_objects") or [],
            "candidate_diagnostics": full.get("candidate_diagnostics") or [],
            "artifacts": {
                "candidate_mask": "bunker_shadow_candidates_v0.png",
                "accepted_mask": "bunker_shadow_accepted_v0.png",
                "overlay": "bunker_shadow_overlay_v0.png",
            },
        })
    except Exception as exc:
        payload.update({"status": "error", "error": str(exc)})
    return payload


def _run_water(image, out, geom, args):
    candidate_mask = water_extractor.water_candidate_mask(image)
    cv2.imwrite(str(out / "water_shadow_candidates_v0.png"), candidate_mask)
    payload = {
        "detector": "water-whole-image-v0",
        "role": "legacy-training-baseline-not-primary-semantic-recognizer",
        "status": "candidate-only" if geom is None else "full",
        "trusted_for_strategy": False,
        "candidate_count_without_geometry": _candidate_count(candidate_mask, args.min_area_px),
        "accepted_count": None,
        "objects": [],
        "error": None,
        "artifacts": {"candidate_mask": "water_shadow_candidates_v0.png"},
    }
    if geom is None:
        return payload
    try:
        result = water_extractor.extract_water(
            image,
            ball_xy=geom[0], pin_xy=geom[1], yards_per_pixel=geom[2],
            corridor_half_width_yds=args.corridor,
            min_confidence=0.48, min_area_px=args.min_area_px,
        )
        cv2.imwrite(str(out / "water_shadow_accepted_v0.png"), result.mask)
        _write_overlay(out / "water_shadow_overlay_v0.png", image, "water", result, geom)
        full = result.to_dict()
        payload.update({
            "status": "full",
            "candidate_count": full.get("candidate_count"),
            "accepted_count": full.get("accepted_count"),
            "objects": full.get("water_objects") or [],
            "candidate_diagnostics": full.get("candidate_diagnostics") or [],
            "artifacts": {
                "candidate_mask": "water_shadow_candidates_v0.png",
                "accepted_mask": "water_shadow_accepted_v0.png",
                "overlay": "water_shadow_overlay_v0.png",
            },
        })
    except Exception as exc:
        payload.update({"status": "error", "error": str(exc)})
    return payload


def main():
    args = parse_args()
    try:
        capture, image_path, model_path, model, out = _resolve(args)
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"Could not read saved minimap {image_path}")

        geom = _geometry(model)
        bunker = _run_bunker(image, out, geom, args)
        water = _run_water(image, out, geom, args)

        vlm = {"status": "not-run", "strategy_authority": False, "error": None}
        if capture is not None:
            try:
                vlm_payload = hazard_vlm_shadow.run_capture(capture)
                vlm = {
                    "status": vlm_payload.get("status"),
                    "strategy_authority": False,
                    "request_artifact": vlm_payload.get("request_artifact"),
                    "response_artifact": vlm_payload.get("response_artifact"),
                    "objects": vlm_payload.get("objects") or [],
                    "counts": vlm_payload.get("counts"),
                    "error": vlm_payload.get("error"),
                    "artifact": "hazard_vlm_shadow_v0.json",
                }
            except Exception as exc:
                vlm = {"status": "error", "strategy_authority": False, "error": str(exc)}

        payload = {
            "schema_version": "looper-hazard-shadow-v0.1",
            "created_epoch": time.time(),
            "source_image": image_path.name,
            "geometry_mode": "full-hole-model" if geom else "candidate-only-no-hole-geometry",
            "strategy_authority": False,
            "failure_policy": "log-and-continue",
            "primary_semantic_path": "VLM-localization-then-local-CV-refinement",
            "legacy_whole_image_cv_role": "training-baseline-only",
            "bunker": bunker,
            "water": water,
            "vlm": vlm,
        }
        (out / "hazard_shadow_v0.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        if isinstance(model, dict) and model_path is not None and model_path.exists():
            try:
                model = json.loads(model_path.read_text(encoding="utf-8"))
            except Exception:
                pass
            hazards = model.setdefault("hazards", {})
            hazards["shadow_semantics"] = {
                "validation_state": "training-shadow-unvalidated",
                "trusted_for_strategy": False,
                "primary_semantic_path": "VLM-localization-then-local-CV-refinement",
                "source_image": image_path.name,
                "legacy_bunker": bunker,
                "legacy_water": water,
                "vlm": vlm,
                "artifact": "hazard_shadow_v0.json",
            }
            tmp = model_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(model, indent=2), encoding="utf-8")
            tmp.replace(model_path)

        print(
            "Hazard shadow complete | "
            f"legacy bunker={bunker.get('accepted_count')} | "
            f"legacy water={water.get('accepted_count')} | "
            f"VLM={vlm.get('status')} | strategy authority=OFF"
        )
        return 0
    except Exception as exc:
        print(f"Hazard shadow logging error (non-blocking): {exc}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
