#!/usr/bin/env python3
"""Step 11 replay wrapper that also tests the saved restored frame as the Y candidate.

Tonight's field captures showed initial->toggled was effectively unchanged while
initial->restored visibly contained the green heatmap. That proves the first Y pulse
was ignored and the second pulse performed the actual toggle. This offline wrapper
recovers that evidence without touching GSPro.
"""
from __future__ import annotations

from pathlib import Path

import cv2

import green_heatmap
import hazard_step11_replay


def _heatmap_replay_recovered(capture: Path) -> tuple[bool, str]:
    initial_path = capture / "tee_initial_minimap.png"
    toggled_path = capture / "tee_toggled_minimap.png"
    restored_path = capture / "tee_restored_minimap.png"
    if not initial_path.is_file():
        return False, "initial minimap missing"

    initial = cv2.imread(str(initial_path), cv2.IMREAD_COLOR)
    candidates = []
    if toggled_path.is_file():
        candidates.append(("initial->toggled", toggled_path))
    if restored_path.is_file():
        candidates.append(("initial->restored-recovery", restored_path))
    if not candidates:
        return False, "Y candidate frames missing"

    errors = []
    for label, path in candidates:
        candidate = cv2.imread(str(path), cv2.IMREAD_COLOR)
        try:
            result = green_heatmap.classify_minimap_pair(initial, candidate)
            return True, (
                f"PASS pair={label} mode={result.difference_mode} "
                f"changed={result.changed_pixel_ratio:.4%} "
                f"green_area={result.target_green_area_px}px confidence={result.confidence:.2f}"
            )
        except Exception as exc:
            errors.append(f"{label}: {exc}")

    return False, "FAIL " + " | ".join(errors)


def main() -> int:
    hazard_step11_replay._heatmap_replay = _heatmap_replay_recovered
    return hazard_step11_replay.main()


if __name__ == "__main__":
    raise SystemExit(main())
