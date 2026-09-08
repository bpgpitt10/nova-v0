#!/usr/bin/env python3
"""Persistent GSPro tee/post-tee capture watcher for minimap field validation.

Python direct execution is dry-run by default. The Windows launcher enables capture
execution unless it is called with -DryRun.

Safety contract for this validation watcher:
- tee: proven v8 capture; Y may be toggled and is restored; W is never used;
- post-tee: v1 geometry/visibility dry run; no W and no Y;
- no recommendation actuation and no persistent aim change;
- one tee attempt per hole and one post-tee attempt per observed shot number.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Any

import numpy as np

import minimap_surface
import probe as base
import round_identity
import target_card


REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "gspro-round-watch.json"
DEFAULT_STATE_PATH = Path(__file__).with_name("output") / "round_watch_state.json"


def _load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def parse_args() -> argparse.Namespace:
    cfg = _load_config()["watcher"]
    p = argparse.ArgumentParser(description="Looper persistent GSPro minimap capture watcher")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--tesseract")
    p.add_argument("--poll-ms", type=float, default=float(cfg["poll_ms"]))
    p.add_argument("--execute-actions", action="store_true")
    p.add_argument("--state-file", default=str(DEFAULT_STATE_PATH))
    p.add_argument("--resume", action="store_true", help="Load existing watcher state instead of starting fresh")
    p.add_argument("--once", action="store_true")
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def _crop_normalized(screen: np.ndarray, bounds: list[float]) -> np.ndarray:
    if screen is None or screen.size == 0:
        raise ValueError("screen is empty")
    h, w = screen.shape[:2]
    x1f, y1f, x2f, y2f = [float(v) for v in bounds]
    x1 = max(0, min(w - 1, int(round(w * x1f))))
    y1 = max(0, min(h - 1, int(round(h * y1f))))
    x2 = max(x1 + 1, min(w, int(round(w * x2f))))
    y2 = max(y1 + 1, min(h, int(round(h * y2f))))
    return screen[y1:y2, x1:x2].copy()


def _read_shot_number(screen: np.ndarray, *, tesseract_path: str | None, cfg: dict) -> tuple[int | None, str]:
    crop = _crop_normalized(screen, cfg["roi_normalized"])
    tess = target_card._resolve_tesseract(tesseract_path)
    raw = target_card._ocr(crop, tess, "0123456789", psm=str(cfg["ocr_psm"])).strip()
    match = re.search(r"\d+", raw)
    if not match:
        return None, raw
    value = int(match.group(0))
    if value < int(cfg["minimum"]) or value > int(cfg["maximum"]):
        return None, raw
    return value, raw


def _blank_state() -> dict[str, Any]:
    return {
        "schema_version": "gspro-round-watch-state-v0",
        "active_identity_key": None,
        "active_identity": None,
        "last_shot_number": None,
        "tee_attempted_keys": [],
        "posttee_attempted_keys": [],
        "events": [],
        "updated_local_epoch": None,
    }


def _load_state(path: Path, resume: bool) -> dict[str, Any]:
    if not resume or not path.exists():
        return _blank_state()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("state root is not an object")
        state = _blank_state()
        state.update(payload)
        return state
    except Exception as exc:
        print(f"WARNING: could not load watcher state; starting fresh: {exc}", flush=True)
        return _blank_state()


def _write_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_local_epoch"] = time.time()
    encoded = (json.dumps(state, indent=2) + "\n").encode("utf-8")
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp_path.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass


def _record_event(state: dict[str, Any], event: dict[str, Any], max_events: int = 200) -> None:
    events = state.setdefault("events", [])
    events.append(event)
    if len(events) > max_events:
        del events[:-max_events]


def _emit(event: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(event, separators=(",", ":")), flush=True)
        return
    detail = event.get("detail") or ""
    print(f"[{event.get('event')}] {event.get('action') or ''} {event.get('identity_key') or ''} {detail}".strip(), flush=True)


def _powershell_capture_command(script_name: str, args: argparse.Namespace, *, tee: bool) -> list[str]:
    script = Path(__file__).with_name(script_name)
    command = [
        "powershell", "-ExecutionPolicy", "Bypass", "-File", str(script),
        "-Monitor", str(args.monitor),
    ]
    if args.roi:
        command += ["-Roi", str(args.roi)]
    if args.tesseract:
        command += ["-Tesseract", str(args.tesseract)]
    if tee:
        command += ["-NoReviewZip"]
    return command


def _run_capture(script_name: str, args: argparse.Namespace, *, tee: bool) -> tuple[bool, str]:
    script = Path(__file__).with_name(script_name)
    if not script.exists():
        return False, f"capture script missing: {script}"
    completed = subprocess.run(
        _powershell_capture_command(script_name, args, tee=tee),
        cwd=str(REPO_ROOT),
        check=False,
    )
    return completed.returncode == 0, f"exit={completed.returncode}"


def _candidate_key(action: str | None, identity_key: str | None, shot_number: int | None) -> str | None:
    if action == "capture-tee" and identity_key:
        return f"tee::{identity_key}"
    if action == "capture-posttee" and identity_key and shot_number is not None:
        return f"posttee::{identity_key}::shot-{shot_number}"
    return None


def main() -> int:
    args = parse_args()
    cfg = _load_config()
    watcher_cfg = cfg["watcher"]
    shot_cfg = cfg["screen_detection"]["shot_counter"]
    state_path = Path(args.state_file)
    state = _load_state(state_path, args.resume)

    stable_key: str | None = None
    stable_count = 0
    last_action_epoch_ms = 0.0
    last_counter_warning: tuple[int | None, int | None] | None = None

    if not args.json:
        print("Looper GSPro persistent minimap watcher")
        print("CAPTURE MODE: ACTIVE" if args.execute_actions else "CAPTURE MODE: DRY RUN")
        print("Tee: v8 HoleModel capture; Y restored; W disabled.")
        print("Post-tee: v1 canonical registration + green visibility; NO W; NO Y.")
        print("One launch is intended to cover several holes. Ctrl+C stops cleanly.")
        print(f"State: {state_path}")
        if args.resume:
            print("State policy: RESUME existing session.")
        else:
            print("State policy: FRESH session.")

    try:
        while True:
            loop_start = time.perf_counter()
            screen = base.capture_monitor(args.monitor)
            minimap, _ = base.crop_minimap(screen, args.roi)

            try:
                surface = minimap_surface.read_minimap_surface(minimap, tesseract_path=args.tesseract)
            except Exception as exc:
                surface = None
                surface_warning = str(exc)
            else:
                surface_warning = None

            shot_number = None
            shot_raw = ""
            try:
                shot_number, shot_raw = _read_shot_number(screen, tesseract_path=args.tesseract, cfg=shot_cfg)
            except Exception as exc:
                shot_warning = str(exc)
            else:
                shot_warning = None

            identity = None
            identity_warning = None
            identity_key = state.get("active_identity_key")
            is_tee = bool(surface is not None and surface.recognized and surface.is_tee)
            is_non_tee = bool(surface is not None and surface.recognized and not surface.is_tee)
            if is_tee:
                identity, identity_warning = round_identity.try_read_round_identity(
                    screen,
                    tesseract_path=args.tesseract,
                )
                if identity is not None and identity.cache_key:
                    identity_key = identity.cache_key

            action: str | None = None
            reason = ""
            active_key = state.get("active_identity_key")
            tee_attempted = set(state.get("tee_attempted_keys") or [])
            posttee_attempted = set(state.get("posttee_attempted_keys") or [])

            if is_tee and identity_key and identity_key != active_key and identity_key not in tee_attempted:
                action = "capture-tee"
                reason = "stable Tee surface + new course/hole identity"
            elif active_key and is_non_tee and shot_number is not None:
                last_shot = state.get("last_shot_number")
                if last_shot is None:
                    state["last_shot_number"] = shot_number
                    reason = "established post-tee shot counter baseline"
                elif shot_number == last_shot + 1:
                    post_key = _candidate_key("capture-posttee", active_key, shot_number)
                    if post_key not in posttee_attempted:
                        action = "capture-posttee"
                        identity_key = active_key
                        reason = f"shot counter advanced {last_shot}->{shot_number}"
                elif shot_number > last_shot + int(watcher_cfg["maximum_forward_shot_jump"]):
                    warning_key = (last_shot, shot_number)
                    if warning_key != last_counter_warning:
                        event = {
                            "event": "counter-jump",
                            "action": "none",
                            "identity_key": active_key,
                            "detail": f"shot counter jumped {last_shot}->{shot_number}; baselining without automatic capture",
                            "shot_raw": shot_raw,
                        }
                        _emit(event, args.json)
                        _record_event(state, event)
                        last_counter_warning = warning_key
                    state["last_shot_number"] = shot_number
                elif shot_number < last_shot:
                    warning_key = (last_shot, shot_number)
                    if warning_key != last_counter_warning:
                        event = {
                            "event": "counter-reset",
                            "action": "none",
                            "identity_key": active_key,
                            "detail": f"shot counter moved backward {last_shot}->{shot_number}; baselining without automatic capture",
                            "shot_raw": shot_raw,
                        }
                        _emit(event, args.json)
                        _record_event(state, event)
                        last_counter_warning = warning_key
                    state["last_shot_number"] = shot_number

            candidate_key = _candidate_key(action, identity_key, shot_number)
            if candidate_key and candidate_key == stable_key:
                stable_count += 1
            elif candidate_key:
                stable_key = candidate_key
                stable_count = 1
            else:
                stable_key = None
                stable_count = 0

            required = (
                int(watcher_cfg["tee_stable_observations"])
                if action == "capture-tee"
                else int(watcher_cfg["posttee_stable_observations"])
            )
            now_ms = time.monotonic() * 1000.0
            interval_ok = (now_ms - last_action_epoch_ms) >= float(watcher_cfg["minimum_action_interval_ms"])

            if action and candidate_key and stable_count >= required and interval_ok:
                planned = {
                    "event": "planned-action",
                    "action": action,
                    "identity_key": identity_key,
                    "detail": reason,
                    "shot_number": shot_number,
                    "shot_raw": shot_raw,
                    "surface": surface.to_dict() if surface is not None else None,
                    "identity": identity.to_dict() if identity is not None else state.get("active_identity"),
                    "surface_warning": surface_warning,
                    "shot_warning": shot_warning,
                    "identity_warning": identity_warning,
                    "execute_allowed": bool(args.execute_actions),
                }
                _emit(planned, args.json)
                _record_event(state, planned)
                last_action_epoch_ms = now_ms

                success = True
                detail = "dry-run simulated success"
                if args.execute_actions:
                    script_name = (
                        str(watcher_cfg["tee_capture_command"])
                        if action == "capture-tee"
                        else str(watcher_cfg["posttee_capture_command"])
                    )
                    success, detail = _run_capture(script_name, args, tee=(action == "capture-tee"))

                outcome = {
                    "event": "capture-succeeded" if success else "capture-failed",
                    "action": action,
                    "identity_key": identity_key,
                    "detail": detail,
                    "shot_number": shot_number,
                }
                _emit(outcome, args.json)
                _record_event(state, outcome)

                if action == "capture-tee":
                    state.setdefault("tee_attempted_keys", []).append(candidate_key.replace("tee::", "", 1))
                    if success:
                        state["active_identity_key"] = identity_key
                        state["active_identity"] = identity.to_dict() if identity is not None else None
                        state["last_shot_number"] = shot_number if shot_number is not None else 1
                else:
                    state.setdefault("posttee_attempted_keys", []).append(candidate_key)
                    state["last_shot_number"] = shot_number

                stable_key = None
                stable_count = 0

            _write_state(state_path, state)

            if args.once:
                return 0

            elapsed_ms = (time.perf_counter() - loop_start) * 1000.0
            sleep_ms = max(0.0, float(args.poll_ms) - elapsed_ms)
            if sleep_ms:
                time.sleep(sleep_ms / 1000.0)
    except KeyboardInterrupt:
        _write_state(state_path, state)
        if not args.json:
            print("Watcher stopped. State saved.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
