#!/usr/bin/env python3
"""Read-only GSPro tee watcher.

This is a diagnostic bridge toward automatic hole lifecycle. It never presses keys
and never launches tee capture. It watches the minimap surface title; only when GSPro
looks like a tee does it OCR the upper-right course/hole header and ask the pure
live-caddie tee-state calculation whether a tee capture should be triggered.

The eventual production orchestrator should call RoundTracker.accept_tee() only after
the real tee HoleModel capture succeeds. This watcher merely reports the event once
per course/hole identity so it cannot spam repeated detections while the player waits.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import probe as base
import minimap_surface
import round_identity
import target_card
import target_card_v8  # noqa: F401; installs field-proven target-card OCR patch

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.assumptions import Assumptions  # noqa: E402
from tools.live_caddie.round_tracker import RoundTracker  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only automatic GSPro tee-state watcher")
    parser.add_argument("--monitor", type=int, default=1)
    parser.add_argument("--roi", help="Optional minimap x,y,w,h override")
    parser.add_argument("--tesseract")
    parser.add_argument("--poll-ms", type=float, default=250.0)
    parser.add_argument("--stable-observations", type=int, default=2)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--once", action="store_true", help="Evaluate one frame and exit")
    return parser.parse_args()


def _identity_key(identity: dict | None) -> str | None:
    if not identity:
        return None
    course = str(identity.get("course_name") or "").strip().lower()
    hole = identity.get("hole_number")
    if not course or hole is None:
        return None
    return f"{course}::hole-{int(hole):02d}"


def _safe_pin_distance(screen, tesseract_path: str | None) -> float | None:
    try:
        return float(target_card.read_target_card(screen, tesseract_path=tesseract_path).distance_yds)
    except Exception:
        return None


def _emit(payload: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, separators=(",", ":")), flush=True)
        return
    identity = payload.get("identity") or {}
    decision = payload.get("decision") or {}
    surface = payload.get("surface") or {}
    print(
        f"TEE DETECTED: {identity.get('course_name') or '?'} H{identity.get('hole_number') or '?'} | "
        f"surface={surface.get('label') or '?'} | confidence={float(decision.get('confidence') or 0.0):.2f}",
        flush=True,
    )


def main() -> int:
    args = parse_args()
    assumptions = Assumptions.load()
    tracker = RoundTracker()
    reported_keys: set[str] = set()
    stable_key: str | None = None
    stable_count = 0

    if not args.json:
        print("GSPro automatic tee watcher (READ ONLY)")
        print("No W/Y/aim keys are pressed. No tee capture is launched.")
        print("Ctrl+C to stop.")

    try:
        while True:
            frame_started = time.perf_counter()
            screen = base.capture_monitor(args.monitor)
            minimap, _bbox = base.crop_minimap(screen, args.roi)

            try:
                surface = minimap_surface.read_minimap_surface(
                    minimap,
                    tesseract_path=args.tesseract,
                )
            except Exception as exc:
                surface = None
                if args.once and not args.json:
                    print(f"Surface read unavailable: {exc}")

            # The header is expensive OCR and irrelevant to tee triggering while a
            # recognized non-tee surface is displayed. Read it only for Tee or when
            # surface OCR is uncertain in one-shot diagnostics.
            identity = None
            identity_warning = None
            pin_distance = None
            should_probe_identity = surface is None or not surface.recognized or surface.is_tee
            if should_probe_identity:
                identity, identity_warning = round_identity.try_read_round_identity(
                    screen,
                    tesseract_path=args.tesseract,
                )
                if surface is not None and surface.is_tee:
                    pin_distance = _safe_pin_distance(screen, args.tesseract)

            identity_payload = identity.to_dict() if identity is not None else None
            surface_is_tee = surface.is_tee if surface is not None and surface.recognized else None
            surface_label = surface.label if surface is not None and surface.recognized else None

            decision = tracker.observe_pre_shot(
                current_identity=identity_payload,
                minimap_surface_is_tee=surface_is_tee,
                minimap_surface_label=surface_label,
                pin_card_distance_to_pin_yds=pin_distance,
                assumptions=assumptions,
            )

            key = _identity_key(identity_payload)
            candidate_key = key if decision.should_capture_tee else None
            if candidate_key is not None and candidate_key == stable_key:
                stable_count += 1
            elif candidate_key is not None:
                stable_key = candidate_key
                stable_count = 1
            else:
                stable_key = None
                stable_count = 0

            if (
                candidate_key is not None
                and stable_count >= max(1, int(args.stable_observations))
                and candidate_key not in reported_keys
            ):
                payload = {
                    "event": "tee-detected",
                    "identity": identity_payload,
                    "identity_warning": identity_warning,
                    "surface": surface.to_dict() if surface is not None else None,
                    "pin_card_distance_to_pin_yds": pin_distance,
                    "decision": decision.to_dict(),
                    "stable_observations": stable_count,
                }
                _emit(payload, args.json)
                reported_keys.add(candidate_key)

            if args.once:
                if args.json and not decision.should_capture_tee:
                    print(json.dumps({
                        "event": "no-tee",
                        "identity": identity_payload,
                        "identity_warning": identity_warning,
                        "surface": surface.to_dict() if surface is not None else None,
                        "decision": decision.to_dict(),
                    }, separators=(",", ":")))
                elif not args.json and not decision.should_capture_tee:
                    print(
                        f"No tee trigger: status={decision.status} confidence={decision.confidence:.2f} "
                        f"surface={surface_label or '?'}"
                    )
                return 0

            elapsed_ms = (time.perf_counter() - frame_started) * 1000.0
            remaining_ms = max(0.0, float(args.poll_ms) - elapsed_ms)
            if remaining_ms > 0:
                time.sleep(remaining_ms / 1000.0)

    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
