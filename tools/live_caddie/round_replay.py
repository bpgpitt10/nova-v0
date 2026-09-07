from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .assumptions import Assumptions
from .round_orchestrator import RoundObservation, RoundOrchestrator


def _default_sequence() -> list[dict[str, Any]]:
    """Synthetic two-hole sequence mirroring the state transitions Looper must handle."""
    hole2 = {
        "course_name": "The Old Game",
        "hole_number": 2,
        "par": 5,
        "hole_yards": 501,
        "confidence": 1.0,
    }
    hole3 = {
        "course_name": "The Old Game",
        "hole_number": 3,
        "par": 4,
        "hole_yards": 412,
        "confidence": 1.0,
    }
    return [
        {
            "label": "h2-tee",
            "identity": hole2,
            "minimap_surface_label": "tee",
            "minimap_surface_is_tee": True,
            "upper_left_shot_number": 1,
            "upper_left_distance_to_pin_yds": 501,
            "pin_card_distance_to_pin_yds": 501,
            "flat_lie": True,
            "full_hole_minimap": True,
            "accept_tee_after_action": True,
        },
        {
            "label": "h2-shot2",
            "identity": hole2,
            "minimap_surface_label": "fairway",
            "minimap_surface_is_tee": False,
            "upper_left_shot_number": 2,
            "upper_left_distance_to_pin_yds": 245,
            "pin_card_distance_to_pin_yds": 245,
            "canonical_distance_to_pin_yds": 244.4,
            "canonical_registration_confidence": 0.92,
        },
        {
            "label": "h2-shot3",
            "identity": hole2,
            "minimap_surface_label": "fairway",
            "minimap_surface_is_tee": False,
            "upper_left_shot_number": 3,
            "upper_left_distance_to_pin_yds": 92,
            "pin_card_distance_to_pin_yds": 92,
            "canonical_distance_to_pin_yds": 91.6,
            "canonical_registration_confidence": 0.94,
        },
        {
            "label": "h2-putt-state",
            "identity": hole2,
            "minimap_surface_label": "green",
            "minimap_surface_is_tee": False,
            "upper_left_shot_number": 4,
            "upper_left_distance_to_pin_yds": 8,
            "pin_card_distance_to_pin_yds": 8,
            "mark_terminal": True,
        },
        {
            "label": "h3-instant-tee",
            "identity": hole3,
            "minimap_surface_label": "tee",
            "minimap_surface_is_tee": True,
            "upper_left_shot_number": 1,
            "upper_left_distance_to_pin_yds": 412,
            "pin_card_distance_to_pin_yds": 412,
            "flat_lie": True,
            "full_hole_minimap": True,
            "accept_tee_after_action": True,
        },
    ]


def replay(sequence: list[dict[str, Any]], *, actions_enabled: bool = False) -> dict[str, Any]:
    assumptions = Assumptions.load()
    orchestrator = RoundOrchestrator(assumptions=assumptions, actions_enabled=actions_enabled)
    steps = []

    for index, row in enumerate(sequence):
        label = str(row.get("label") or f"step-{index + 1}")
        observation_fields = {
            key: value
            for key, value in row.items()
            if key in RoundObservation.__dataclass_fields__
        }
        observation = RoundObservation(**observation_fields)
        action = orchestrator.observe(observation)

        if bool(row.get("mark_terminal")):
            orchestrator.mark_terminal()
        if bool(row.get("accept_tee_after_action")) and action.action == "capture-tee":
            orchestrator.accept_tee_capture(identity=observation.identity)

        steps.append({
            "index": index + 1,
            "label": label,
            "observation": observation_fields,
            "planned_action": action.to_dict(),
            "state_after": orchestrator.state(),
        })

    return {
        "schema_version": "looper-round-replay-v0",
        "assumption_version": assumptions.version,
        "actions_enabled": actions_enabled,
        "steps": steps,
        "final_state": orchestrator.state(),
    }


def _load_sequence(path: str | None) -> list[dict[str, Any]]:
    if not path:
        return _default_sequence()
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    sequence = payload.get("sequence") if isinstance(payload, dict) else payload
    if not isinstance(sequence, list):
        raise ValueError("round replay input must be an array or an object with sequence[]")
    return sequence


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline Looper full-round lifecycle replay")
    parser.add_argument("--input", help="Optional JSON replay sequence; defaults to built-in two-hole scenario")
    parser.add_argument("--output", help="Optional output JSON path")
    args = parser.parse_args()

    result = replay(_load_sequence(args.input), actions_enabled=False)
    text = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
