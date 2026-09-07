#!/usr/bin/env python3
"""GSPro post-tee v4: identity-safe geometry + automatic mode + bounded W/Y + read-only caddie.

v4 is the first integrated post-tee pipeline that may manipulate the minimap for
better green context. Product safety rules:
- shot mode is a pure calculation outside orchestration; default is automatic;
- GSPro Green explicitly yields out of the full-shot caddie path;
- W is zoom-out only and bounded; never automatically zoom back in;
- Y uses the field-proven fixed toggle/restore timing;
- refined green geometry is merged only after registration/heatmap/pin checks;
- player profiles auto-load from the authenticated Looper materialization in the GSPro folder;
- recommendation AIM remains READ ONLY; no recommendation-driven arrow movement;
- all tunable policy/timing lives in config/looper-live-caddie.json.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import cv2

import lie_state
import minimap_surface
import posttee_refinement
import probe as base
import probe_approach_v3 as v3
import probe_v8
import round_identity
import target_card_v8  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.adapters import live_state_from_probe  # noqa: E402
from tools.live_caddie.assumptions import Assumptions  # noqa: E402
from tools.live_caddie.canonicalize_capture import build_canonical_hole  # noqa: E402
from tools.live_caddie.engine import recommend  # noqa: E402
from tools.live_caddie.profile_store import resolve_profile_store  # noqa: E402
from tools.live_caddie.source_resolution import resolve_distance_to_pin  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro post-tee ShotState probe v4")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--lie-roi")
    p.add_argument("--tesseract")
    p.add_argument("--no-aim-summon", action="store_true")
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=60.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    p.add_argument("--deep-debug", action="store_true")
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    p.add_argument(
        "--profiles-json",
        help="Optional diagnostic override. Normally Looper auto-loads looper-live-caddie-profiles.json from the GSPro folder.",
    )
    p.add_argument(
        "--mode",
        choices=["auto", "approach", "strategic"],
        default="auto",
        help="Default auto uses the registered shot-mode calculation; explicit values are diagnostic overrides.",
    )
    p.add_argument("--external-carry-adjustment-yds", type=float, default=0.0)
    p.add_argument("--external-lateral-adjustment-yds", type=float, default=0.0)
    return p.parse_args()


def _out_dir(root: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = Path(root) / f"approach_capture_{stamp}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_profiles(path: str):
    return v3._load_profiles(path)


def _public_refinement(refinement: dict) -> dict:
    return {
        key: value for key, value in refinement.items()
        if key not in ("final_screen", "final_minimap")
    }


def main() -> int:
    args = parse_args()
    assumptions = Assumptions.load()
    out = _out_dir(args.output_root)
    timer = v3.Timer()

    try:
        profile_selection = resolve_profile_store(args.profiles_json)
        initial = timer.call("initial_capture", base.capture_monitor, args.monitor)
        initial_minimap, _ = base.crop_minimap(initial, args.roi)

        # Frozen-frame OCR is overlapped with the neutral AIM expose/return cycle.
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="approach-v4") as executor:
            pin_future = executor.submit(
                timer.call,
                "pin_card_ocr",
                probe_v8._read_card_type,
                initial,
                "pin",
                args,
                None,
                True,
            )
            lie_future = executor.submit(
                timer.call,
                "lie_ocr",
                lie_state.read_lie_state,
                initial,
                args.tesseract,
                args.lie_roi,
                None,
            )
            identity_future = executor.submit(
                timer.call,
                "round_identity_ocr",
                round_identity.try_read_round_identity,
                initial,
                args.tesseract,
                None,
                out if args.deep_debug else None,
            )
            surface_future = executor.submit(
                timer.call,
                "minimap_surface_ocr",
                minimap_surface.read_minimap_surface,
                initial_minimap,
                tesseract_path=args.tesseract,
                debug_dir=(out if args.deep_debug else None),
            )

            t0 = time.perf_counter()
            aim_state, aim_meta, aim_screen = probe_v8._acquire_aim(initial, args, out)
            timer.phase_ms["aim_acquisition"] = round((time.perf_counter() - t0) * 1000.0, 1)
            pin_state = pin_future.result()
            lie = lie_future.result()
            identity, identity_warning = identity_future.result()
            try:
                surface = surface_future.result()
            except Exception:
                surface = None

        identity_payload = identity.to_dict() if identity is not None else None
        surface_payload = surface.to_dict() if surface is not None else None
        surface_label = surface.label if surface is not None and surface.recognized else None
        aim_distance = float(aim_state.distance_yds) if aim_state is not None else None

        t0 = time.perf_counter()
        refinement = posttee_refinement.refine_green_if_useful(
            initial_screen=initial,
            monitor=args.monitor,
            roi=args.roi,
            pin_distance_yds=float(pin_state.distance_yds),
            aim_distance_yds=aim_distance,
            round_identity=identity_payload,
            output_root=args.output_root,
            capture_dir=out,
            mode=args.mode,
            surface_label=surface_label,
            assumptions=assumptions,
        )
        timer.phase_ms["geometry_refinement"] = round((time.perf_counter() - t0) * 1000.0, 1)
        geometry = refinement["final_geometry"]
        final_screen = refinement["final_screen"]
        final_minimap = refinement["final_minimap"]
        resolved_mode = str(refinement.get("resolved_mode") or args.mode)
        shot_mode_decision = refinement.get("shot_mode_decision")

        registration = geometry.get("registration") or {}
        canonical_position = geometry.get("canonical_position") or {}
        resolved_distance = resolve_distance_to_pin(
            pin_card_yds=float(pin_state.distance_yds),
            canonical_yds=(
                float(canonical_position["canonical_remaining_pin_yds"])
                if canonical_position.get("canonical_remaining_pin_yds") is not None else None
            ),
            canonical_registration_confidence=float(registration.get("confidence") or 0.0),
            assumptions=assumptions,
        )

        payload = {
            "schema_version": "post-tee-shot-state-v4",
            "capture_mode": "post-tee",
            "round_identity": identity_payload,
            "round_identity_warning": identity_warning,
            "minimap_surface": surface_payload,
            "requested_mode": args.mode,
            "resolved_mode": resolved_mode,
            "shot_mode_decision": shot_mode_decision,
            "pin": v3._state_dict(pin_state),
            "resolved_distance_to_pin": resolved_distance.to_dict(),
            "aim": v3._state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "aim_context": geometry.get("aim_context"),
            "aim_context_warning": geometry.get("aim_context_warning"),
            "lie_slope": asdict(lie),
            "canonical_geometry": geometry,
            "green_refinement": _public_refinement(refinement),
            "player_profiles": profile_selection.to_dict(),
            "minimap": {
                "as_presented": "approach_initial_minimap.png",
                "final": "approach_final_minimap.png",
                "zoom_changed": int(refinement.get("w_pulses") or 0) > 0,
                "w_pulses": int(refinement.get("w_pulses") or 0),
                "heatmap_toggled": bool(refinement.get("heatmap_toggled")),
                "visible_pin_required": False,
                "never_zoom_back_in": True,
            },
            "wind": None,
            "wind_note": "Use existing Looper wind source; v4 accepts its derived carry/lateral adjustments.",
            "created_local": datetime.now().isoformat(timespec="seconds"),
            "assumption_version": assumptions.version,
        }

        recommendation = None
        recommendation_warning = None
        if resolved_mode == "no-full-shot":
            recommendation_warning = "GSPro state is not a full-shot caddie state; recommendation intentionally skipped."
        elif resolved_mode == "unknown":
            recommendation_warning = "Shot mode could not be resolved confidently; recommendation intentionally skipped."
        elif profile_selection.available and profile_selection.path:
            try:
                profiles = _load_profiles(profile_selection.path)
                capture_dir = Path(geometry["hole_model_path"]).parent
                canonical_path = capture_dir / "canonical_hole_model.json"
                if canonical_path.exists():
                    canonical_hole = json.loads(canonical_path.read_text(encoding="utf-8"))
                else:
                    canonical_hole = timer.call("canonical_hole_build", build_canonical_hole, capture_dir)
                live_state, hazards, green = live_state_from_probe(
                    payload,
                    canonical_hole,
                    mode=resolved_mode,
                    external_carry_adjustment_yds=args.external_carry_adjustment_yds,
                    external_lateral_adjustment_yds=args.external_lateral_adjustment_yds,
                )
                recommendation = timer.call(
                    "recommendation",
                    recommend,
                    profiles=profiles,
                    state=live_state,
                    hazards=hazards,
                    green=green,
                ).to_dict()
            except Exception as exc:
                recommendation_warning = str(exc)
        else:
            recommendation_warning = profile_selection.warning or "Looper player profiles are unavailable."

        state_ready_ms = timer.elapsed_ms()
        payload["recommendation"] = recommendation
        payload["recommendation_warning"] = recommendation_warning
        payload["performance"] = {
            "state_ready_ms": state_ready_ms,
            "phase_ms": timer.phase_ms,
            "parallel_ocr": True,
            "recommendation_aim_applied": False,
        }
        (out / "shot_state.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        cv2.imwrite(str(out / "approach_initial_screen.png"), initial)
        cv2.imwrite(str(out / "approach_initial_minimap.png"), initial_minimap)
        cv2.imwrite(str(out / "approach_final_screen.png"), final_screen)
        cv2.imwrite(str(out / "approach_final_minimap.png"), final_minimap)
        if aim_screen is not None and aim_state is not None:
            x, y, w, h = aim_state.card_bbox
            crop = aim_screen[y:y+h, x:x+w]
            if crop.size:
                cv2.imwrite(str(out / "approach_aim_card.png"), crop)

        print()
        print("GSPro POST-TEE SHOT STATE PROBE v4")
        print("=================================")
        if identity_payload:
            print(
                f"Hole identity:          {identity_payload.get('course_name') or '?'} | "
                f"H{identity_payload.get('hole_number') or '?'} | PAR {identity_payload.get('par') or '?'} | "
                f"{identity_payload.get('hole_yards') or '?'} YDS"
            )
        print(f"Minimap surface:        {surface_label or '?'}")
        print(f"Shot mode:              {resolved_mode.upper()} | requested {args.mode}")
        if shot_mode_decision:
            print(f"Mode confidence:        {float(shot_mode_decision.get('confidence') or 0.0):.2f}")
            print(f"Mode reason:            {shot_mode_decision.get('reason') or '?'}")
        print(f"Pin target:             {pin_state.distance_yds:.0f} yd")
        print(f"Pin elevation:          {pin_state.elevation_direction} {pin_state.elevation_raw or '?'}")
        print(f"Lie slope:              {lie_state.state_text(lie)}")
        print(f"Resolved DTP:           {resolved_distance.value_yds if resolved_distance.value_yds is not None else '?'} | {resolved_distance.source or '?'} | {resolved_distance.status}")
        if profile_selection.available:
            profile_detail = f"{profile_selection.club_count} clubs"
            if profile_selection.shot_count is not None:
                profile_detail += f" | {profile_selection.shot_count} shots"
            print(f"Player profiles:        {profile_selection.method.upper()} | {profile_detail}")
        else:
            print(f"Player profiles:        UNAVAILABLE | {profile_selection.warning or '?'}")
        print(f"W zoom-out pulses:      {int(refinement.get('w_pulses') or 0)}")
        print(f"Y green refinement:     {'YES' if refinement.get('heatmap_toggled') else 'NO'}")
        if refinement.get("merge"):
            merge = refinement["merge"]
            print(f"Green merge:            {'ACTIVATED' if merge.get('activated') else 'NOT ACTIVATED'} | {merge.get('reason') or '?'}")
        print("Zoom-back-in:           NEVER")
        print("Recommendation aim:     READ ONLY")

        selection = geometry.get("hole_model_selection") or {}
        print(f"HoleModel selection:    {selection.get('method', '?')} | confidence {float(selection.get('confidence') or 0.0):.2f}")
        print(f"Map registration:       {float(registration.get('confidence') or 0.0):.2f} confidence | {registration.get('inliers', '?')} inliers")
        green_state = geometry.get("green_visibility") or {}
        print(f"Target green visible:   {'YES' if green_state.get('visible') else 'NO'}")

        if recommendation is not None and recommendation.get("recommended"):
            best = recommendation["recommended"]
            candidate = best["candidate"]
            print()
            print("READ-ONLY RECOMMENDATION")
            print(f"Club / shot:            {candidate['club']} {candidate['variant']}")
            print(f"Aim shift:              {candidate['aim_offset_yds']:+.1f} yd from baseline")
            print(f"Confidence:             {recommendation['confidence']:.2f}")
            for reason in best.get("reasons") or []:
                print(f"  - {reason}")
        elif recommendation_warning:
            print(f"Recommendation warning: {recommendation_warning}")

        print()
        print("Performance timing")
        print("------------------")
        for key, label in (
            ("initial_capture", "Initial capture"),
            ("pin_card_ocr", "PIN card OCR*"),
            ("lie_ocr", "Lie OCR*"),
            ("round_identity_ocr", "Hole identity OCR*"),
            ("minimap_surface_ocr", "Surface OCR*"),
            ("aim_acquisition", "AIM acquisition"),
            ("geometry_refinement", "Geometry + mode + optional W/Y"),
            ("recommendation", "Recommendation"),
        ):
            if key in timer.phase_ms:
                print(f"{label + ':':30} {timer.phase_ms[key]:7.1f} ms")
        print("* OCR runs overlapped with AIM acquisition")
        print(f"{'STATE READY:':30} {state_ready_ms:7.1f} ms")
        print()
        print(f"ShotState:              {out / 'shot_state.json'}")
        print(f"Capture folder:         {out}")
        return 0

    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
