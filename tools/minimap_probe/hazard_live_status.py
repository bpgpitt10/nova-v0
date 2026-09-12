#!/usr/bin/env python3
"""Small live console for the simulator field build.

Watches the existing tee/approach capture artifacts and prints one concise status line
when new usable evidence becomes available. It does not touch GSPro, call an API, or
make strategy decisions. The goal is simply to make the field pipeline visible while
playing instead of forcing the user to inspect JSON folders.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE / "output"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def hole_label(capture: Path) -> str:
    context = capture / "capture_context.json"
    if not context.is_file():
        return "H?"
    try:
        payload = read_json(context)
        hole = payload.get("hole_number")
        if hole is None:
            hole = ((payload.get("structured_trigger") or {}).get("hole_display"))
        return f"H{int(hole)}" if hole is not None else "H?"
    except Exception:
        return "H?"


def summarize_tee(capture: Path) -> str | None:
    hazard_map = capture / "hazard_map_shadow_v0.json"
    if not hazard_map.is_file():
        return None
    payload = read_json(hazard_map)
    counts = payload.get("canonical_class_counts") or {}
    classes = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none"
    source_counts: dict[str, int] = {}
    for hazard in payload.get("hazards") or []:
        source = (((hazard.get("primary") or {}).get("source") or {}).get("kind")) or "unknown"
        source_counts[source] = source_counts.get(source, 0) + 1
    sources = ", ".join(f"{k}={v}" for k, v in sorted(source_counts.items())) or "none"
    return f"{hole_label(capture)} HAZARD MAP READY | {classes} | primary {sources} | SHADOW"


def summarize_approach(capture: Path) -> str | None:
    state_path = capture / "shot_state.json"
    if not state_path.is_file():
        return None
    payload = read_json(state_path)
    pin = payload.get("pin") or {}
    pin_text = "?"
    if pin.get("distance_yds") is not None:
        pin_text = f"{float(pin['distance_yds']):.0f}yd"

    aim = payload.get("aim") or {}
    aim_meta = payload.get("aim_sensor") or {}
    aim_text = "unavailable"
    if aim.get("distance_yds") is not None:
        mode = ((aim_meta.get("acquisition") or {}).get("mode") or (aim_meta.get("acquisition") or {}).get("status") or "read")
        aim_text = f"{float(aim['distance_yds']):.0f}yd/{mode}"

    geometry = payload.get("canonical_geometry") or {}
    pos = geometry.get("canonical_position") or {}
    if payload.get("canonical_geometry_trusted") and pos:
        try:
            lateral = float(pos.get("tee_relative_lateral_yds"))
            forward = float(pos.get("tee_relative_forward_yds"))
            position = f"local=({lateral:+.1f}R,{forward:.1f}F)"
        except Exception:
            position = "geometry=trusted"
    else:
        position = "geometry=unavailable"

    lie = "lie=ok" if payload.get("lie_slope") is not None else "lie=?"
    return f"SHOT STATE | pin={pin_text} | aim={aim_text} | {position} | {lie}"


def newest_dirs(root: Path, prefix: str) -> list[Path]:
    try:
        return sorted(
            [p for p in root.glob(prefix + "*") if p.is_dir()],
            key=lambda p: p.stat().st_mtime,
        )
    except Exception:
        return []


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
    print("Looper LIVE FIELD STATUS | passive observer | strategy authority OFF")
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
                        seen_tees.add(key)
                except Exception:
                    pass

            for capture in newest_dirs(root, "approach_capture_"):
                key = capture.name
                if key in seen_approaches:
                    continue
                try:
                    text = summarize_approach(capture)
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
