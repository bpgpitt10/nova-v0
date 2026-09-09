#!/usr/bin/env python3
"""Looper GSPro watcher v3.1: deterministic round lifecycle + parallel evidence.

Authority:
* currentRound.dat new ShotID = completed-shot truth.
* output_log AllPlayersHoledOut = terminal truth.
* trusted GSPro.db ActiveHole or fresh output_log currentHole can advance N -> N+1
  without Tee/header OCR.
* screen OCR/CV validates state and gates capture readiness; it cannot veto trusted
  structured progression.
* par/yard fallback is bootstrap-only.

Safety:
* no auto-aim recommendation actuation and no extra calibration pulses;
* W off; post-tee Y off; tee Y only in existing v8 toggle/restore;
* post-tee canonical geometry is bound to this hole's exact tee HoleModel.
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
RESULT_WORDS = {"PAR", "BOGEY", "BIRDIE", "EAGLE", "ALBATROSS", "DOUBLE", "TRIPLE", "ACE", "HOLE IN ONE"}
_ACTIVE_RE = re.compile(r"ActivePlayer\s*:\s*(\d+).*?currentHole\s*:\s*(\d+).*?strokes\s*:\s*(\d+)", re.I)
_CURRENT_HOLE_RE = re.compile(r"\bcurrentHole\s*:\s*(\d+)", re.I)


def _cfg() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def parse_args() -> argparse.Namespace:
    cfg = _cfg()["watcher"]
    p = argparse.ArgumentParser(description="Looper deterministic GSPro watcher v3.1")
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
    p.add_argument("--capture-retry-ms", type=float, default=1100.0)
    p.add_argument("--max-capture-attempts", type=int, default=2)
    p.add_argument("--transition-stable-observations", type=int, default=2)
    p.add_argument("--log-hole-fresh-seconds", type=float, default=3.0)
    p.add_argument("--no-aim-debug", action="store_true")
    return p.parse_args()


def _blank_state() -> dict[str, Any]:
    return {
        "schema_version": "gspro-round-watch-state-v3.1",
        "session_id": None, "phase": BOOTSTRAP,
        "course_name": None, "course_key": None, "round_id": None, "db_round_id": None,
        "player_name": None, "user_guid": None, "number_of_players": None,
        "current_hole": None, "expected_next_hole": None,
        "active_identity": None, "active_identity_key": None,
        "active_tee_capture_dir": None, "active_hole_model_path": None, "hole_models": {},
        "terminal_pending": None, "terminal_latch": None, "last_terminal_latch": None,
        "pending_tee": None, "pending_posttee": None,
        "tee_captured_holes": [], "posttee_captured_shot_ids": [],
        "current_round_baselined": False, "current_round_seen_shot_ids": [],
        "current_round_last_signature": None, "current_round_latest": None,
        "current_round_latest_snapshot": None, "current_round_snapshot_index": 0,
        "output_log_offset": None, "output_log_carry": "",
        "output_log_last_hole_display": None, "output_log_last_hole_epoch": None,
        "db_active_hole_display": None, "db_last_signature": None, "db_last_change_epoch": None,
        "last_transition_fusion": None, "last_evidence_signature": None,
        "events": [], "updated_local_epoch": None,
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


def _write_state(path: Path, state: dict[str, Any]) -> None:
    legacy._write_state(path, state)


def _emit(state: dict[str, Any], event: dict[str, Any], as_json: bool) -> None:
    event = dict(event)
    event.setdefault("epoch", time.time())
    event.setdefault("watcher_session_id", state.get("session_id"))
    state.setdefault("events", []).append(event)
    if len(state["events"]) > 400:
        del state["events"][:-400]
    if as_json:
        print(json.dumps(event, separators=(",", ":"), default=str), flush=True)
    else:
        print(f"[{event.get('event')}] {event.get('action') or ''} {event.get('identity_key') or ''} {event.get('detail') or ''}".strip(), flush=True)


def _corpus_dir(state: Mapping[str, Any]) -> Path:
    return OUTPUT_ROOT / "round_watch_corpus_v3" / str(state.get("session_id") or "unknown-session")


def _archive_current_round(state: dict[str, Any], raw: bytes) -> str | None:
    try:
        root = _corpus_dir(state) / "current_round"
        root.mkdir(parents=True, exist_ok=True)
        idx = int(state.get("current_round_snapshot_index") or 0) + 1
        state["current_round_snapshot_index"] = idx
        name = f"current_round_{idx:04d}_{hashlib.sha256(raw).hexdigest()[:12]}.dat"
        (root / name).write_bytes(raw)
        return name
    except Exception:
        return None


def _archive_log_delta(state: Mapping[str, Any], raw: bytes) -> None:
    if not raw:
        return
    try:
        root = _corpus_dir(state)
        root.mkdir(parents=True, exist_ok=True)
        with (root / "output_log_delta.txt").open("ab") as f:
            f.write(raw)
    except Exception:
        pass


def _archive_db_row(state: Mapping[str, Any], row: Mapping[str, Any]) -> None:
    try:
        root = _corpus_dir(state)
        root.mkdir(parents=True, exist_ok=True)
        with (root / "gspro_db_rows.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"epoch": time.time(), **dict(row)}, separators=(",", ":"), default=str) + "\n")
    except Exception:
        pass


def _append_evidence(state: dict[str, Any], payload: dict[str, Any]) -> None:
    sig = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    if sig == state.get("last_evidence_signature"):
        return
    state["last_evidence_signature"] = sig
    row = {"epoch": time.time(), "watcher_session_id": state.get("session_id"), **payload}
    encoded = json.dumps(row, separators=(",", ":"), default=str) + "\n"
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    with EVIDENCE_PATH.open("a", encoding="utf-8") as f:
        f.write(encoded)
    try:
        corpus = _corpus_dir(state)
        corpus.mkdir(parents=True, exist_ok=True)
        with (corpus / "evidence.jsonl").open("a", encoding="utf-8") as f:
            f.write(encoded)
    except Exception:
        pass


def _int(v: Any) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except Exception:
        return None


def _bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "y"}
    return bool(v)


def _normalize_course(v: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(v or "").lower()))


def _norm_person(v: Any) -> str:
    return " ".join(str(v or "").strip().lower().split())


def _mapping_get(m: Mapping[str, Any], *names: str) -> Any:
    for n in names:
        if n in m:
            return m[n]
    lower = {str(k).lower(): k for k in m}
    for n in names:
        k = lower.get(n.lower())
        if k is not None:
            return m[k]
    return None


def _identity_key(identity: Mapping[str, Any] | None, hole: int | None = None) -> str | None:
    if not identity:
        return None
    course = _normalize_course(identity.get("course_name"))
    if not course:
        return None
    h = hole if hole is not None else _int(identity.get("hole_number"))
    if h is not None:
        return f"{course}::hole-{h:02d}"
    par, yards = _int(identity.get("par")), _int(identity.get("hole_yards"))
    if par is not None and yards is not None:
        return f"{course}::fallback-par-{par}-yards-{yards}"
    return None


def _decode_json(raw: bytes) -> Any:
    last = None
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
    ghost = _mapping_get(item, "GhostData")
    ghost = ghost if isinstance(ghost, Mapping) else {}
    raw_hole = _int(_mapping_get(item, "Hole"))
    return {
        "shot_id": _mapping_get(item, "ShotID"), "round_id": _mapping_get(item, "RoundID"),
        "player_name": _mapping_get(item, "PlayerName"), "user_guid": _mapping_get(item, "UserGuid"),
        "course_key": _mapping_get(item, "CourseKey"),
        "hole_raw_zero_based": raw_hole,
        "hole_display": raw_hole + 1 if raw_hole is not None and raw_hole >= 0 else None,
        "hole_shot": _int(_mapping_get(item, "HoleShot")),
        "global_shot_number": _int(_mapping_get(item, "GlobalShotNumber")),
        "hole_par": _int(_mapping_get(item, "HolePar")),
        "distance_to_pin_raw": _mapping_get(item, "DistanceToPin"),
        "total_distance_raw": _mapping_get(item, "TotalDistance"),
        "starting_surface_raw": _mapping_get(item, "StartingSurface"),
        "ending_surface_raw": _mapping_get(item, "EndingSurface"),
        "club_index": _mapping_get(item, "ClubIndex"),
        "shot_result": _mapping_get(item, "ShotResult"), "hole_result": _mapping_get(item, "HoleResult"),
        "is_putt": _bool(_mapping_get(sd, "isPutt")),
        "is_holed": _bool(_mapping_get(sd, "isHoled")),
        "is_gimme": _bool(_mapping_get(sd, "isGimme")),
        "local_shot": _mapping_get(sd, "localShot"), "water_hit": _mapping_get(sd, "waterhit"),
        "hazard_number_raw": _mapping_get(sd, "HazardNumber"),
        "hazard_last_point_of_entry": _mapping_get(sd, "HazardLastPointOfEntry"),
        "target_direction_raw": _mapping_get(sd, "TargetDirection"),
        "td_material_raw": _mapping_get(sd, "TDmaterial"),
        "material_hit": _mapping_get(active, "materialHit"),
        "ghost_material_hit": _mapping_get(ghost, "materialHit"),
        "starting_pos": _mapping_get(item, "StartingPOS"), "ending_pos": _mapping_get(item, "EndingPOS"),
        "ball_start_pos": _mapping_get(sd, "BallStartPos"), "ball_stop_pos": _mapping_get(sd, "BallStopPos"),
        "td_point": _mapping_get(sd, "tdpoint"),
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
        shots = [_summarize_shot(x) for x in _shot_list(_decode_json(raw))]
        state["current_round_last_signature"] = signature
        state["current_round_latest"] = shots[-1] if shots else None
        state["current_round_latest_snapshot"] = _archive_current_round(state, raw)
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


def _read_db(path: Path, state: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    try:
        if not path.exists():
            return None, "GSPro.db missing"
        con = sqlite3.connect(str(path), timeout=0.05)
        try:
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA query_only=ON")
            cols = [str(r[1]) for r in con.execute('PRAGMA table_info("Round")').fetchall()]
            wanted = [x for x in ("ID", "PlayerName", "PlayerID", "CourseName", "CourseCode", "ActiveHole", "RoundStatus", "NumberOfPlayers") if x in cols]
            if not wanted:
                return None, "Round table fields unavailable"
            row = con.execute(f'SELECT {",".join(chr(34)+x+chr(34) for x in wanted)} FROM "Round" ORDER BY "ID" DESC LIMIT 1').fetchone()
            if row is None:
                return None, None
            out = dict(row)
            raw = _int(out.get("ActiveHole"))
            out["ActiveHoleRawZeroBased"] = raw
            out["ActiveHoleDisplay"] = raw + 1 if raw is not None and 0 <= raw <= 17 else None
            sig = json.dumps(out, sort_keys=True, default=str)
            if sig != state.get("db_last_signature"):
                state["db_last_signature"] = sig
                state["db_last_change_epoch"] = time.time()
                _archive_db_row(state, out)
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
            offset, state["output_log_carry"] = 0, ""
        if size <= int(offset):
            return [], None
        with path.open("rb") as f:
            f.seek(int(offset))
            raw = f.read(size - int(offset))
        state["output_log_offset"] = int(offset) + len(raw)
        _archive_log_delta(state, raw)
        text = str(state.get("output_log_carry") or "") + raw.decode("utf-8", errors="replace")
        parts, carry, facts, now = text.splitlines(keepends=True), "", [], time.time()
        for part in parts:
            if not part.endswith(("\n", "\r")):
                carry = part
                continue
            line, lower = part.rstrip("\r\n"), part.lower()
            match = _ACTIVE_RE.search(line)
            if match:
                facts.append({"kind": "active_game_state", "hole_display": int(match.group(2)) + 1, "strokes": int(match.group(3)), "epoch": now, "raw": line})
            elif (match := _CURRENT_HOLE_RE.search(line)):
                facts.append({"kind": "current_hole_observation", "hole_display": int(match.group(1)) + 1, "epoch": now, "raw": line})
            if "within gimmie distance" in lower or "within gimme distance" in lower:
                facts.append({"kind": "gimmie_selected", "epoch": now, "raw": line})
            if "allplayersholedout" in lower:
                facts.append({"kind": "hole_terminal", "epoch": now, "raw": line})
        state["output_log_carry"] = carry
        for fact in facts:
            if fact.get("hole_display") is not None:
                state["output_log_last_hole_display"] = int(fact["hole_display"])
                state["output_log_last_hole_epoch"] = float(fact["epoch"])
        return facts, None
    except Exception as exc:
        return [], str(exc)


def _crop_normalized(screen, bounds):
    h, w = screen.shape[:2]
    x1, y1, x2, y2 = bounds
    return screen[int(h*y1):int(h*y2), int(w*x1):int(w*x2)].copy()


def _safe_shot_number(screen, tess):
    try:
        crop = _crop_normalized(screen, (0.010, 0.055, 0.052, 0.090))
        raw = target_card._ocr(crop, target_card._resolve_tesseract(tess), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ", psm="7").strip()
        m = re.search(r"\bshot\s*([0-9]{1,2})\b", raw, re.I)
        value = int(m.group(1)) if m else None
        return (value if value is not None and 1 <= value <= 20 else None), raw, None
    except Exception as exc:
        return None, "", str(exc)


def _safe_surface(minimap, tess):
    try:
        return minimap_surface.read_minimap_surface(minimap, tesseract_path=tess), None
    except Exception as exc:
        return None, str(exc)


def _safe_header(screen, tess):
    try:
        identity, warning = round_identity.try_read_round_identity(screen, tesseract_path=tess)
        return (identity.to_dict() if identity is not None else None), warning
    except Exception as exc:
        return None, str(exc)


def _safe_pin(screen, tess):
    try:
        return float(target_card.read_target_card(screen, tesseract_path=tess).distance_yds), None
    except Exception as exc:
        return None, str(exc)


def _safe_result_overlay(screen, tess):
    try:
        crop = _crop_normalized(screen, (0.30, 0.08, 0.70, 0.38))
        raw = target_card._ocr(crop, target_card._resolve_tesseract(tess), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -", psm="11").strip()
        normalized = " ".join(raw.upper().split())
        for word in RESULT_WORDS:
            if re.search(rf"\b{re.escape(word)}\b", normalized):
                return word, raw, None
        return None, raw, None
    except Exception as exc:
        return None, "", str(exc)


def _latch_round_identity(state, shot=None, db=None, header=None):
    if state.get("course_name") is None:
        v = (header or {}).get("course_name") or (db or {}).get("CourseName")
        if v:
            state["course_name"] = str(v)
    if state.get("player_name") is None:
        v = (shot or {}).get("player_name") or (db or {}).get("PlayerName")
        if v:
            state["player_name"] = str(v)
    if state.get("number_of_players") is None:
        v = _int((db or {}).get("NumberOfPlayers"))
        if v is not None:
            state["number_of_players"] = v
    if state.get("db_round_id") is None and (db or {}).get("ID") is not None:
        state["db_round_id"] = (db or {}).get("ID")
    if shot:
        for dst, src in (("round_id", "round_id"), ("user_guid", "user_guid"), ("course_key", "course_key")):
            if state.get(dst) is None and shot.get(src) not in (None, ""):
                state[dst] = shot[src]


def _shot_matches_latch(state, shot):
    mismatches = []
    if state.get("round_id") is not None and shot.get("round_id") is not None and str(state["round_id"]) != str(shot["round_id"]):
        mismatches.append("round_id")
    if state.get("user_guid") and shot.get("user_guid") and str(state["user_guid"]) != str(shot["user_guid"]):
        mismatches.append("user_guid")
    if state.get("player_name") and shot.get("player_name") and _norm_person(state["player_name"]) != _norm_person(shot["player_name"]):
        mismatches.append("player_name")
    return not mismatches, mismatches


def _db_consistency(state, db):
    if not db:
        return {"trusted": False, "reasons": ["missing"], "contradictions": []}
    reasons, contradictions = [], []
    if state.get("course_name") and db.get("CourseName"):
        (reasons if _normalize_course(state["course_name"]) == _normalize_course(db["CourseName"]) else contradictions).append("course")
    if state.get("player_name") and db.get("PlayerName"):
        (reasons if _norm_person(state["player_name"]) == _norm_person(db["PlayerName"]) else contradictions).append("player")
    if state.get("round_id") is not None and db.get("ID") is not None:
        (reasons if str(state["round_id"]) == str(db["ID"]) else contradictions).append("round_id")
    if not state.get("course_name") and db.get("CourseName"):
        reasons.append("bootstrap_course")
    return {"trusted": not contradictions and bool(reasons or db.get("ID") is not None), "reasons": reasons, "contradictions": contradictions}


def _bootstrap(header, db, db_trust, shot, tee):
    hh = _int((header or {}).get("hole_number"))
    dh = _int((db or {}).get("ActiveHoleDisplay")) if db_trust.get("trusted") else None
    support, disagreements = [], []
    if hh is not None: support.append(f"header_hole={hh}")
    if dh is not None: support.append(f"db_hole={dh}")
    if hh is not None and dh is not None and hh != dh: disagreements.append(f"header={hh} vs trusted-db={dh}")
    if shot == 1: support.append("shot=1")
    if tee: support.append("tee")
    course = str((header or {}).get("course_name") or (db or {}).get("CourseName") or "").strip() or None
    candidate = dict(header or {})
    if course: candidate["course_name"] = course
    hole = dh if dh is not None else hh
    if hole is not None:
        candidate["hole_number"] = hole
        accepted = bool(course and (shot == 1 or tee or dh is not None))
        return (candidate if accepted else None), {"accepted": accepted, "support": support, "disagreements": disagreements, "mode": "bootstrap"}
    fallback = bool(course and candidate.get("par") is not None and candidate.get("hole_yards") is not None and shot == 1 and tee)
    return (candidate if fallback else None), {"accepted": fallback, "support": support + (["bootstrap_fallback=par+yards"] if fallback else []), "disagreements": disagreements, "mode": "bootstrap-fallback" if fallback else "bootstrap"}


def _transition(current, expected, db_hole, db_trusted, log_hole, log_fresh, header_hole, shot, tee):
    authority, support, stale, disagreements, hard = [], [], [], [], []
    if db_hole is not None:
        if db_trusted and db_hole == expected: authority.append(f"db=expected-{expected}")
        elif db_trusted and db_hole not in (current, expected): hard.append(f"trusted-db={db_hole}")
        elif db_hole == current: stale.append(f"db=stale-{current}")
        else: disagreements.append(f"db={db_hole}")
    if log_hole is not None:
        if log_fresh and log_hole == expected: authority.append(f"log=expected-{expected}")
        elif log_hole == current: stale.append(f"log=stale-{current}")
        elif log_fresh: disagreements.append(f"log={log_hole}")
        else: stale.append(f"log=old-{log_hole}")
    if header_hole == expected: support.append(f"header=expected-{expected}")
    elif header_hole == current: stale.append(f"header=stale-{current}")
    elif header_hole is not None: disagreements.append(f"header={header_hole}")
    if shot == 1: support.append("shot=1")
    elif shot is not None: disagreements.append(f"shot={shot}")
    if tee: support.append("tee")

    if not hard and authority:
        accepted, source = True, "structured"
    else:
        identity_support = any(x.startswith("header=") for x in support)
        preshot = int("shot=1" in support) + int("tee" in support)
        accepted = not hard and ((identity_support and preshot >= 1) or preshot >= 2)
        source = "screen-recovery" if accepted else None
    score = max(0.0, min(1.0, 0.45 + .30*len(authority) + .10*len(support) - .15*len(disagreements) - .50*len(hard)))
    return {"accepted": accepted, "authority": source, "expected_hole": expected, "deterministic_prior": f"hole-{current}-terminal -> expect-hole-{expected}", "authoritative_matches": authority, "support": support, "stale_or_unknown": stale, "disagreements": disagreements, "hard_contradictions": hard, "uncalibrated_score": round(score, 3)}


def _mark_hole_model(state, hole, status, **extra):
    if hole is not None:
        state.setdefault("hole_models", {})[str(int(hole))] = {"status": status, "updated_epoch": time.time(), **extra}


def _enter_hole(state, hole, header, db, reason, as_json, *, prepare_tee=True):
    previous = state.get("active_identity") or {}
    identity = {"course_name": previous["course_name"]} if previous.get("course_name") else {}
    header_hole = _int((header or {}).get("hole_number"))
    if header and header_hole == int(hole):
        identity.update({k: v for k, v in header.items() if v is not None})
    course = str(state.get("course_name") or (db or {}).get("CourseName") or (header or {}).get("course_name") or "").strip()
    if course:
        identity["course_name"], state["course_name"] = course, course
    identity["hole_number"], identity["hole_number_source"] = int(hole), reason
    state.update({"current_hole": int(hole), "expected_next_hole": None, "phase": PLAYING, "active_identity": identity, "active_identity_key": _identity_key(identity, hole), "active_tee_capture_dir": None, "active_hole_model_path": None, "terminal_pending": None, "pending_posttee": None})
    if state.get("terminal_latch"):
        state["last_terminal_latch"] = state["terminal_latch"]
    state["terminal_latch"] = None
    if prepare_tee:
        state["pending_tee"] = {"hole": int(hole), "entered_epoch": time.time(), "attempts": 0, "reason": reason}
        _mark_hole_model(state, hole, "pending")
    else:
        state["pending_tee"] = None
        _mark_hole_model(state, hole, "unavailable", reason="tee-state-missed-before-first-shot")
    _emit(state, {"event": "hole-entered", "action": "prepare-tee-capture" if prepare_tee else "tee-geometry-unavailable", "identity_key": state["active_identity_key"], "detail": f"Hole {hole} accepted: {reason}"}, as_json)


def _terminal(state, reason, as_json, source):
    hole = _int(state.get("current_hole"))
    if hole is None or state.get("phase") == COMPLETE:
        return
    latch = state.get("terminal_latch")
    if not isinstance(latch, dict) or _int(latch.get("hole")) != hole:
        latch = {"hole": hole, "first_epoch": time.time(), "sources": []}
        state["terminal_latch"] = latch
    if not any(x.get("source") == source for x in latch["sources"]):
        latch["sources"].append({"source": source, "reason": reason, "epoch": time.time()})
    state.update({"pending_posttee": None, "pending_tee": None, "terminal_pending": None})
    if hole >= 18:
        state.update({"phase": COMPLETE, "expected_next_hole": None})
        _emit(state, {"event": "round-complete", "action": "none", "identity_key": state.get("active_identity_key"), "detail": f"Hole 18 terminal: {reason}; watcher idles until Ctrl+C"}, as_json)
    else:
        state.update({"phase": EXPECT_NEXT, "expected_next_hole": hole + 1})
        _emit(state, {"event": "hole-terminal", "action": "expect-next-tee", "identity_key": state.get("active_identity_key"), "detail": f"Hole {hole} terminal ({reason}); expecting Hole {hole+1}"}, as_json)


def _capture_dirs(tee):
    prefix = "tee_capture_" if tee else "approach_capture_"
    if not OUTPUT_ROOT.exists():
        return set()
    return {p.name for p in OUTPUT_ROOT.iterdir() if p.is_dir() and p.name.startswith(prefix)}


def _run_capture(script_name, args, tee, *, hole_model_path=None):
    script = Path(__file__).with_name(script_name)
    if not script.exists():
        return False, f"capture script missing: {script}", None
    before = _capture_dirs(tee)
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Monitor", str(args.monitor)]
    if args.roi: cmd += ["-Roi", str(args.roi)]
    if args.tesseract: cmd += ["-Tesseract", str(args.tesseract)]
    if not args.no_aim_debug: cmd += ["-DeepDebug"]
    if tee:
        cmd += ["-NoReviewZip"]
    elif hole_model_path:
        cmd += ["-HoleModelPath", str(hole_model_path)]
    else:
        cmd += ["-NoCanonicalGeometry"]
    completed = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False)
    prefix = "tee_capture_" if tee else "approach_capture_"
    created = [p for p in OUTPUT_ROOT.iterdir() if p.is_dir() and p.name.startswith(prefix) and p.name not in before] if OUTPUT_ROOT.exists() else []
    capture_dir = max(created, key=lambda p: p.stat().st_mtime) if created else None
    detail = f"exit={completed.returncode}" + (f"; capture_dir={capture_dir.name}" if capture_dir else "")
    return completed.returncode == 0, detail, capture_dir


def _validate_tee_capture(capture_dir):
    if capture_dir is None:
        return False, "tee capture folder missing"
    path = capture_dir / "hole_model.json"
    if not path.exists():
        return False, "hole_model.json missing"
    try:
        model = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return False, f"hole_model.json unreadable: {exc}"
    if model.get("schema_version") != "tee-hole-model-v0":
        return False, f"unexpected HoleModel schema {model.get('schema_version')!r}"
    canonical = capture_dir / str(model.get("canonical_minimap") or "tee_heatmap_minimap.png")
    return (True, None) if canonical.exists() else (False, "canonical minimap missing")


def _geometry_status(capture_dir):
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
    if not geometry:
        return {"valid": False, "reason": payload.get("canonical_geometry_warning") or "canonical geometry unavailable", "geometry_attempted": bool(payload.get("canonical_geometry_attempted"))}
    cross = geometry.get("pin_distance_crosscheck") or {}
    return {"valid": bool(cross.get("ok")), "reason": None if cross.get("ok") else "canonical PIN-distance cross-check failed", "screen_pin_distance_yds": cross.get("screen_pin_distance_yds"), "canonical_remaining_pin_yds": cross.get("canonical_remaining_pin_yds"), "error_yds": cross.get("error_yds"), "registration": geometry.get("registration"), "hole_model_path": geometry.get("hole_model_path")}


def _save_prelaunch(capture_dir, screen, minimap, payload):
    try:
        cv2.imwrite(str(capture_dir / "watcher_prelaunch_screen.png"), screen)
        cv2.imwrite(str(capture_dir / "watcher_prelaunch_minimap.png"), minimap)
        legacy._write_json_atomic(capture_dir / "watcher_prelaunch.json", dict(payload))
    except Exception:
        pass


def _save_capture_context(state, state_path, capture_dir, capture_type, screen_shot, trigger, success, detail, geometry, evidence, aim_debug):
    identity = state.get("active_identity") or {}
    payload = {
        "schema_version": "gspro-capture-context-v3",
        "watcher_session_id": state.get("session_id"), "capture_type": capture_type,
        "identity_key": state.get("active_identity_key"), "course_name": identity.get("course_name"),
        "hole_number": identity.get("hole_number"), "par": identity.get("par"),
        "original_hole_yards": identity.get("hole_yards"),
        "round_id": state.get("round_id"), "db_round_id": state.get("db_round_id"),
        "player_name": state.get("player_name"), "user_guid": state.get("user_guid"),
        "screen_shot_number_validator": screen_shot, "structured_trigger": dict(trigger or {}) or None,
        "capture_folder": capture_dir.name, "capture_succeeded": bool(success),
        "watcher_capture_detail": detail, "watcher_state_file": str(state_path),
        "exact_hole_model_path": state.get("active_hole_model_path"),
        "geometry_validation": dict(geometry or {}) or None, "round_evidence": dict(evidence),
        "aim_debug_frames_retained": bool(aim_debug), "tagged_local_epoch": time.time(),
        "identity": identity or None,
    }
    legacy._write_json_atomic(capture_dir / "capture_context.json", payload)


def _structured_green(shot):
    if not shot:
        return False
    return any("green" in str(shot.get(k) or "").lower() for k in ("ending_surface_raw", "starting_surface_raw", "material_hit", "ghost_material_hit"))


def _structured_surface_text(shot):
    return "" if not shot else " ".join(str(shot.get(k) or "").lower() for k in ("ending_surface_raw", "material_hit", "ghost_material_hit"))


def _fresh_log_hole(state, now, freshness_s):
    hole, epoch = _int(state.get("output_log_last_hole_display")), state.get("output_log_last_hole_epoch")
    return hole, bool(hole is not None and epoch is not None and now - float(epoch) <= freshness_s)


def _screen_validator_state(screen_shot, expected):
    if screen_shot is None or expected is None: return "unknown"
    if int(screen_shot) == int(expected): return "match"
    return "ahead" if int(screen_shot) > int(expected) else "stale"


def _maybe_advance_from_structured(state, db, db_trust, log_hole, log_fresh, header, as_json):
    cur = _int(state.get("current_hole"))
    if cur is None or cur >= 18 or state.get("phase") not in (PLAYING, EXPECT_NEXT):
        return False
    expected = cur + 1 if state["phase"] == PLAYING else _int(state.get("expected_next_hole"))
    if expected is None:
        return False
    db_hole = _int((db or {}).get("ActiveHoleDisplay"))
    source = "trusted GSPro.db ActiveHole" if db_trust.get("trusted") and db_hole == expected else ("fresh output_log currentHole" if log_fresh and log_hole == expected else None)
    if source is None:
        return False
    if state["phase"] == PLAYING:
        _terminal(state, f"{source} advanced to Hole {expected}", as_json, source)
    _enter_hole(state, expected, header, db, f"structured progression: {source}", as_json, prepare_tee=True)
    return True


def main() -> int:
    args, watcher_cfg = parse_args(), _cfg()["watcher"]
    state_path = Path(args.state_file)
    state = _load_state(state_path, args.resume)
    gspro_dir = Path(os.path.expandvars(os.path.expanduser(args.gspro_dir)))
    current_round, output_log, db_path = gspro_dir / "currentRound.dat", gspro_dir / "output_log.txt", gspro_dir / "GSPro.db"
    transition_stable, last_pin, retry_not_before = 0, None, 0.0

    if not args.json:
        print("Looper GSPro persistent watcher v3.1")
        print("CAPTURE MODE: ACTIVE" if args.execute_actions else "CAPTURE MODE: DRY RUN")
        print("Structured N->N+1 progression outranks OCR; screen only gates capture readiness.")
        print("Terminal: currentRound isHoled/isGimme + output_log AllPlayersHoledOut.")
        print("Exact per-hole HoleModel binding. No auto aim/extra pulses. W OFF. Post-tee Y OFF.")
        print(f"Session: {state['session_id']}\nEvidence: {EVIDENCE_PATH}\nCorpus: {_corpus_dir(state)}")

    try:
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="looper-screen") as pool:
            while True:
                started, now = time.perf_counter(), time.time()
                new_shots, cr_warn = _read_current_round(current_round, state)
                db, db_warn = _read_db(db_path, state)
                _latch_round_identity(state, db=db)
                db_trust = _db_consistency(state, db)
                db_hole = _int((db or {}).get("ActiveHoleDisplay"))
                if db_hole is not None: state["db_active_hole_display"] = db_hole
                facts, log_warn = _read_log(output_log, state)
                log_hole, log_fresh = _fresh_log_hole(state, now, args.log_hole_fresh_seconds)

                if any(x.get("kind") == "gimmie_selected" for x in facts):
                    state["terminal_pending"] = {"hole": state.get("current_hole"), "source": "output_log gimmie_selected", "epoch": now}
                    _emit(state, {"event": "terminal-pending", "action": "observe", "detail": "gimme selected; waiting for terminal/next-hole confirmation"}, args.json)
                if any(x.get("kind") == "hole_terminal" for x in facts) and state["phase"] == PLAYING and state.get("current_hole") is not None:
                    _terminal(state, "output_log AllPlayersHoledOut", args.json, "output_log AllPlayersHoledOut")

                for shot in new_shots:
                    ok, mismatches = _shot_matches_latch(state, shot)
                    if not ok:
                        _emit(state, {"event": "shot-ignored", "action": "archive-only", "detail": f"currentRound shot mismatched {','.join(mismatches)}", "shot": shot}, args.json)
                        continue
                    _latch_round_identity(state, shot=shot, db=db)
                    shot_hole, cur, expected = _int(shot.get("hole_display")), _int(state.get("current_hole")), _int(state.get("expected_next_hole"))

                    if state["phase"] == PLAYING and cur is None and shot_hole is not None:
                        identity = dict(state.get("active_identity") or {})
                        identity.update({"hole_number": shot_hole, "hole_number_source": "currentRound completed-shot truth"})
                        state.update({"current_hole": shot_hole, "active_identity": identity, "active_identity_key": _identity_key(identity, shot_hole)})
                        cur = shot_hole
                        if state.get("active_hole_model_path"):
                            if shot_hole not in {int(x) for x in state.get("tee_captured_holes") or []}:
                                state.setdefault("tee_captured_holes", []).append(shot_hole)
                            _mark_hole_model(state, shot_hole, "ready", capture_dir=state.get("active_tee_capture_dir"), hole_model_path=state.get("active_hole_model_path"), identity_upgraded_from_fallback=True)
                        _emit(state, {"event": "bootstrap-resolved", "action": "upgrade-hole-identity", "identity_key": state.get("active_identity_key"), "detail": f"fallback resolved to Hole {shot_hole} by currentRound"}, args.json)

                    if cur is not None and shot_hole is not None and shot_hole < cur:
                        _emit(state, {"event": "late-shot-ignored", "action": "archive-only", "detail": f"late currentRound H{shot_hole} while authoritative H{cur}", "shot": shot}, args.json)
                        continue
                    if state["phase"] == EXPECT_NEXT and expected is not None and shot_hole == expected:
                        _enter_hole(state, expected, None, db, "currentRound first completed shot proved next hole; tee state missed", args.json, prepare_tee=False)
                        cur = expected
                    elif state["phase"] == PLAYING and cur is not None and shot_hole == cur + 1 and cur < 18:
                        _terminal(state, "currentRound advanced before transition observation", args.json, "currentRound next-hole recovery")
                        _enter_hole(state, shot_hole, None, db, "currentRound next-hole recovery; tee state missed", args.json, prepare_tee=False)
                        cur = shot_hole
                    elif state["phase"] == BOOTSTRAP and shot_hole is not None:
                        _enter_hole(state, shot_hole, None, db, "currentRound completed-shot bootstrap; tee state missed", args.json, prepare_tee=False)
                        cur = shot_hole
                    if shot_hole is not None and cur is not None and shot_hole != cur:
                        _emit(state, {"event": "shot-hole-contradiction", "action": "archive-only", "detail": f"currentRound H{shot_hole} conflicts with authoritative H{cur}", "shot": shot}, args.json)
                        continue

                    _emit(state, {"event": "shot-completed", "action": "observe", "identity_key": state.get("active_identity_key"), "detail": f"currentRound H{shot.get('hole_display')} S{shot.get('hole_shot')} ShotID={str(shot.get('shot_id'))[:10]}", "shot": shot}, args.json)

                    if state.get("pending_tee") and shot_hole == _int(state.get("current_hole")):
                        state.update({"pending_tee": None, "active_tee_capture_dir": None, "active_hole_model_path": None})
                        _mark_hole_model(state, shot_hole, "unavailable", reason="first-shot-completed-before-tee-capture")
                        _emit(state, {"event": "tee-capture-missed", "action": "none", "detail": f"Hole {shot_hole}: first shot occurred before tee capture"}, args.json)

                    multi = (_int(state.get("number_of_players")) or 1) > 1
                    if shot.get("is_holed") or shot.get("is_gimme"):
                        if not multi:
                            _terminal(state, "currentRound isHoled/isGimme", args.json, "currentRound isHoled/isGimme")
                        else:
                            _emit(state, {"event": "player-terminal", "action": "wait-all-players", "detail": "player terminal in multiplayer; waiting for AllPlayersHoledOut/next-hole"}, args.json)
                        continue
                    if shot.get("is_putt"):
                        continue
                    hs = _int(shot.get("hole_shot"))
                    state["pending_posttee"] = {"shot_id": str(shot.get("shot_id")), "shot": shot, "expected_next_shot_number": hs + 1 if hs is not None else None, "completed_epoch": now, "attempts": 0}
                    retry_not_before, last_pin = now + args.posttee_min_settle_ms / 1000.0, None

                screen = base.capture_monitor(args.monitor)
                minimap, _ = base.crop_minimap(screen, args.roi)
                fs, fn = pool.submit(_safe_surface, minimap, args.tesseract), pool.submit(_safe_shot_number, screen, args.tesseract)
                need_header = state["phase"] in (BOOTSTRAP, EXPECT_NEXT) or bool(state.get("pending_tee"))
                fh = pool.submit(_safe_header, screen, args.tesseract) if need_header else None
                surface, surface_warn = fs.result()
                screen_shot, shot_raw, shot_warn = fn.result()
                header, header_warn = fh.result() if fh else (None, None)
                _latch_round_identity(state, db=db, header=header)
                header_hole = _int((header or {}).get("hole_number"))
                surface_tee = bool(surface is not None and surface.recognized and surface.is_tee)
                surface_label = str(surface.label or "").lower() if surface is not None and surface.recognized else None
                db_trust = _db_consistency(state, db)

                if _maybe_advance_from_structured(state, db, db_trust, log_hole, log_fresh, header, args.json):
                    transition_stable, last_pin = 0, None

                if state["phase"] == BOOTSTRAP:
                    candidate, fusion = _bootstrap(header, db, db_trust, screen_shot, surface_tee)
                    state["last_transition_fusion"] = fusion
                    if candidate is not None:
                        hole = _int(candidate.get("hole_number"))
                        if hole is None:
                            state.update({"course_name": candidate.get("course_name"), "active_identity": candidate, "active_identity_key": _identity_key(candidate), "phase": PLAYING, "pending_tee": {"hole": None, "entered_epoch": now, "attempts": 0, "reason": "bootstrap fallback"}})
                            _emit(state, {"event": "bootstrap-fallback", "action": "prepare-tee-capture", "identity_key": state.get("active_identity_key"), "detail": "Initial tee only: par/yard fallback; first completed shot resolves hole"}, args.json)
                        else:
                            _enter_hole(state, hole, candidate, db, "bootstrap evidence accepted", args.json)

                elif state["phase"] == EXPECT_NEXT:
                    cur, expected = int(state["current_hole"]), int(state["expected_next_hole"])
                    fusion = _transition(cur, expected, db_hole, bool(db_trust.get("trusted")), log_hole, log_fresh, header_hole, screen_shot, surface_tee)
                    state["last_transition_fusion"] = fusion
                    if fusion["accepted"] and fusion["authority"] == "structured":
                        _enter_hole(state, expected, header, db, "deterministic expectation corroborated by structured state", args.json)
                        transition_stable = 0
                    elif fusion["accepted"]:
                        transition_stable += 1
                        if transition_stable >= max(1, args.transition_stable_observations):
                            _enter_hole(state, expected, header, db, "deterministic expectation corroborated by stable screen recovery", args.json)
                            transition_stable = 0
                    else:
                        transition_stable = 0

                if state["phase"] == PLAYING and header and state.get("current_hole") is not None:
                    cur = int(state["current_hole"])
                    if header_hole in (None, cur):
                        identity = dict(state.get("active_identity") or {})
                        identity.update({k: v for k, v in header.items() if v is not None})
                        identity["hole_number"] = cur
                        state.update({"active_identity": identity, "active_identity_key": _identity_key(identity, cur)})

                pending_tee = state.get("pending_tee")
                if pending_tee and state["phase"] == PLAYING and now >= retry_not_before:
                    hole = _int(pending_tee.get("hole")) or _int(state.get("current_hole"))
                    captured = hole is not None and hole in {int(x) for x in state.get("tee_captured_holes") or []}
                    if not captured:
                        attempts = int(pending_tee.get("attempts") or 0)
                        if attempts >= max(1, args.max_capture_attempts):
                            state["pending_tee"] = None
                            _mark_hole_model(state, hole, "unavailable", reason="tee-capture-max-attempts")
                            _emit(state, {"event": "tee-capture-abandoned", "action": "none", "detail": f"Hole {hole}: exhausted {attempts} attempts"}, args.json)
                        else:
                            visual_cues = (["header_expected_hole"] if hole is not None and header_hole == hole else []) + (["shot_1"] if screen_shot == 1 else []) + (["tee"] if surface_tee else [])
                            overlay, overlay_raw, overlay_warn = _safe_result_overlay(screen, args.tesseract)
                            pin, pin_warn = _safe_pin(screen, args.tesseract)
                            preshot_ready = screen_shot == 1 or surface_tee
                            if preshot_ready and overlay is None and pin is not None:
                                if last_pin and last_pin[0] == "tee" and abs(last_pin[1] - pin) <= 0.5:
                                    pending_tee["attempts"] = attempts + 1
                                    success, detail, capture_dir = (True, "dry-run simulated success", None)
                                    if args.execute_actions:
                                        success, detail, capture_dir = _run_capture(str(watcher_cfg["tee_capture_command"]), args, True)
                                    model_ok, model_reason = _validate_tee_capture(capture_dir) if args.execute_actions else (True, None)
                                    success = bool(success and model_ok)
                                    if model_reason: detail += f"; {model_reason}"
                                    snap = {"phase": state["phase"], "current_hole": state.get("current_hole"), "db_hole": db_hole, "db_trust": db_trust, "log_hole": log_hole, "log_fresh": log_fresh, "header_hole": header_hole, "shot": screen_shot, "surface_tee": surface_tee, "result_overlay": overlay, "fusion": state.get("last_transition_fusion")}
                                    if capture_dir:
                                        _save_prelaunch(capture_dir, screen, minimap, {"capture_type": "tee", "pin_distance_yds": pin, "readiness_cues": visual_cues, "result_overlay_raw": overlay_raw, **snap})
                                        _save_capture_context(state, state_path, capture_dir, "tee", screen_shot, None, success, detail, None, snap, not args.no_aim_debug)
                                    _emit(state, {"event": "capture-succeeded" if success else "capture-failed", "action": "capture-tee", "identity_key": state.get("active_identity_key"), "detail": detail}, args.json)
                                    if success:
                                        if hole is not None: state.setdefault("tee_captured_holes", []).append(hole)
                                        state["active_tee_capture_dir"] = capture_dir.name if capture_dir else None
                                        state["active_hole_model_path"] = str(capture_dir / "hole_model.json") if capture_dir else None
                                        _mark_hole_model(state, hole, "ready", capture_dir=state.get("active_tee_capture_dir"), hole_model_path=state.get("active_hole_model_path"))
                                        state["pending_tee"] = None
                                    elif pending_tee["attempts"] >= max(1, args.max_capture_attempts):
                                        state["pending_tee"] = None
                                        _mark_hole_model(state, hole, "unavailable", reason=detail)
                                    else:
                                        retry_not_before = now + args.capture_retry_ms / 1000.0
                                    last_pin = None
                                else:
                                    last_pin = ("tee", pin)
                            else:
                                last_pin = None

                pending = state.get("pending_posttee")
                if pending and state["phase"] != PLAYING:
                    state["pending_posttee"], pending = None, None
                if pending and surface_tee:
                    state["pending_posttee"], pending = None, None
                if pending and (_structured_green(pending.get("shot")) or surface_label == "green"):
                    _emit(state, {"event": "posttee-skipped", "action": "none", "detail": "green/putting state; full-shot watcher skips capture"}, args.json)
                    state["pending_posttee"], pending = None, None

                if pending and now >= retry_not_before:
                    expected_shot = _int(pending.get("expected_next_shot_number"))
                    validator = _screen_validator_state(screen_shot, expected_shot)
                    structured_surface = _structured_surface_text(pending.get("shot"))
                    surface_ok = surface_label in FULL_SHOT_SURFACES or any(x in structured_surface for x in FULL_SHOT_SURFACES)
                    if validator != "stale" and surface_ok:
                        pin, pin_warn = _safe_pin(screen, args.tesseract)
                        if pin is not None:
                            if last_pin and last_pin[0] == "posttee" and abs(last_pin[1] - pin) <= 0.5:
                                pending["attempts"] = int(pending.get("attempts") or 0) + 1
                                exact_model = state.get("active_hole_model_path")
                                success, detail, capture_dir = (True, "dry-run simulated success", None)
                                if args.execute_actions:
                                    success, detail, capture_dir = _run_capture(str(watcher_cfg["posttee_capture_command"]), args, False, hole_model_path=exact_model)
                                geometry = _geometry_status(capture_dir) if success else None
                                snap = {"phase": state["phase"], "current_hole": state.get("current_hole"), "db_hole": db_hole, "db_trust": db_trust, "log_hole": log_hole, "log_fresh": log_fresh, "shot_validator": screen_shot, "shot_validator_state": validator, "expected_next_shot": expected_shot, "surface": surface_label, "structured_surface": structured_surface, "exact_hole_model_path": exact_model}
                                if capture_dir:
                                    _save_prelaunch(capture_dir, screen, minimap, {"capture_type": "post-tee", "pin_distance_yds": pin, "structured_trigger": pending.get("shot"), **snap})
                                    _save_capture_context(state, state_path, capture_dir, "post-tee", screen_shot, pending.get("shot"), success, detail, geometry, snap, not args.no_aim_debug)
                                geometry_valid = bool(geometry and geometry.get("valid")) if exact_model else False
                                _emit(state, {"event": "capture-succeeded" if success else "capture-failed", "action": "capture-posttee", "detail": detail + (f"; geometry_valid={geometry_valid}; exact_model={bool(exact_model)}" if success else ""), "geometry": geometry}, args.json)
                                if success:
                                    state.setdefault("posttee_captured_shot_ids", []).append(str(pending.get("shot_id")))
                                    state["pending_posttee"] = None
                                elif pending["attempts"] >= max(1, args.max_capture_attempts):
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
                    "phase": state["phase"], "current_hole": state.get("current_hole"), "expected_next_hole": state.get("expected_next_hole"),
                    "round_latch": {k: state.get(k) for k in ("course_name", "course_key", "round_id", "db_round_id", "player_name", "user_guid", "number_of_players")},
                    "terminal_pending": state.get("terminal_pending"), "terminal_latch": state.get("terminal_latch"), "last_terminal_latch": state.get("last_terminal_latch"),
                    "structured": {"current_round_latest": state.get("current_round_latest"), "current_round_latest_snapshot": state.get("current_round_latest_snapshot"), "db_active_hole_display": db_hole, "db_round_id": (db or {}).get("ID"), "db_trust": db_trust, "db_last_change_epoch": state.get("db_last_change_epoch"), "output_log_last_hole_display": log_hole, "output_log_last_hole_epoch": state.get("output_log_last_hole_epoch"), "output_log_hole_fresh": log_fresh, "output_log_facts": facts[-8:]},
                    "screen": {"shot_number": screen_shot, "shot_raw": shot_raw, "surface": surface.to_dict() if surface is not None else None, "header": header},
                    "hole_model": {"active_path": state.get("active_hole_model_path"), "active_capture_dir": state.get("active_tee_capture_dir"), "per_hole": state.get("hole_models")},
                    "fusion": state.get("last_transition_fusion"),
                    "warnings": {"current_round": cr_warn, "gspro_db": db_warn, "output_log": log_warn, "surface": surface_warn, "shot": shot_warn, "header": header_warn},
                }
                _append_evidence(state, evidence)
                _write_state(state_path, state)

                if args.once: return 0
                sleep_ms = max(0.0, args.poll_ms - (time.perf_counter() - started) * 1000.0)
                if sleep_ms: time.sleep(sleep_ms / 1000.0)
    except KeyboardInterrupt:
        _write_state(state_path, state)
        if not args.json: print("Watcher v3.1 stopped. State saved.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
