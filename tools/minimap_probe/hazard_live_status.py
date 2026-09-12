#!/usr/bin/env python3
"""Small live console for the simulator field build.

Watches tee/approach capture artifacts and prints concise field status. Post-shot
ball placement comes from GSPro world EndingPOS projected through the tee-built
hole_spatial_model_v1.json. Post-shot minimap registration is intentionally not
used for live position authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE / "output"
YARDS_PER_WORLD_UNIT = 1.0936132983377078


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def hole_number_from_context(payload: dict[str, Any]) -> int | None:
    value = payload.get("hole_number")
    if value is None:
        value = ((payload.get("structured_trigger") or {}).get("hole_display"))
    try:
        return int(value) if value is not None else None
    except Exception:
        return None


def hole_label(capture: Path) -> str:
    context = capture / "capture_context.json"
    if not context.is_file():
        return "H?"
    try:
        hole = hole_number_from_context(read_json(context))
        return f"H{hole}" if hole is not None else "H?"
    except Exception:
        return "H?"


def summarize_tee(capture: Path) -> str | None:
    spatial = capture / "hole_spatial_model_v1.json"
    if spatial.is_file():
        payload = read_json(spatial)
        counts = payload.get("hazard_class_counts") or {}
        classes = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none"
        err = (((payload.get("anchors") or {}).get("match") or {}).get("distance_error_yds"))
        err_text = f" | anchor_error={float(err):.2f}yd" if err is not None else ""
        return f"{hole_label(capture)} SPATIAL MODEL READY | {classes} | hazards={payload.get('hazard_count', 0)}{err_text}"

    hazard_map = capture / "hazard_map_shadow_v0.json"
    if not hazard_map.is_file():
        return None
    payload = read_json(hazard_map)
    counts = payload.get("canonical_class_counts") or {}
    classes = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none"
    return f"{hole_label(capture)} HAZARD MAP READY | {classes} | awaiting spatial model"


def newest_dirs(root: Path, prefix: str) -> list[Path]:
    try:
        return sorted(
            [p for p in root.glob(prefix + "*") if p.is_dir()],
            key=lambda p: p.stat().st_mtime,
        )
    except Exception:
        return []


def spatial_model_for_hole(root: Path, hole_display: int | None) -> dict[str, Any] | None:
    if hole_display is None:
        return None
    candidates = newest_dirs(root, "tee_capture_")
    for capture in reversed(candidates):
        path = capture / "hole_spatial_model_v1.json"
        if not path.is_file():
            continue
        try:
            payload = read_json(path)
            ident = payload.get("identity") or {}
            if int(ident.get("hole_display")) == int(hole_display):
                return payload
        except Exception:
            continue
    return None


def world_to_local(model: dict[str, Any], point: dict[str, Any]) -> tuple[float, float]:
    transform = model.get("transform") or {}
    tee = transform.get("tee_world_xz")
    forward_unit = transform.get("world_forward_unit_xz")
    right_unit = transform.get("world_right_unit_xz")
    if not (isinstance(tee, list) and len(tee) == 2 and isinstance(forward_unit, list) and len(forward_unit) == 2 and isinstance(right_unit, list) and len(right_unit) == 2):
        raise ValueError("spatial model lacks world transform")
    dx = float(point["x"]) - float(tee[0])
    dz = float(point["z"]) - float(tee[1])
    lateral = (dx * float(right_unit[0]) + dz * float(right_unit[1])) * YARDS_PER_WORLD_UNIT
    forward = (dx * float(forward_unit[0]) + dz * float(forward_unit[1])) * YARDS_PER_WORLD_UNIT
    return lateral, forward


def summarize_approach(capture: Path, root: Path) -> str | None:
    state_path = capture / "shot_state.json"
    if not state_path.is_file():
        return None
    payload = read_json(state_path)
    pin = payload.get("pin") or {}
    pin_text = "?"
    if pin.get("distance_yds") is not None:
        pin_text = f"{float(pin['distance_yds']):.0f}yd"

    structured = payload.get("structured_current_round") or {}
    hole_display = structured.get("hole_display")
    if hole_display is None:
        context_path = capture / "capture_context.json"
        if context_path.is_file():
            hole_display = hole_number_from_context(read_json(context_path))

    ending = structured.get("ending_pos")
    model = spatial_model_for_hole(root, int(hole_display) if hole_display is not None else None)
    if isinstance(ending, dict) and model is not None:
        try:
            lateral, forward = world_to_local(model, ending)
            position = f"local=({lateral:+.1f}R,{forward:.1f}F)/world"
        except Exception:
            position = "position=unavailable"
    else:
        position = "position=unavailable"

    lie = "lie=ok" if payload.get("lie_slope") is not None else "lie=?"
    return f"SHOT STATE | pin={pin_text} | {position} | {lie}"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Looper live field status console")
    p.add_argument("--output-root", default=str(DEFAULT_ROOT))
    p.add_argument("--poll-ms", type=float, default=450.0)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    seen_tees: set[str] = set()
    seen_approaches: set[str] = set()
    print("Looper LIVE FIELD STATUS | world-position authority | strategy authority OFF")
    print("Waiting for tee/shot artifacts...")
    try:
        while True:
            for capture in newest_dirs(root, "tee_capture_"):
                key = capture.name
                if key in seen_tees:
                    continue
                try:
                    text = summarize_tee(capture)
                    if text:
                        print(text, flush=True)
                        if (capture / "hole_spatial_model_v1.json").is_file():
                            seen_tees.add(key)
                except Exception:
                    pass

            for capture in newest_dirs(root, "approach_capture_"):
                key = capture.name
                if key in seen_approaches:
                    continue
                try:
                    text = summarize_approach(capture, root)
                    if text:
                        print(text, flush=True)
                        seen_approaches.add(key)
                except Exception:
                    pass
            time.sleep(max(0.1, float(args.poll_ms) / 1000.0))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
