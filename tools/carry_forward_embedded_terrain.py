#!/usr/bin/env python3
"""Carry embedded LiDAR/contours from an old route-start package into V5.

V5 intentionally preserves the old route-start axis orientation and changes
only the origin. Therefore the existing DEM values need no resampling: grid
minX/minY and contour points are translated by the selected-tee offset.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any


def finite_pair(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, list) or len(value) < 2:
        return None
    x, y = value[0], value[1]
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    return float(x), float(y)


def translated_contours(contours: Any, offset: tuple[float, float]) -> list[dict[str, Any]]:
    if not isinstance(contours, list):
        return []
    output: list[dict[str, Any]] = []
    for contour in contours:
        if not isinstance(contour, dict) or not isinstance(contour.get("points"), list):
            continue
        copied = copy.deepcopy(contour)
        translated = []
        for point in copied["points"]:
            pair = finite_pair(point)
            if pair is None:
                continue
            translated.append([round(pair[0] - offset[0], 3), round(pair[1] - offset[1], 3)])
        if len(translated) >= 2:
            copied["points"] = translated
            output.append(copied)
    return output


def carry(old_package: dict[str, Any], new_package: dict[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(new_package)
    old_holes = old_package.get("holes")
    new_holes = output.get("holes")
    if not isinstance(old_holes, dict) or not isinstance(new_holes, dict):
        raise ValueError("Both packages must contain holes objects")

    copied_terrain = 0
    copied_contours = 0
    for hole_number in range(1, 19):
        key = str(hole_number)
        old_hole = old_holes.get(key)
        new_hole = new_holes.get(key)
        if not isinstance(old_hole, dict) or not isinstance(new_hole, dict):
            raise ValueError(f"Missing Hole {hole_number} in old or new package")

        frame = new_hole.get("coordinateFrame") or {}
        offset = finite_pair(frame.get("selectedTeeOffsetFromRouteStartYds"))
        if offset is None:
            raise ValueError(f"V5 Hole {hole_number} has no selected-tee offset metadata")

        terrain = old_hole.get("terrain")
        if isinstance(terrain, dict):
            translated = copy.deepcopy(terrain)
            min_x = translated.get("minX")
            min_y = translated.get("minY")
            if not isinstance(min_x, (int, float)) or not isinstance(min_y, (int, float)):
                raise ValueError(f"Old Hole {hole_number} terrain has invalid minX/minY")
            translated["minX"] = float(min_x) - offset[0]
            translated["minY"] = float(min_y) - offset[1]
            translated["note"] = (
                f"{translated.get('note', '')} Rebased from cached OSM route-start frame "
                f"to selected-tee frame by ({offset[0]:+.3f}, {offset[1]:+.3f}) yd; "
                "DEM values were not rotated or resampled."
            ).strip()
            new_hole["terrain"] = translated
            copied_terrain += 1

        contours = translated_contours(old_hole.get("contours"), offset)
        if contours:
            new_hole["contours"] = contours
            copied_contours += 1

    if old_package.get("terrainProvenance") is not None:
        output["terrainProvenance"] = copy.deepcopy(old_package["terrainProvenance"])
        if isinstance(output["terrainProvenance"], dict):
            output["terrainProvenance"]["rebaseNote"] = (
                "Existing embedded terrain was translated into each V5 selected-tee frame; "
                "grid values were preserved without rotation/resampling."
            )

    output["terrainCarryForward"] = {
        "sourcePackageGeneratedAt": old_package.get("generatedAt"),
        "terrainHoles": copied_terrain,
        "contourHoles": copied_contours,
        "method": "translation-only-route-axis-preserving-v1",
    }
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-package", required=True, type=Path)
    parser.add_argument("--new-package", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    old_package = json.loads(args.old_package.read_text(encoding="utf-8"))
    new_package = json.loads(args.new_package.read_text(encoding="utf-8"))
    output = carry(old_package, new_package)
    args.output.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(output.get("terrainCarryForward"), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
