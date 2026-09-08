from __future__ import annotations

import argparse
import json
from pathlib import Path

from .adapters import club_profiles_from_payload, current_context_from_canonical
from .assumptions import Assumptions
from .canonicalize_capture import build_canonical_hole
from .engine import recommend
from .models import LiveShotState
from .profile_store import resolve_profile_store
from .shot_mode import ShotModeInputs, infer_shot_mode, polygon_from_canonical_hole
from .tee_context import build_tee_context


def _load_profiles(path: str) -> list:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("clubs") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("profiles JSON must be an array or an object with a clubs array")
    return club_profiles_from_payload(rows)


def build_tee_recommendation(
    capture_dir: str | Path,
    *,
    profiles_path: str | None = None,
    external_carry_adjustment_yds: float = 0.0,
    external_lateral_adjustment_yds: float = 0.0,
    assumptions: Assumptions | None = None,
) -> dict:
    """Post-process a proven tee capture into a read-only caddie recommendation.

    No GSPro key is sent here. The tee probe owns screen capture; this module only
    consumes persisted tee geometry plus the authenticated Looper player-model cache.
    Missing player profiles no longer block geometry-only short-game guidance: green
    and hazard geometry can still describe a safer target without inventing a club or
    partial-shot pattern.
    """
    assumptions = assumptions or Assumptions.load()
    capture = Path(capture_dir)
    shot_state = json.loads((capture / "shot_state.json").read_text(encoding="utf-8"))

    canonical_path = capture / "canonical_hole_model.json"
    canonical_hole = (
        json.loads(canonical_path.read_text(encoding="utf-8"))
        if canonical_path.exists()
        else build_canonical_hole(capture, assumptions)
    )
    tee_context_path = capture / "tee_live_context.json"
    tee_context = (
        json.loads(tee_context_path.read_text(encoding="utf-8"))
        if tee_context_path.exists()
        else build_tee_context(capture, assumptions)
    )

    profile_selection = resolve_profile_store(profiles_path)
    payload = {
        "schema_version": "tee-read-only-recommendation-v1",
        "capture_dir": str(capture),
        "player_profiles": profile_selection.to_dict(),
        "recommendation": None,
        "recommendation_warning": None,
        "shot_mode": None,
        "assumption_version": assumptions.version,
    }

    pin = shot_state.get("pin") or {}
    aim = shot_state.get("aim") or {}
    aim_context = tee_context.get("aim_context") or {}
    polygon = polygon_from_canonical_hole(canonical_hole)
    decision = infer_shot_mode(
        ShotModeInputs(
            surface_label="Tee",
            pin_distance_yds=(float(pin["distance_yds"]) if pin.get("distance_yds") is not None else None),
            aim_distance_yds=(float(aim["distance_yds"]) if aim.get("distance_yds") is not None else None),
            aim_forward_tee_yds=(float(aim_context["forward_yds"]) if aim_context.get("forward_yds") is not None else None),
            aim_right_tee_yds=(float(aim_context["right_yds"]) if aim_context.get("right_yds") is not None else None),
            canonical_green_polygon=polygon,
            green_context_available=polygon is not None,
        ),
        assumptions,
    )
    payload["shot_mode"] = decision.to_dict()
    if decision.mode not in ("approach", "strategic"):
        payload["recommendation_warning"] = (
            f"tee shot mode resolved to {decision.mode}; full-shot recommendation skipped"
        )
        (capture / "tee_recommendation.json").write_text(
            json.dumps(payload, indent=2), encoding="utf-8"
        )
        return payload

    hazards, green = current_context_from_canonical(
        canonical_hole,
        current_ball_forward_yds=0.0,
        current_ball_right_yds=0.0,
    )
    state = LiveShotState(
        mode=decision.mode,  # type: ignore[arg-type]
        pin_distance_yds=float(pin.get("distance_yds") or 0.0),
        pin_elevation_delta_yds=float(pin.get("elevation_delta_yds") or 0.0),
        pin_forward_yds=(green.pin.forward if green is not None else None),
        pin_right_yds=(green.pin.right if green is not None else 0.0),
        gspro_aim_forward_yds=(float(aim_context["forward_yds"]) if aim_context.get("forward_yds") is not None else None),
        gspro_aim_right_yds=(float(aim_context["right_yds"]) if aim_context.get("right_yds") is not None else None),
        gspro_aim_distance_yds=(float(aim["distance_yds"]) if aim.get("distance_yds") is not None else None),
        gspro_aim_elevation_delta_yds=float(aim.get("elevation_delta_yds") or 0.0),
        external_carry_adjustment_yds=float(external_carry_adjustment_yds),
        external_lateral_adjustment_yds=float(external_lateral_adjustment_yds),
        lie_up_down_deg=0.0,
        lie_left_right_deg=0.0,
        registration_confidence=1.0,
        pin_crosscheck_error_yds=0.0,
    )

    profiles = (
        _load_profiles(profile_selection.path)
        if profile_selection.available and profile_selection.path
        else []
    )
    result = recommend(
        profiles=profiles,
        state=state,
        hazards=hazards,
        green=green,
        assumptions=assumptions,
    )
    payload["recommendation"] = result.to_dict()
    if result.recommendation_kind == "none" and not profile_selection.available:
        payload["recommendation_warning"] = (
            profile_selection.warning or "Looper player profiles are unavailable and geometry-only scope did not apply."
        )
    (capture / "tee_recommendation.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )
    return payload


def _guidance_label(guidance: dict) -> str:
    parts: list[str] = []
    depth = str(guidance.get("preferred_depth") or "center")
    side = str(guidance.get("preferred_side") or "center")
    if depth not in ("center", "unknown"):
        parts.append(depth)
    if side not in ("center", "unknown"):
        parts.append(side)
    return "-".join(parts) if parts else ("center" if side != "unknown" else "unknown")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a read-only Looper recommendation from a completed tee capture")
    parser.add_argument("capture_dir")
    parser.add_argument("--profiles-json", help="Optional diagnostic player-profile override")
    parser.add_argument("--external-carry-adjustment-yds", type=float, default=0.0)
    parser.add_argument("--external-lateral-adjustment-yds", type=float, default=0.0)
    args = parser.parse_args()

    payload = build_tee_recommendation(
        args.capture_dir,
        profiles_path=args.profiles_json,
        external_carry_adjustment_yds=args.external_carry_adjustment_yds,
        external_lateral_adjustment_yds=args.external_lateral_adjustment_yds,
    )
    selection = payload["player_profiles"]
    print(
        f"Player profiles: {selection.get('method', '?')} | "
        f"{selection.get('club_count', 0)} clubs | {selection.get('shot_count') or '?'} shots"
    )
    decision = payload.get("shot_mode") or {}
    if decision:
        print(f"Tee shot mode: {str(decision.get('mode') or '?').upper()} | confidence {float(decision.get('confidence') or 0.0):.2f}")

    recommendation = payload.get("recommendation") or {}
    if recommendation.get("recommended"):
        best = recommendation["recommended"]
        candidate = best["candidate"]
        print("READ-ONLY TEE RECOMMENDATION")
        print(f"Club / shot: {candidate['club']} {candidate['variant']}")
        print(f"Aim shift:   {candidate['aim_offset_yds']:+.1f} yd from GSPro baseline")
        print(f"Confidence:  {float(recommendation.get('confidence') or 0.0):.2f}")
        for reason in best.get("reasons") or []:
            print(f"  - {reason}")
    elif recommendation.get("recommendation_kind") == "geometry-only" and recommendation.get("guidance"):
        guidance = recommendation["guidance"]
        print("GEOMETRY-ONLY SHORT-GAME GUIDANCE")
        print(f"Safer target: {_guidance_label(guidance).upper()}")
        print(f"Lateral shift: {float(guidance.get('suggested_safe_offset_yds') or 0.0):+.1f} yd")
        print(f"Depth shift:   {float(guidance.get('suggested_safe_longitudinal_offset_yds') or 0.0):+.1f} yd")
        print(f"Confidence:    {float(guidance.get('confidence') or 0.0):.2f}")
        print("No club / partial-shot dispersion modeled; recommendation aim remains read only.")
    else:
        print(f"Recommendation warning: {payload.get('recommendation_warning') or (recommendation.get('fallbacks') or ['?'])[0]}")
    print(capture_dir := Path(args.capture_dir) / "tee_recommendation.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
