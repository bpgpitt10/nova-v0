#!/usr/bin/env python3
"""GSPro post-tee v2: canonical AIM context + optional read-only recommendation.

Still field-safe: no W, no Y, and no recommendation-driven aim movement. v2 adds:
- gray AIM marker localization checked against the AIM-card distance;
- AIM target mapped into the canonical HoleModel coordinate system;
- optional read-only live-caddie recommendation using existing Looper club profiles.
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
import posttee_geometry
import probe as base
import probe_v8
import target_card_v8  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.adapters import club_profiles_from_payload, live_state_from_probe  # noqa: E402
from tools.live_caddie.canonicalize_capture import build_canonical_hole  # noqa: E402
from tools.live_caddie.engine import recommend  # noqa: E402


class Timer:
    def __init__(self) -> None:
        self.start = time.perf_counter()
        self.phase_ms: dict[str, float] = {}

    def call(self, name, fn, *args, **kwargs):
        t0 = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            self.phase_ms[name] = round((time.perf_counter() - t0) * 1000.0, 1)

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self.start) * 1000.0, 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro post-tee ShotState probe v2")
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
    p.add_argument("--profiles-json", help="Optional JSON array/object exported from Looper player profiles.")
    p.add_argument("--mode", choices=["approach", "strategic"], default="approach")
    p.add_argument("--external-carry-adjustment-yds", type=float, default=0.0)
    p.add_argument("--external-lateral-adjustment-yds", type=float, default=0.0)
    return p.parse_args()


def _out_dir(root: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = Path(root) / f"approach_capture_{stamp}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _state_dict(state):
    if state is None:
        return None
    return {
        "distance_yds": state.distance_yds,
        "elevation_raw": state.elevation_raw,
        "elevation_direction": state.elevation_direction,
        "elevation_delta_ft": state.elevation_delta_ft,
        "elevation_delta_yds": state.elevation_delta_yds,
        "source": state.source,
    }


def _load_profiles(path: str):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("clubs") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("profiles JSON must be an array or an object with a clubs array")
    return club_profiles_from_payload(rows)


def main() -> int:
    args = parse_args()
    out = _out_dir(args.output_root)
    timer = Timer()

    try:
        initial = timer.call("initial_capture", base.capture_monitor, args.monitor)
        minimap, minimap_bbox = base.crop_minimap(initial, args.roi)

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="approach-v2") as executor:
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

            t0 = time.perf_counter()
            aim_state, aim_meta, aim_screen = probe_v8._acquire_aim(initial, args, out)
            timer.phase_ms["aim_acquisition"] = round((time.perf_counter() - t0) * 1000.0, 1)
            pin_state = pin_future.result()
            lie = lie_future.result()

        geometry = timer.call(
            "canonical_geometry",
            posttee_geometry.analyze,
            current_minimap=minimap,
            pin_distance_yds=float(pin_state.distance_yds),
            aim_distance_yds=(float(aim_state.distance_yds) if aim_state is not None else None),
            output_root=args.output_root,
        )

        payload = {
            "schema_version": "post-tee-shot-state-v2",
            "capture_mode": "post-tee",
            "pin": _state_dict(pin_state),
            "aim": _state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "aim_context": geometry.get("aim_context"),
            "aim_context_warning": geometry.get("aim_context_warning"),
            "lie_slope": asdict(lie),
            "minimap": {
                "as_presented": "approach_minimap.png",
                "bbox": list(minimap_bbox),
                "zoom_changed": False,
                "heatmap_toggled": False,
            },
            "canonical_geometry": geometry,
            "wind": None,
            "wind_note": "Use existing Looper wind source; v2 accepts its derived carry/lateral adjustments.",
            "created_local": datetime.now().isoformat(timespec="seconds"),
        }

        recommendation = None
        recommendation_warning = None
        if args.profiles_json:
            try:
                profiles = _load_profiles(args.profiles_json)
                capture_dir = Path(geometry["hole_model_path"]).parent
                canonical_path = capture_dir / "canonical_hole_model.json"
                if canonical_path.exists():
                    canonical_hole = json.loads(canonical_path.read_text(encoding="utf-8"))
                else:
                    canonical_hole = timer.call("canonical_hole_build", build_canonical_hole, capture_dir)
                live_state, hazards, green = live_state_from_probe(
                    payload,
                    canonical_hole,
                    mode=args.mode,
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

        state_ready_ms = timer.elapsed_ms()
        payload["recommendation"] = recommendation
        payload["recommendation_warning"] = recommendation_warning
        payload["performance"] = {
            "state_ready_ms": state_ready_ms,
            "phase_ms": timer.phase_ms,
            "parallel_ocr": True,
        }
        (out / "shot_state.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        # Review artifacts remain post-ready.
        cv2.imwrite(str(out / "approach_initial_screen.png"), initial)
        cv2.imwrite(str(out / "approach_minimap.png"), minimap)
        if aim_screen is not None and aim_state is not None:
            x, y, w, h = aim_state.card_bbox
            crop = aim_screen[y:y+h, x:x+w]
            if crop.size:
                cv2.imwrite(str(out / "approach_aim_card.png"), crop)

        print()
        print("GSPro POST-TEE SHOT STATE PROBE v2")
        print("=================================")
        print("W zoom:                NOT USED")
        print("Y heatmap:             NOT USED")
        print("Recommendation aim:    READ ONLY; never applied")
        print(f"Pin target:            {pin_state.distance_yds:.0f} yd")
        print(f"Pin elevation:         {pin_state.elevation_direction} {pin_state.elevation_raw or '?'}")
        print(f"Lie slope:             {lie_state.state_text(lie)}")
        if aim_state is not None:
            print(f"GSPro aim target:      {aim_state.distance_yds:.0f} yd | {aim_state.elevation_direction} {aim_state.elevation_raw or '?'}")
        if geometry.get("aim_context"):
            context = geometry["aim_context"]
            print(
                f"AIM geometry:          {context['forward_yds']:.1f} yd forward | "
                f"{context['right_yds']:+.1f} yd right"
            )
            print(f"AIM marker checksum:   {context['marker']['distance_error_yds']:.1f} yd error")
        elif geometry.get("aim_context_warning"):
            print(f"AIM geometry warning:  {geometry['aim_context_warning']}")

        registration = geometry["registration"]
        position = geometry["canonical_position"]
        crosscheck = geometry["pin_distance_crosscheck"]
        print(f"Map registration:      {registration['confidence']:.2f} confidence | {registration['inliers']} inliers")
        print(
            f"Canonical position:    {position['tee_relative_forward_yds']:.0f} yd forward | "
            f"{position['tee_relative_lateral_yds']:+.0f} yd lateral"
        )
        print(
            f"Pin cross-check:       {crosscheck['canonical_remaining_pin_yds']:.1f} yd canonical "
            f"vs {crosscheck['screen_pin_distance_yds']:.1f} yd screen | "
            f"{'PASS' if crosscheck['ok'] else 'WARN'}"
        )
        green_visibility = geometry["green_visibility"]
        print(f"Target green visible:  {'YES' if green_visibility['visible'] else 'NO'}")
        print(f"W recovery decision:   {'WOULD ZOOM OUT' if geometry['w_recovery_recommended'] else 'NOT NEEDED'}")

        if recommendation is not None and recommendation.get("recommended"):
            best = recommendation["recommended"]
            candidate = best["candidate"]
            print()
            print("READ-ONLY RECOMMENDATION")
            print(f"Club / shot:           {candidate['club']} {candidate['variant']}")
            print(f"Aim shift:             {candidate['aim_offset_yds']:+.1f} yd from baseline")
            print(f"Confidence:            {recommendation['confidence']:.2f}")
            for reason in best.get("reasons") or []:
                print(f"  - {reason}")
        elif recommendation_warning:
            print(f"Recommendation warning: {recommendation_warning}")

        print()
        print(f"STATE READY:           {state_ready_ms:.1f} ms")
        print(f"ShotState:             {out / 'shot_state.json'}")
        print(f"Capture folder:        {out}")
        return 0

    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
