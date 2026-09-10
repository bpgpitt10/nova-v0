#!/usr/bin/env python3
"""Prepare/consume VLM hazard semantics for a saved tee capture.

Provider-neutral by design. Every invocation writes the request artifact. If a
response JSON exists, it is validated and locally refined into polygons. Nothing
in v0 has strategy authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import cv2

import hazard_vlm_contract
import hazard_vlm_refine


def parse_args():
    p = argparse.ArgumentParser(description="Looper VLM hazard shadow contract v0")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--response-json")
    return p.parse_args()


def _resolve_image(capture: Path):
    for name in (
        "tee_hazard_safe_minimap.png",
        "tee_canonical_minimap.png",
        "tee_initial_minimap.png",
        "watcher_prelaunch_minimap.png",
        "tee_heatmap_minimap.png",
    ):
        path = capture / name
        if path.exists():
            return path
    raise RuntimeError("No tee minimap found")


def _geometry(capture: Path):
    model_path = capture / "hole_model.json"
    if not model_path.exists():
        return None, None
    try:
        model = json.loads(model_path.read_text(encoding="utf-8"))
        minimap = model.get("minimap") or {}
        ball = minimap.get("ball_pixel")
        pin = minimap.get("pin_pixel")
        scale = minimap.get("yards_per_pixel")
        if ball is None or pin is None or scale is None:
            return model, None
        return model, (ball, pin, float(scale))
    except Exception:
        return None, None


def run_capture(capture_dir: str | Path, response_json: str | Path | None = None) -> dict:
    capture = Path(capture_dir)
    image_path = _resolve_image(capture)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")
    h, w = image.shape[:2]

    request_path = capture / "hazard_vlm_request_v0.json"
    hazard_vlm_contract.write_request(
        request_path,
        source_image=image_path.name,
        width=w,
        height=h,
    )

    response_path = Path(response_json) if response_json else capture / "hazard_vlm_response_v0.json"
    payload = {
        "schema_version": "looper-hazard-vlm-shadow-v0",
        "created_epoch": time.time(),
        "strategy_authority": False,
        "source_image": image_path.name,
        "request_artifact": request_path.name,
        "response_artifact": response_path.name if response_path.exists() else None,
        "status": "awaiting-vlm-response",
        "objects": [],
        "error": None,
    }

    if response_path.exists():
        hazards = hazard_vlm_contract.parse_response(response_path)
        model, geom = _geometry(capture)
        if geom:
            ball, pin, scale = geom
        else:
            ball = pin = scale = None
        refined = hazard_vlm_refine.refine_all(
            image, hazards,
            ball_xy=ball, pin_xy=pin, yards_per_pixel=scale,
        )
        payload["status"] = "refined-shadow"
        payload["objects"] = [item.to_dict() for item in refined]
        payload["counts"] = {
            "bunker": sum(1 for x in hazards if x.hazard_class == "bunker"),
            "water": sum(1 for x in hazards if x.hazard_class == "water"),
            "uncertain": sum(1 for x in hazards if x.hazard_class == "uncertain"),
        }
        cv2.imwrite(str(capture / "hazard_vlm_overlay_v0.png"), hazard_vlm_refine.draw_overlay(image, refined))
        payload["overlay_artifact"] = "hazard_vlm_overlay_v0.png"

        if isinstance(model, dict):
            hazards_model = model.setdefault("hazards", {})
            hazards_model["vlm_shadow_semantics"] = {
                "validation_state": "vlm-shadow-unvalidated",
                "trusted_for_strategy": False,
                "source_image": image_path.name,
                "objects": payload["objects"],
                "artifact": "hazard_vlm_shadow_v0.json",
            }
            tmp = capture / "hole_model.json.tmp"
            tmp.write_text(json.dumps(model, indent=2), encoding="utf-8")
            tmp.replace(capture / "hole_model.json")

    (capture / "hazard_vlm_shadow_v0.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main():
    args = parse_args()
    capture = Path(args.capture_dir)
    try:
        payload = run_capture(capture, args.response_json)
        print(
            f"VLM hazard shadow: {payload['status']} | "
            f"request={payload['request_artifact']} | strategy authority=OFF"
        )
        return 0
    except Exception as exc:
        try:
            (capture / "hazard_vlm_shadow_v0.json").write_text(
                json.dumps({
                    "schema_version": "looper-hazard-vlm-shadow-v0",
                    "created_epoch": time.time(),
                    "strategy_authority": False,
                    "status": "error",
                    "error": str(exc),
                }, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        print(f"VLM hazard shadow error (non-blocking): {exc}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
