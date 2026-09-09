#!/usr/bin/env python3
"""Looper GSPro watcher v3: deterministic round lifecycle + parallel evidence fusion.

Normal-play authority:
- currentRound.dat new ShotID = completed-shot truth;
- terminal completed shots move Hole N -> EXPECT_NEXT_TEE for Hole N+1;
- GSPro.db ActiveHole, output_log currentHole, header OCR, literal Shot N OCR, and
  minimap Tee are corroborating evidence around transitions, not competing identities;
- par/yard fallback is bootstrap-only;
- round identity and screen/capture readiness are deliberately separate.

Field-validation instrumentation:
- round_watch_evidence_v3.jsonl records source-by-source evidence as it changes;
- existing AIM-card perturb/return behavior is unchanged; capture probes run with
  DeepDebug by default so those already-generated intermediate frames are retained.

Safety:
- no auto-aim recommendation actuation;
- W remains disabled;
- post-tee Y remains disabled;
- tee capture keeps the existing proven Y toggle/restore sequence.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from typing import Any, Mapping
import uuid

import cv2

import minimap_surface
import probe as base
import round_identity
import target_card
import round_watch as legacy

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "gspro-round-watch.json"
OUTPUT_ROOT = Path(__file__).with_name("output")
DEFAULT_STATE_PATH = OUTPUT_ROOT / "round_watch_state_v3.json"
DEFAULT_GSPRO_DIR = Path.home() / "AppData" / "LocalLow" / "GSPro" / "GSPro"
EVIDENCE_PATH = OUTPUT_ROOT / "round_watch_evidence_v3.jsonl"

BOOTSTRAP = "BOOTSTRAP"
PLAYING = "PLAYING_HOLE"
EXPECT_NEXT = "EXPECT_NEXT_TEE"
COMPLETE = "ROUND_COMPLETE"
FULL_SHOT_SURFACES = {"fairway", "rough", "sand", "bunker", "fringe"}

_ACTIVE_RE = re.compile(
    r"ActivePlayer\s*:\s*(\d+).*?currentHole\s*:\s*(\d+).*?strokes\s*:\s*(\d+)",
    re.IGNORECASE,
)
_CURRENT_HOLE_RE = re.compile(r"\bcurrentHole\s*:\s*(\d+)", re.IGNORECASE)


def _cfg() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def parse_args() -> argparse.Namespace:
    cfg = _cfg()["watcher"]
    p = argparse.ArgumentParser(description="Looper deterministic GSPro watcher v3")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi")
    p.add_argument("--tesseract")
    p.add_argument("--poll-ms", type=float, default=min(350.0, float(cfg.get("poll_ms", 500))))
    p.add_argument("--execute-actions", action="store_true")
    p.add_argument("--state-file", default=str(DEFAULT_STATE_PATH))
    p.add_argument("--resume", action="store_true")
    p.add_argument("--once", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--gspro-dir", default=str(DEFAULT_GSPRO_DIR))
    p.add_argument("--posttee-min-settle-ms", type=float, default=850.0)
    p.add_argument("--capture-retry-ms", type=float, default=900.0)
    p.add_argument("--max-capture-attempts", type=int, default=2)
    p.add_argument("--transition-stable-observations", type=int, default=2)
    p.add_argument("--no-aim-debug", action="store_true")
    return p.parse_args()


def _ensure_python314_ocr_compat() -> None:
    """Patch the existing helper locally so child tee/post-tee probes also work on 3.14."""
    path = Path(__file__).with_name("target_card.py")
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    old = 'windows_hidden=True if os.name == "nt" else False,'
    new = 'creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,'
    if old in text:
        path.write_text(text.replace(old, new), encoding="utf-8")


def _blank_state() -> dict[str, Any]:
    return {
        "schema_version": "gspro-round-watch-state-v3",
        "session_id": None,
        "phase": BOOTSTRAP,
        "course_name": None,
        "current_hole": None,
        "expected_next_hole": None,
        "active_identity": None,
        "active_identity_key": None,
        "active_tee_capture_dir": None,
        "pending_tee": None,
        "pending_posttee": None,
        "tee_captured_holes": [],
        "posttee_captured_shot_ids": [],
        "current_round_baselined": False,
        "current_round_seen_shot_ids": [],
        "current_round_last_signature": None,
        "current_round_latest": None,
        "output_log_offset": None,
        "output_log_carry": "",
        "output_log_last_hole_display": None,
        "db_active_hole_display": None,
        "last_transition_fusion": None,
        "last_evidence_signature": None,
        "events": [],
        "updated_local_epoch": None,
    }


def _load_state(path: Path, resume: bool) -> dict[str, Any]:
    state = _blank_state()
    if resume and path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                state.update(payload)
        except Exception as exc:
            print(f"WARNING: could not resume watcher state: {exc}", flush=True)
    if not resume or not state.get("session_id"):
        state["session_id"] = f"round-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    return state


def _emit(state: dict[str, Any], event: dict[str, Any], as_json: bool) -> None:
    event = dict(event)
    event.setdefault("epoch", time.time())
    event.setdefault("watcher_session_id", state.get("session_id"))
    events = state.setdefault("events", [])
    events.append(event)
    if len(events) > 300:
        del events[:-300]
    if as_json:
        print(json.dumps(event, separators=(",", ":"), default=str), flush=True)
    else:
        print(
            f"[{event.get('event')}] {event.get('action') or ''} "
            f"{event.get('identity_key') or ''} {event.get('detail') or ''}".strip(),
            flush=True,
        )


def _write_state(path: Path, state: dict[str, Any]) -> None:
    legacy._write_state(path, state)


def _append_evidence(state: dict[str, Any], payload: dict[str, Any]) -> None:
    canonical = json.dumps(payload, sort_keys=True, default=str)
    sig = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if sig == state.get("last_evidence_signature"):
        return
    state["last_evidence_signature"] = sig
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    row = {
        "epoch": time.time(),
        "watcher_session_id": state.get("session_id"),
        **payload,
    }
    with EVIDENCE_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, separators=(",", ":"), default=str) + "\n")


def _normalize_course(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").lower()))


def _identity_key(identity: Mapping[str, Any] | None, hole: int | None = None) -> str | None:
    if not identity:
        return None
    course = _normalize_course(identity.get("course_name"))
    if not course:
        return None
    resolved = hole if hole is not None else _int(identity.get("hole_number"))
    if resolved is not None:
        return f"{course}::hole-{resolved:02d}"
    par, yards = _int(identity.get("par")), _int(identity.get("hole_yards"))
    if par is not None and yards is not None:
        return f"{course}::fallback-par-{par}-yards-{yards}"
    return None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except Exception:
        return None


def _mapping_get(mapping: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    lowered = {str(k).lower(): k for k in mapping}
    for name in names:
        key = lowered.get(name.lower())
        if key is not None:
            return mapping[key]
    return None


def _decode_json(raw: bytes) -> Any:
    last: Exception | None = None
    for enc in ("utf-8-sig", "utf-16", "utf-8"):
        try:
            return json.loads(raw.decode(enc))
        except Exception as exc:
            last = exc
    raise ValueError(f"could not decode currentRound.dat: {last}")


def _shot_list(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, Mapping)]
    if not isinstance(payload, Mapping):
        return []
    for key in ("shots", "Shots", "currentRound", "CurrentRound", "roundShots", "RoundShots"):
        value = payload.get(key)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, Mapping)]
    return [payload] if _mapping_get(payload, "ShotID") is not None else []


def _summarize_shot(item: Mapping[str, Any]) -> dict[str, Any]:
    active = _mapping_get(item, "activeShot")
    active = active if isinstance(active, Mapping) else {}
    sd = _mapping_get(active, "sd")
    sd = sd if isinstance(sd, Mapping) else {}
    raw_hole = _int(_mapping_get(item, "Hole"))
    return {
        "shot_id": _mapping_get(item, "ShotID"),
        "round_id": _mapping_get(item, "RoundID"),
        "course_key": _mapping_get(item, "CourseKey"),
        "hole_raw_zero_based": raw_hole,
        "hole_display": raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None,
        "hole_shot": _int(_mapping_get(item, "HoleShot")),
        "hole_par": _int(_mapping_get(item, "HolePar")),
        "distance_to_pin_raw": _mapping_get(item, "DistanceToPin"),
        "starting_surface_raw": _mapping_get(item, "StartingSurface"),
        "ending_surface_raw": _mapping_get(item, "EndingSurface"),
        "is_putt": bool(_mapping_get(sd, "isPutt")),
        "is_holed": bool(_mapping_get(sd, "isHoled")),
        "is_gimme": bool(_mapping_get(sd, "isGimme")),
        "water_hit": _mapping_get(sd, "waterhit"),
    }


def _read_current_round(path: Path, state: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    try:
        if not path.exists():
            return [], "currentRound.dat missing"
        stat = path.stat()
        signature = f"{stat.st_mtime_ns}:{stat.st_size}"
        if signature == state.get("current_round_last_signature"):
            return [], None
        raw = path.read_bytes()
        payload = _decode_json(raw)
        shots = [_summarize_shot(x) for x in _shot_list(payload)]
        state["current_round_last_signature"] = signature
        state["current_round_latest"] = shots[-1] if shots else None
        ids = [str(x["shot_id"]) for x in shots if x.get("shot_id") not in (None, "")]
        if not state.get("current_round_baselined"):
            state["current_round_baselined"] = True
            state["current_round_seen_shot_ids"] = ids
            return [], None
        seen = set(str(x) for x in state.get("current_round_seen_shot_ids") or [])
        new = [x for x in shots if x.get("shot_id") not in (None, "") and str(x["shot_id"]) not in seen]
        seen.update(ids)
        state["current_round_seen_shot_ids"] = sorted(seen)
        return new, None
    except Exception as exc:
        return [], str(exc)


def _read_db(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        if not path.exists():
            return None, "GSPro.db missing"
        con = sqlite3.connect(str(path), timeout=0.05)
        try:
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA query_only=ON")
            cols = [str(r[1]) for r in con.execute('PRAGMA table_info("Round")').fetchall()]
            wanted = [x for x in ("ID", "CourseName", "CourseCode", "ActiveHole", "RoundStatus") if x in cols]
            if not wanted:
                return None, "Round table fields unavailable"
            row = con.execute(
                f'SELECT {",".join(chr(34)+x+chr(34) for x in wanted)} FROM "Round" ORDER BY "ID" DESC LIMIT 1'
            ).fetchone()
            if row is None:
                return None, None
            out = dict(row)
            raw = _int(out.get("ActiveHole"))
            out["ActiveHoleRawZeroBased"] = raw
            out["ActiveHoleDisplay"] = raw + 1 if raw is not None and 0 <= raw <= 17 else None
            return out, None
        finally:
            con.close()
    except Exception as exc:
        return None, str(exc)


def _read_log(path: Path, state: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    try:
        if not path.exists():
            return [], "output_log.txt missing"
        size = path.stat().st_size
        offset = state.get("output_log_offset")
        if offset is None:
            state["output_log_offset"] = size
            return [], None
        if size < int(offset):
            offset = 0
            state["output_log_carry"] = ""
        if size <= int(offset):
            return [], None
        with path.open("rb") as handle:
            handle.seek(int(offset))
            raw = handle.read(size - int(offset))
        state["output_log_offset"] = int(offset) + len(raw)
        text = str(state.get("output_log_carry") or "") + raw.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        carry = ""
        facts: list[dict[str, Any]] = []
        for part in lines:
            if not part.endswith(("\n", "\r")):
                carry = part
                continue
            line = part.rstrip("\r\n")
            lower = line.lower()
            if "allplayersholedout" in lower:
                facts.append({"kind": "hole_terminal", "raw": line})
            match = _ACTIVE_RE.search(line)
            if match:
                raw_hole = int(match.group(2))
                facts.append({"kind": "active_game_state", "hole_display": raw_hole + 1, "strokes": int(match.group(3)), "raw": line})
            elif (match := _CURRENT_HOLE_RE.search(line)):
                raw_hole = int(match.group(1))
                facts.append({"kind": "current_hole_observation", "hole_display": raw_hole + 1, "raw": line})
            if "within gimmie distance" in lower or "within gimme distance" in lower:
                facts.append({"kind": "gimmie_selected", "raw": line})
        state["output_log_carry"] = carry
        for fact in facts:
            if fact.get("hole_display") is not None:
                state["output_log_last_hole_display"] = int(fact["hole_display"])
        return facts, None
    except Exception as exc:
        return [], str(exc)


def _crop_normalized(screen, bounds: tuple[float, float, float, float]):
    h, w = screen.shape[:2]
    x1, y1, x2, y2 = bounds
    return screen[int(h*y1):int(h*y2), int(w*x1):int(w*x2)].copy()


def _safe_shot_number(screen, tesseract: str | None) -> tuple[int | None, str, str | None]:
    try:
        crop = _crop_normalized(screen, (0.010, 0.055, 0.052, 0.090))
        tess = target_card._resolve_tesseract(tesseract)
        raw = target_card._ocr(crop, tess, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ", psm="7").strip()
        match = re.search(r"\bshot\s*([0-9]{1,2})\b", raw, flags=re.IGNORECASE)
        value = int(match.group(1)) if match else None
        return (value if value is not None and 1 <= value <= 20 else None), raw, None
    except Exception as exc:
        return None, "", str(exc)


def _safe_surface(minimap, tesseract: str | None):
    try:
        return minimap_surface.read_minimap_surface(minimap, tesseract_path=tesseract), None
    except Exception as exc:
        return None, str(exc)


def _safe_header(screen, tesseract: str | None) -> tuple[dict[str, Any] | None, str | None]:
    try:
        identity, warning = round_identity.try_read_round_identity(screen, tesseract_path=tesseract)
        return (identity.to_dict() if identity is not None else None), warning
    except Exception as exc:
        return None, str(exc)


def _safe_pin(screen, tesseract: str | None) -> tuple[float | None, str | None]:
    try:
        return float(target_card.read_target_card(screen, tesseract_path=tesseract).distance_yds), None
    except Exception as exc:
        return None, str(exc)


def _bootstrap(header: Mapping[str, Any] | None, db: Mapping[str, Any] | None, shot: int | None, tee: bool):
    hh = _int((header or {}).get("hole_number"))
    dh = _int((db or {}).get("ActiveHoleDisplay"))
    contradictions = []
    if hh is not None and dh is not None and hh != dh:
        contradictions.append(f"header={hh} vs db={dh}")
    course = str((header or {}).get("course_name") or (db or {}).get("CourseName") or "").strip() or None
    hole = hh if hh is not None else dh
    support = []
    if hh is not None: support.append(f"header_hole={hh}")
    if dh is not None: support.append(f"db_hole={dh}")
    if shot == 1: support.append("shot=1")
    if tee: support.append("tee")
    if contradictions:
        return None, {"accepted": False, "support": support, "contradictions": contradictions, "mode": "bootstrap"}
    preshot = shot == 1 or tee
    candidate = dict(header or {})
    if course: candidate["course_name"] = course
    fallback = False
    if hole is not None:
        candidate["hole_number"] = hole
    elif course and candidate.get("par") is not None and candidate.get("hole_yards") is not None and shot == 1 and tee:
        fallback = True
    accepted = bool(course and preshot and (hole is not None or fallback))
    return (candidate if accepted else None), {
        "accepted": accepted,
        "support": support + (["bootstrap_fallback=par+yards"] if fallback else []),
        "contradictions": [],
        "mode": "bootstrap-fallback" if fallback else "bootstrap",
    }


def _transition(current: int, expected: int, db_hole: int | None, log_hole: int | None, header_hole: int | None, shot: int | None, tee: bool) -> dict[str, Any]:
    matches, stale, contradictions = [], [], []
    for name, value in (("db", db_hole), ("log", log_hole), ("header", header_hole)):
        if value is None:
            stale.append(f"{name}=unknown")
        elif value == expected:
            matches.append(f"{name}=expected-{expected}")
        elif value == current:
            stale.append(f"{name}=stale-{current}")
        else:
            contradictions.append(f"{name}={value}")
    preshot = []
    if shot == 1:
        preshot.append("shot=1")
    elif shot is not None:
        contradictions.append(f"shot={shot}")
    if tee:
        preshot.append("tee")
    accepted = False
    if not contradictions:
        if db_hole == expected:
            accepted = True
        elif len(matches) >= 2:
            accepted = True
        elif len(matches) >= 1 and len(preshot) >= 1:
            accepted = True
        elif len(preshot) >= 2:
            accepted = True
    score = max(0.0, min(1.0, 0.35 + 0.18*len(matches) + 0.12*len(preshot) - 0.25*len(contradictions)))
    return {
        "accepted": accepted,
        "expected_hole": expected,
        "deterministic_prior": f"hole-{current}-terminal -> expect-hole-{expected}",
        "hole_matches": matches,
        "preshot_matches": preshot,
        "stale_or_unknown": stale,
        "contradictions": contradictions,
        "uncalibrated_score": round(score, 3),
    }


def _enter_hole(state: dict[str, Any], hole: int, header: Mapping[str, Any] | None, db: Mapping[str, Any] | None, reason: str, as_json: bool) -> None:
    previous = state.get("active_identity") or {}
    identity: dict[str, Any] = {}
    if previous.get("course_name"):
        identity["course_name"] = previous["course_name"]
    if header:
        for k, v in header.items():
            if v is not None:
                identity[k] = v
    course = str((header or {}).get("course_name") or (db or {}).get("CourseName") or state.get("course_name") or "").strip()
    if course:
        identity["course_name"] = course
        state["course_name"] = course
    identity["hole_number"] = int(hole)
    identity["hole_number_source"] = "deterministic_round_progression" if state.get("phase") == EXPECT_NEXT else "bootstrap"
    state["current_hole"] = int(hole)
    state["expected_next_hole"] = None
    state["phase"] = PLAYING
    state["active_identity"] = identity
    state["active_identity_key"] = _identity_key(identity, hole)
    state["pending_tee"] = {"hole": int(hole), "entered_epoch": time.time(), "attempts": 0, "reason": reason}
    state["pending_posttee"] = None
    _emit(state, {"event": "hole-entered", "action": "prepare-tee-capture", "identity_key": state["active_identity_key"], "detail": f"Hole {hole} accepted: {reason}"}, as_json)


def _terminal(state: dict[str, Any], reason: str, as_json: bool) -> None:
    hole = _int(state.get("current_hole"))
    if hole is None or state.get("phase") == COMPLETE:
        return
    state["pending_posttee"] = None
    state["pending_tee"] = None
    if hole >= 18:
        state["phase"] = COMPLETE
        state["expected_next_hole"] = None
        _emit(state, {"event": "round-complete", "action": "none", "identity_key": state.get("active_identity_key"), "detail": f"Hole 18 terminal: {reason}; watcher idles until Ctrl+C"}, as_json)
    else:
        state["phase"] = EXPECT_NEXT
        state["expected_next_hole"] = hole + 1
        _emit(state, {"event": "hole-terminal", "action": "expect-next-tee", "identity_key": state.get("active_identity_key"), "detail": f"Hole {hole} terminal ({reason}); expecting Hole {hole+1}"}, as_json)


def _capture_dirs(tee: bool) -> set[str]:
    prefix = "tee_capture_" if tee else "approach_capture_"
    if not OUTPUT_ROOT.exists():
        return set()
    return {p.name for p in OUTPUT_ROOT.iterdir() if p.is_dir() and p.name.startswith(prefix)}


def _run_capture(script_name: str, args: argparse.Namespace, tee: bool) -> tuple[bool, str, Path | None]:
    script = Path(__file__).with_name(script_name)
    if not script.exists():
        return False, f"capture script missing: {script}", None
    before = _capture_dirs(tee)
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Monitor", str(args.monitor)]
    if args.roi: cmd += ["-Roi", str(args.roi)]
    if args.tesseract: cmd += ["-Tesseract", str(args.tesseract)]
    if not args.no_aim_debug: cmd += ["-DeepDebug"]
    if tee: cmd += ["-NoReviewZip"]
    completed = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False)
    prefix = "tee_capture_" if tee else "approach_capture_"
    created = [p for p in OUTPUT_ROOT.iterdir() if p.is_dir() and p.name.startswith(prefix) and p.name not in before] if OUTPUT_ROOT.exists() else []
    capture_dir = max(created, key=lambda p: p.stat().st_mtime) if created else None
    detail = f"exit={completed.returncode}" + (f"; capture_dir={capture_dir.name}" if capture_dir else "")
    return completed.returncode == 0, detail, capture_dir


def _geometry_status(capture_dir: Path | None) -> dict[str, Any] | None:
    if capture_dir is None:
        return None
    path = capture_dir / "shot_state.json"
    if not path.exists():
        return {"valid": False, "reason": "shot_state.json missing"}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"valid": False, "reason": f"shot_state.json unreadable: {exc}"}
    geometry = payload.get("canonical_geometry")
    warning = payload.get("canonical_geometry_warning")
    if not geometry:
        return {"valid": False, "reason": warning or "canonical geometry unavailable"}
    cross = geometry.get("pin_distance_crosscheck") or {}
    return {
        "valid": bool(cross.get("ok")),
        "reason": None if cross.get("ok") else "canonical PIN-distance cross-check failed",
        "screen_pin_distance_yds": cross.get("screen_pin_distance_yds"),
        "canonical_remaining_pin_yds": cross.get("canonical_remaining_pin_yds"),
        "error_yds": cross.get("error_yds"),
        "registration": geometry.get("registration"),
    }


def _save_capture_context(state: dict[str, Any], state_path: Path, capture_dir: Path, capture_type: str, screen_shot: int | None, structured_trigger: Mapping[str, Any] | None, success: bool, detail: str, geometry: Mapping[str, Any] | None, evidence: Mapping[str, Any]) -> None:
    identity = state.get("active_identity") or {}
    payload = {
        "schema_version": "gspro-capture-context-v2",
        "watcher_session_id": state.get("session_id"),
        "capture_type": capture_type,
        "identity_key": state.get("active_identity_key"),
        "course_name": identity.get("course_name"),
        "hole_number": identity.get("hole_number"),
        "par": identity.get("par"),
        "original_hole_yards": identity.get("hole_yards"),
        "screen_shot_number_validator": screen_shot,
        "structured_trigger": dict(structured_trigger or {}) or None,
        "capture_folder": capture_dir.name,
        "capture_succeeded": bool(success),
        "watcher_capture_detail": detail,
        "watcher_state_file": str(state_path),
        "geometry_validation": dict(geometry or {}) or None,
        "round_evidence": dict(evidence),
        "aim_debug_frames_retained": True,
        "tagged_local_epoch": time.time(),
        "identity": identity or None,
    }
    legacy._write_json_atomic(capture_dir / "capture_context.json", payload)


def _save_prelaunch(capture_dir: Path, screen, minimap, payload: Mapping[str, Any]) -> None:
    try:
        cv2.imwrite(str(capture_dir / "watcher_prelaunch_screen.png"), screen)
        cv2.imwrite(str(capture_dir / "watcher_prelaunch_minimap.png"), minimap)
        legacy._write_json_atomic(capture_dir / "watcher_prelaunch.json", dict(payload))
    except Exception:
        pass


def _structured_green(shot: Mapping[str, Any] | None) -> bool:
    if not shot:
        return False
    return any("green" in str(shot.get(k) or "").lower() for k in ("ending_surface_raw", "starting_surface_raw"))


def main() -> int:
    _ensure_python314_ocr_compat()
    args = parse_args()
    watcher_cfg = _cfg()["watcher"]
    state_path = Path(args.state_file)
    state = _load_state(state_path, args.resume)
    gspro_dir = Path(os.path.expandvars(os.path.expanduser(args.gspro_dir)))
    current_round = gspro_dir / "currentRound.dat"
    output_log = gspro_dir / "output_log.txt"
    db_path = gspro_dir / "GSPro.db"

    transition_sig = None
    transition_stable = 0
    last_pin: tuple[str, float] | None = None
    retry_not_before = 0.0

    if not args.json:
        print("Looper GSPro persistent watcher v3")
        print("CAPTURE MODE: ACTIVE" if args.execute_actions else "CAPTURE MODE: DRY RUN")
        print("ROUND: deterministic Hole N -> N+1 after terminal; fallback bootstrap only.")
        print("EVIDENCE: currentRound + output_log + GSPro.db + header OCR + literal Shot N + minimap Tee.")
        print("READINESS: separate from identity; PIN/screen must settle before capture.")
        print("AIM: no auto aim and no extra pulses; existing perturb/return debug frames retained." if not args.no_aim_debug else "AIM: no auto aim; existing perturb/return remains; extra debug retention off.")
        print("W OFF. Post-tee Y OFF. Hole 18 terminal -> idle.")
        print(f"Session: {state.get('session_id')}")
        print(f"Evidence: {EVIDENCE_PATH}")
        print(f"State: {state_path}")

    try:
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="looper-screen") as pool:
            while True:
                loop_start = time.perf_counter()
                now = time.time()

                new_shots, cr_warn = _read_current_round(current_round, state)
                db_row, db_warn = _read_db(db_path)
                db_hole = _int((db_row or {}).get("ActiveHoleDisplay"))
                if db_hole is not None:
                    state["db_active_hole_display"] = db_hole
                log_facts, log_warn = _read_log(output_log, state)
                log_hole = _int(state.get("output_log_last_hole_display"))
                log_terminal_now = any(x.get("kind") == "hole_terminal" for x in log_facts)

                for shot in new_shots:
                    shot_hole = _int(shot.get("hole_display"))
                    if shot_hole is not None and state.get("current_hole") is None:
                        state["current_hole"] = shot_hole
                    _emit(state, {"event": "shot-completed", "action": "observe", "identity_key": state.get("active_identity_key"), "detail": f"currentRound H{shot.get('hole_display')} S{shot.get('hole_shot')} ShotID={str(shot.get('shot_id'))[:10]}", "shot": shot}, args.json)

                    if state.get("active_identity") and shot_hole is not None:
                        identity = dict(state["active_identity"])
                        identity["hole_number"] = shot_hole
                        identity["hole_number_source"] = "currentRound completed-shot truth"
                        state["active_identity"] = identity
                        state["active_identity_key"] = _identity_key(identity, shot_hole)
                        state["current_hole"] = shot_hole

                    if shot.get("is_holed") or shot.get("is_gimme"):
                        _terminal(state, "currentRound isHoled/isGimme", args.json)
                        continue
                    if shot.get("is_putt"):
                        continue
                    hs = _int(shot.get("hole_shot"))
                    state["pending_posttee"] = {
                        "shot_id": str(shot.get("shot_id")),
                        "shot": shot,
                        "expected_next_shot_number": hs + 1 if hs is not None else None,
                        "completed_epoch": now,
                        "attempts": 0,
                    }
                    retry_not_before = now + args.posttee_min_settle_ms / 1000.0
                    last_pin = None

                screen = base.capture_monitor(args.monitor)
                minimap, _ = base.crop_minimap(screen, args.roi)
                fs = pool.submit(_safe_surface, minimap, args.tesseract)
                fn = pool.submit(_safe_shot_number, screen, args.tesseract)
                need_header = state.get("phase") in (BOOTSTRAP, EXPECT_NEXT) or bool(state.get("pending_tee"))
                fh = pool.submit(_safe_header, screen, args.tesseract) if need_header else None
                surface, surface_warn = fs.result()
                screen_shot, screen_shot_raw, shot_warn = fn.result()
                header, header_warn = fh.result() if fh else (None, None)
                header_hole = _int((header or {}).get("hole_number"))
                surface_tee = bool(surface is not None and surface.recognized and surface.is_tee)
                surface_label = str(surface.label or "").lower() if surface is not None and surface.recognized else None

                if state.get("phase") == PLAYING and state.get("current_hole") is not None:
                    cur = int(state["current_hole"])
                    if cur < 18 and screen_shot == 1 and surface_tee and not state.get("pending_tee"):
                        if db_hole == cur + 1 or log_terminal_now:
                            _emit(state, {"event": "terminal-recovery", "action": "expect-next-tee", "identity_key": state.get("active_identity_key"), "detail": f"Recovered missed terminal for Hole {cur}; expecting Hole {cur+1}"}, args.json)
                            state["phase"] = EXPECT_NEXT
                            state["expected_next_hole"] = cur + 1
                            state["pending_posttee"] = None

                if state.get("phase") == BOOTSTRAP:
                    candidate, fusion = _bootstrap(header, db_row, screen_shot, surface_tee)
                    state["last_transition_fusion"] = fusion
                    if candidate is not None:
                        hole = _int(candidate.get("hole_number"))
                        if hole is None:
                            state["course_name"] = candidate.get("course_name")
                            state["active_identity"] = candidate
                            state["active_identity_key"] = _identity_key(candidate)
                            state["phase"] = PLAYING
                            state["pending_tee"] = {"hole": None, "entered_epoch": now, "attempts": 0, "reason": "bootstrap fallback"}
                            _emit(state, {"event": "bootstrap-fallback", "action": "prepare-tee-capture", "identity_key": state.get("active_identity_key"), "detail": "Initial tee only: par/yard fallback; first completed shot resolves hole"}, args.json)
                        else:
                            _enter_hole(state, hole, candidate, db_row, "bootstrap evidence accepted", args.json)

                elif state.get("phase") == EXPECT_NEXT:
                    cur = int(state["current_hole"])
                    expected = int(state["expected_next_hole"])
                    fusion = _transition(cur, expected, db_hole, log_hole, header_hole, screen_shot, surface_tee)
                    state["last_transition_fusion"] = fusion
                    sig = json.dumps({"accepted": fusion["accepted"], "matches": fusion["hole_matches"], "preshot": fusion["preshot_matches"], "contradictions": fusion["contradictions"]}, sort_keys=True)
                    if fusion["accepted"]:
                        transition_stable = transition_stable + 1 if sig == transition_sig else 1
                        transition_sig = sig
                    else:
                        transition_sig = None
                        transition_stable = 0
                    if fusion["accepted"] and transition_stable >= max(1, args.transition_stable_observations):
                        _enter_hole(state, expected, header, db_row, f"deterministic expectation corroborated: {', '.join(fusion['hole_matches'] + fusion['preshot_matches'])}", args.json)
                        transition_sig = None
                        transition_stable = 0

                if state.get("phase") == PLAYING and header and state.get("current_hole") is not None:
                    cur = int(state["current_hole"])
                    if header_hole in (None, cur):
                        identity = dict(state.get("active_identity") or {})
                        for k, v in header.items():
                            if v is not None:
                                identity[k] = v
                        identity["hole_number"] = cur
                        state["active_identity"] = identity
                        state["active_identity_key"] = _identity_key(identity, cur)

                pending_tee = state.get("pending_tee")
                if pending_tee and state.get("phase") == PLAYING and now >= retry_not_before:
                    hole = _int(pending_tee.get("hole")) or _int(state.get("current_hole"))
                    captured = hole is not None and hole in {int(x) for x in state.get("tee_captured_holes") or []}
                    if not captured:
                        cues = []
                        if hole is not None and header_hole == hole: cues.append("header_expected_hole")
                        if screen_shot == 1: cues.append("shot_1")
                        if surface_tee: cues.append("tee")
                        pin, pin_warn = _safe_pin(screen, args.tesseract)
                        if cues and pin is not None:
                            if last_pin and last_pin[0] == "tee" and abs(last_pin[1] - pin) <= 0.5:
                                success, detail, capture_dir = (True, "dry-run simulated success", None)
                                if args.execute_actions:
                                    success, detail, capture_dir = _run_capture(str(watcher_cfg["tee_capture_command"]), args, True)
                                evidence_snapshot = {"phase": state.get("phase"), "current_hole": state.get("current_hole"), "db_hole": db_hole, "log_hole": log_hole, "header_hole": header_hole, "shot": screen_shot, "surface_tee": surface_tee, "fusion": state.get("last_transition_fusion")}
                                if capture_dir:
                                    _save_prelaunch(capture_dir, screen, minimap, {"capture_type": "tee", "pin_distance_yds": pin, "readiness_cues": cues, **evidence_snapshot})
                                    _save_capture_context(state, state_path, capture_dir, "tee", screen_shot, None, success, detail, None, evidence_snapshot)
                                _emit(state, {"event": "capture-succeeded" if success else "capture-failed", "action": "capture-tee", "identity_key": state.get("active_identity_key"), "detail": detail}, args.json)
                                if success:
                                    if hole is not None: state.setdefault("tee_captured_holes", []).append(hole)
                                    state["active_tee_capture_dir"] = capture_dir.name if capture_dir else None
                                    state["pending_tee"] = None
                                else:
                                    pending_tee["attempts"] = int(pending_tee.get("attempts") or 0) + 1
                                    retry_not_before = now + args.capture_retry_ms / 1000.0
                                last_pin = None
                            else:
                                last_pin = ("tee", pin)
                        else:
                            last_pin = None

                pending = state.get("pending_posttee")
                if pending and state.get("phase") != PLAYING:
                    state["pending_posttee"] = None
                    pending = None
                if pending and surface_tee:
                    state["pending_posttee"] = None
                    pending = None
                if pending and (_structured_green(pending.get("shot")) or surface_label == "green"):
                    _emit(state, {"event": "posttee-skipped", "action": "none", "identity_key": state.get("active_identity_key"), "detail": "green/putting state; full-shot watcher skips capture"}, args.json)
                    state["pending_posttee"] = None
                    pending = None

                if pending and now >= retry_not_before:
                    expected_shot = pending.get("expected_next_shot_number")
                    validator_ok = screen_shot is None or expected_shot is None or int(screen_shot) == int(expected_shot)
                    structured_surface = str((pending.get("shot") or {}).get("ending_surface_raw") or "").lower()
                    surface_ok = surface_label in FULL_SHOT_SURFACES or any(x in structured_surface for x in FULL_SHOT_SURFACES)
                    if validator_ok and surface_ok:
                        pin, pin_warn = _safe_pin(screen, args.tesseract)
                        if pin is not None:
                            if last_pin and last_pin[0] == "posttee" and abs(last_pin[1] - pin) <= 0.5:
                                pending["attempts"] = int(pending.get("attempts") or 0) + 1
                                success, detail, capture_dir = (True, "dry-run simulated success", None)
                                if args.execute_actions:
                                    success, detail, capture_dir = _run_capture(str(watcher_cfg["posttee_capture_command"]), args, False)
                                geometry = _geometry_status(capture_dir) if success else None
                                evidence_snapshot = {"phase": state.get("phase"), "current_hole": state.get("current_hole"), "db_hole": db_hole, "log_hole": log_hole, "shot_validator": screen_shot, "expected_next_shot": expected_shot, "surface": surface_label, "structured_surface": structured_surface}
                                if capture_dir:
                                    _save_prelaunch(capture_dir, screen, minimap, {"capture_type": "post-tee", "pin_distance_yds": pin, "structured_trigger": pending.get("shot"), **evidence_snapshot})
                                    _save_capture_context(state, state_path, capture_dir, "post-tee", screen_shot, pending.get("shot"), success, detail, geometry, evidence_snapshot)
                                geometry_valid = bool(geometry and geometry.get("valid")) if success else False
                                _emit(state, {"event": "capture-succeeded" if success else "capture-failed", "action": "capture-posttee", "identity_key": state.get("active_identity_key"), "detail": detail + (f"; geometry_valid={geometry_valid}" if success else ""), "geometry": geometry}, args.json)
                                if success and geometry_valid:
                                    state.setdefault("posttee_captured_shot_ids", []).append(str(pending.get("shot_id")))
                                    state["pending_posttee"] = None
                                elif int(pending.get("attempts") or 0) >= max(1, args.max_capture_attempts):
                                    state["pending_posttee"] = None
                                else:
                                    retry_not_before = now + args.capture_retry_ms / 1000.0
                                last_pin = None
                            else:
                                last_pin = ("posttee", pin)
                        else:
                            last_pin = None
                    else:
                        last_pin = None

                evidence = {
                    "phase": state.get("phase"),
                    "current_hole": state.get("current_hole"),
                    "expected_next_hole": state.get("expected_next_hole"),
                    "structured": {
                        "current_round_latest": state.get("current_round_latest"),
                        "db_active_hole_display": db_hole,
                        "db_round_id": (db_row or {}).get("ID"),
                        "output_log_last_hole_display": log_hole,
                        "output_log_facts": log_facts[-6:],
                    },
                    "screen": {
                        "shot_number": screen_shot,
                        "shot_raw": screen_shot_raw,
                        "surface": surface.to_dict() if surface is not None else None,
                        "header": header,
                    },
                    "fusion": state.get("last_transition_fusion"),
                    "warnings": {"current_round": cr_warn, "gspro_db": db_warn, "output_log": log_warn, "surface": surface_warn, "shot": shot_warn, "header": header_warn},
                }
                _append_evidence(state, evidence)
                _write_state(state_path, state)

                if args.once:
                    return 0
                elapsed = (time.perf_counter() - loop_start) * 1000.0
                sleep_ms = max(0.0, args.poll_ms - elapsed)
                if sleep_ms:
                    time.sleep(sleep_ms / 1000.0)
    except KeyboardInterrupt:
        _write_state(state_path, state)
        if not args.json:
            print("Watcher v3 stopped. State saved.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
