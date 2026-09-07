from __future__ import annotations
import argparse
import json
from pathlib import Path

from .adapters import club_profiles_from_payload, live_state_from_probe
from .assumptions import Assumptions
from .engine import recommend


def _load(path: str | Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def run_replay(
    *,
    canonical_hole_path: str | Path,
    shot_state_path: str | Path,
    profiles_path: str | Path,
    mode: str,
    external_carry_adjustment_yds: float = 0.0,
    external_lateral_adjustment_yds: float = 0.0,
    assumptions_path: str | Path | None = None,
) -> dict:
    canonical_hole = _load(canonical_hole_path)
    shot_state = _load(shot_state_path)
    profile_payload = _load(profiles_path)
    rows = profile_payload.get("clubs") if isinstance(profile_payload, dict) else profile_payload
    if not isinstance(rows, list):
        raise ValueError("profiles JSON must be an array or object with a clubs array")

    assumptions = Assumptions.load(assumptions_path)
    profiles = club_profiles_from_payload(rows)
    state, hazards, green = live_state_from_probe(
        shot_state,
        canonical_hole,
        mode=mode,
        external_carry_adjustment_yds=external_carry_adjustment_yds,
        external_lateral_adjustment_yds=external_lateral_adjustment_yds,
    )
    result = recommend(
        profiles=profiles,
        state=state,
        hazards=hazards,
        green=green,
        assumptions=assumptions,
    )
    return {
        "schema_version": "live-caddie-replay-v0",
        "mode": mode,
        "input": {
            "canonical_hole": str(canonical_hole_path),
            "shot_state": str(shot_state_path),
            "profiles": str(profiles_path),
        },
        "recommendation": result.to_dict(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay Looper live-caddie recommendation from saved artifacts")
    parser.add_argument("--canonical-hole", required=True)
    parser.add_argument("--shot-state", required=True)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--mode", choices=["approach", "strategic"], required=True)
    parser.add_argument("--external-carry-adjustment-yds", type=float, default=0.0)
    parser.add_argument("--external-lateral-adjustment-yds", type=float, default=0.0)
    parser.add_argument("--assumptions")
    parser.add_argument("--output")
    args = parser.parse_args()

    payload = run_replay(
        canonical_hole_path=args.canonical_hole,
        shot_state_path=args.shot_state,
        profiles_path=args.profiles,
        mode=args.mode,
        external_carry_adjustment_yds=args.external_carry_adjustment_yds,
        external_lateral_adjustment_yds=args.external_lateral_adjustment_yds,
        assumptions_path=args.assumptions,
    )
    text = json.dumps(payload, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
