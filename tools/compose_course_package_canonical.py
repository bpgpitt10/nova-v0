#!/usr/bin/env python3
"""Canonical V7 geometry + generic terrain composer.

``compose_course_package.py`` predates the V5+ ``coordinateFrame`` contract and
validates terrain against ``coordinateSystem.origin``. This wrapper bridges that
schema seam without changing the persisted static-course schema: it temporarily
aliases each hole's coordinate-frame origin for validation, composes terrain,
then removes only aliases that were not present in the input geometry.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import compose_course_package as base


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--geometry", required=True, type=Path)
    parser.add_argument("--terrain", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    geometry = json.loads(args.geometry.read_text(encoding="utf-8"))
    terrain = json.loads(args.terrain.read_text(encoding="utf-8"))
    holes = geometry.get("holes") or {}
    injected: set[str] = set()
    for key, hole in holes.items():
        if not isinstance(hole, dict):
            continue
        if isinstance(hole.get("coordinateSystem"), dict):
            continue
        frame = hole.get("coordinateFrame") or {}
        origin = frame.get("origin")
        if not isinstance(origin, str) or not origin:
            raise SystemExit(f"H{key}: coordinateFrame.origin is missing")
        hole["coordinateSystem"] = {"origin": origin}
        injected.add(str(key))

    output, report = base.compose(geometry, terrain)
    for key in injected:
        hole = (output.get("holes") or {}).get(key)
        if isinstance(hole, dict):
            hole.pop("coordinateSystem", None)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
