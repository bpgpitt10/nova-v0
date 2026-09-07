#!/usr/bin/env python3
"""GSPro full-shot round watcher with dry-run default.

This runtime adapter connects screen facts to the pure RoundOrchestrator. It is safe
by default: no GSPro keys are pressed and no capture scripts are launched unless the
operator passes --execute-actions explicitly.

Current capability:
- detect/confirm new tees from minimap Tee state + upper-right identity + upper-left shot/DTP;
- read non-practice player name, shot number, decimal DTP and signed elevation;
- plan and optionally launch the proven tee HoleModel capture;
- retain the accepted active-hole identity across the round;
- recognize non-tee states without falsely re-triggering tee capture;
- plan post-tee refreshes on authoritative shot-counter advancement.

The upper-left HUD now has calibrated normalized defaults from two real non-practice
screenshots. Explicit x,y,w,h overrides remain diagnostic escape hatches.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

import minimap_surface
import probe as base
import round_identity
import target_card
import target_card_v8  # noqa: F401
import upper_left_state

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.assumptions import Assumptions  # noqa: E402
from tools.live_caddie.round_orchestrator import RoundObservation, RoundOrchestrator  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Looper automatic GSPro round watcher")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--tesseract")
    p.add_argument("--poll-ms", type=float, default=250.0)
    p.add_argument("--upper-left-shot-roi", help="Optional diagnostic x,y,w,h override")
    p.add_argument("--upper-left-distance-roi", help="Optional diagnostic x,y,w,h override")
    p.add_argument("--upper-left-elevation-roi", help="Optional diagnostic x,y,w,h override")
    p.add_argument("--upper-left-player-roi", help="Optional diagnostic x,y,w,h override")
    p.add_argument("--disable-upper-left", action="store_true", help="Disable calibrated non-practice upper-left HUD reader")
    p.add_argument("--execute-actions", action="store_true", help="EXPLICITLY allow configured tee capture script to run")
    p.add_argument("--json", action="store_true")
    p.add_argument("--once", action="store_true")
    p.add_argument("--state-file", default=str(Path(__file__).with_name("output") / "round_watch_state.json"))
    return p.parse_args()


def _identity_key(identity: dict | None) -> str | None:
    if not identity:
        return None
    course = " ".join(str(identity.get("course_name") or "").strip().lower().split())
    hole = identity.get("hole_number")
    if not course or hole is None:
        return None
    return f"{course}::hole-{int(hole):02d}"


def _safe_pin_distance(screen, tesseract_path: str | None) -> float | None:
    try:
        return float(target_card.read_target_card(screen, tesseract_path=tesseract_path).distance_yds)
    except Exception:
        return None


def _run_capture(script_name: str) -> tuple[bool, str]:
    script = Path(__file__).with_name(script_name)
    if not script.exists():
        return False, f"configured capture script does not exist: {script}"
    completed = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        cwd=str(REPO_ROOT),
        check=False,
    )
    return completed.returncode == 0, f"exit={completed.returncode}"


def _write_state(path: Path, orchestrator: RoundOrchestrator, extra: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = orchestrator.state()
    if extra:
        payload.update(extra)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _emit(payload: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, separators=(",", ":")), flush=True)
        return
    print(
        f"{payload.get('event')}: {payload.get('action')} | "
        f"{payload.get('identity_key') or '?'} | {payload.get('reason') or ''}",
        flush=True,
    )


def main() -> int:
    args = parse_args()
    upper_left_enabled = not bool(args.disable_upper_left)
    assumptions = Assumptions.load()
    config = assumptions.get("round_orchestrator")
    orchestrator = RoundOrchestrator(
        assumptions=assumptions,
        actions_enabled=bool(args.execute_actions),
    )
    state_path = Path(args.state_file)
    stable_key = None
    stable_action = None
    stable_count = 0
    reported: set[tuple[str, str]] = set()

    if not args.json:
        print("Looper GSPro round watcher")
        print("ACTIONS: ENABLED" if args.execute_actions else "ACTIONS: DRY RUN (default)")
        if not args.execute_actions:
            print("No GSPro keys or capture scripts will run.")
        print("Upper-left shot-state OCR: CALIBRATED/ENABLED" if upper_left_enabled else "Upper-left shot-state OCR: DISABLED")
        print("Upper-left provides player + shot number + decimal DTP + signed elevation in non-practice rounds.")
        print("Post-tee events are planned from shot-number advancement; automatic post-tee execution remains intentionally disabled in this watcher.")
        print("Ctrl+C to stop.")

    try:
        while True:
            started = time.perf_counter()
            screen = base.capture_monitor(args.monitor)
            minimap, _ = base.crop_minimap(screen, args.roi)

            try:
                surface = minimap_surface.read_minimap_surface(minimap, tesseract_path=args.tesseract)
            except Exception:
                surface = None

            upper_left = None
            upper_left_warning = None
            if upper_left_enabled:
                try:
                    upper_left = upper_left_state.read_upper_left_state(
                        screen,
                        shot_roi=args.upper_left_shot_roi,
                        distance_roi=args.upper_left_distance_roi,
                        elevation_roi=args.upper_left_elevation_roi,
                        player_roi=args.upper_left_player_roi,
                        tesseract_path=args.tesseract,
                    )
                except Exception as exc:
                    upper_left_warning = str(exc)

            identity = None
            identity_warning = None
            pin_distance = None
            # A tee needs the new upper-right identity. On an established non-tee
            # hole we reuse active identity; shot-number changes provide progression.
            should_read_identity = surface is None or not surface.recognized or surface.is_tee
            if should_read_identity:
                identity, identity_warning = round_identity.try_read_round_identity(
                    screen,
                    tesseract_path=args.tesseract,
                )
                if surface is not None and surface.is_tee:
                    # Non-practice upper-left DTP is more precise and already being
                    # read for lifecycle. Keep the large PIN card as fallback/cross-check.
                    if upper_left is not None and upper_left.distance_to_pin_yds is not None:
                        pin_distance = float(upper_left.distance_to_pin_yds)
                    else:
                        pin_distance = _safe_pin_distance(screen, args.tesseract)
            else:
                identity_payload = orchestrator.tracker.active_identity

            if identity is not None:
                identity_payload = identity.to_dict()
            elif should_read_identity:
                identity_payload = None

            surface_is_tee = surface.is_tee if surface is not None and surface.recognized else None
            surface_label = surface.label if surface is not None and surface.recognized else None
            observation = RoundObservation(
                identity=identity_payload,
                minimap_surface_label=surface_label,
                minimap_surface_is_tee=surface_is_tee,
                minimap_surface_confidence=(surface.confidence if surface is not None else None),
                upper_left_shot_number=(upper_left.shot_number if upper_left is not None else None),
                upper_left_distance_to_pin_yds=(upper_left.distance_to_pin_yds if upper_left is not None else None),
                pin_card_distance_to_pin_yds=(
                    None
                    if upper_left is not None and upper_left.distance_to_pin_yds is not None
                    else pin_distance
                ),
                flat_lie=None,
                full_hole_minimap=None,
            )
            action = orchestrator.observe(observation)
            key = action.identity_key or _identity_key(identity_payload)

            candidate = action.action if action.action != "none" else None
            if candidate is not None and candidate == stable_action and key == stable_key:
                stable_count += 1
            elif candidate is not None:
                stable_action = candidate
                stable_key = key
                stable_count = 1
            else:
                stable_action = None
                stable_key = None
                stable_count = 0

            required_stable = (
                int(config["tee_stable_observations"])
                if candidate == "capture-tee"
                else int(config["normal_state_stable_observations"])
            )
            shot_suffix = (
                f"shot-{upper_left.shot_number}"
                if upper_left is not None and upper_left.shot_number is not None
                else "no-shot-counter"
            )
            report_key = (candidate or "none", f"{key or '?'}::{shot_suffix}")
            if candidate is not None and stable_count >= required_stable and report_key not in reported:
                event = {
                    "event": "planned-action",
                    "action": action.action,
                    "identity_key": key,
                    "reason": action.reason,
                    "execute_allowed": action.execute_allowed,
                    "stable_observations": stable_count,
                    "identity_warning": identity_warning,
                    "upper_left_warning": upper_left_warning,
                    "upper_left": upper_left.to_dict() if upper_left is not None else None,
                    "surface": surface.to_dict() if surface is not None else None,
                    "plan": action.to_dict(),
                }
                _emit(event, args.json)
                reported.add(report_key)

                if action.action == "capture-tee":
                    success = True
                    execution_detail = "dry-run simulated acceptance"
                    if args.execute_actions:
                        success, execution_detail = _run_capture(str(config["tee_capture_command"]))
                    if success:
                        orchestrator.accept_tee_capture(identity=identity_payload)
                        _emit({
                            "event": "tee-capture-accepted",
                            "action": "capture-tee",
                            "identity_key": key,
                            "reason": execution_detail,
                        }, args.json)
                    else:
                        _emit({
                            "event": "tee-capture-failed",
                            "action": "capture-tee",
                            "identity_key": key,
                            "reason": execution_detail,
                        }, args.json)
                elif action.action == "capture-posttee" and args.execute_actions:
                    _emit({
                        "event": "posttee-execution-blocked",
                        "action": "capture-posttee",
                        "identity_key": key,
                        "reason": "shot transition recognized, but automatic post-tee execution is not yet field-enabled",
                    }, args.json)

            _write_state(state_path, orchestrator, {
                "last_surface": surface.to_dict() if surface is not None else None,
                "last_identity": identity_payload,
                "last_upper_left": upper_left.to_dict() if upper_left is not None else None,
                "last_planned_action": action.to_dict(),
                "updated_local_epoch": time.time(),
            })

            if args.once:
                return 0

            elapsed = (time.perf_counter() - started) * 1000.0
            sleep_ms = max(0.0, float(args.poll_ms) - elapsed)
            if sleep_ms:
                time.sleep(sleep_ms / 1000.0)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
