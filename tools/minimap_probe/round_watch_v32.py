#!/usr/bin/env python3
"""Looper watcher v3.2 policy layer over the validated v3.1 event loop.

Field findings from the 2026-09-09 four-hole DPC Pebble run:
- `GSPro.db Round.ActiveHole` stayed at raw 0/Hole 1 through four played holes. It is
  therefore diagnostic/round metadata only and can never advance or veto live state.
- `output_log AllPlayersHoledOut` reliably closes the old hole.
- after a trusted terminal, deterministic N+1 plus Shot 1 + Tee is sufficient to
  enter the next hole; header N+1 plus either pre-shot cue is also sufficient.
- `currentRound.DistanceToPin` / `TotalDistance` are meters and are converted to yards.
- repeated GlobalShotNumber + isGimme/isHoled records are synthetic terminal closure
  records, not physical golf shots.
- post-shot screen PIN is sanity-checked against converted structured DistanceToPin.

This module deliberately reuses the v3.1 event loop while replacing source policy,
structured enrichment, target-distance resolution, capture commands, evidence
instrumentation, and round identity keys. No auto-aim or extra calibration pulses.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import time
from typing import Any, Mapping

import gspro_structured
import round_watch_v3 as core
import target_card_v9


_BASE_CFG = core._cfg
_BASE_BLANK_STATE = core._blank_state
_BASE_SUMMARIZE = core._summarize_shot
_BASE_READ_CURRENT = core._read_current_round
_BASE_DB_CONSISTENCY = core._db_consistency
_BASE_SAFE_SHOT = core._safe_shot_number
_BASE_SAFE_SURFACE = core._safe_surface
_BASE_SAFE_HEADER = core._safe_header
_BASE_SAFE_OVERLAY = core._safe_result_overlay
_BASE_APPEND_EVIDENCE = core._append_evidence
_BASE_IDENTITY_KEY = core._identity_key
_BASE_LATCH = core._latch_round_identity
_BASE_TERMINAL = core._terminal
_BASE_ENTER_HOLE = core._enter_hole
_BASE_RUN_CAPTURE = core._run_capture
_BASE_VALIDATE_TEE = core._validate_tee_capture
_BASE_EMIT = core._emit
_BASE_STRUCTURED_GREEN = core._structured_green
_BASE_STRUCTURED_SURFACE_TEXT = core._structured_surface_text

_CTX: dict[str, Any] = {
    "round_id": None,
    "db_round_id": None,
    "authoritative_hole": None,
    "screen_shot": None,
    "surface_label": None,
    "surface_tee": False,
    "header": None,
    "structured_pin": None,
    "last_pin": None,
    "last_overlay": None,
}


def _cfg():
    cfg = copy.deepcopy(_BASE_CFG())
    cfg.setdefault("watcher", {})["tee_capture_command"] = "run_probe_resilient_windows.ps1"
    cfg["watcher"]["posttee_capture_command"] = "run_approach_probe_v12_windows.ps1"
    return cfg


def _blank_state():
    state = _BASE_BLANK_STATE()
    state["schema_version"] = "gspro-round-watch-state-v3.2"
    state.setdefault("last_physical_global_shot_by_hole", {})
    state.setdefault("source_policy", {})
    state["source_policy"].update({
        "gspro_db_active_hole": "diagnostic-only-field-proven-stale",
        "output_log_all_players_holed_out": "terminal-authority",
        "next_hole": "deterministic-N-plus-1-with-pre-shot-screen-corroboration",
        "structured_distance_units": "meters-converted-to-yards",
    })
    return state


def _numeric(value):
    try:
        return float(value) if value is not None else None
    except Exception:
        return None


def _summarize_shot(item: Mapping[str, Any]):
    shot = _BASE_SUMMARIZE(item)
    structured = gspro_structured.summarize_shot(item)
    for key in (
        "distance_to_pin_m",
        "distance_to_pin_yds",
        "total_distance_m",
        "total_distance_yds",
        "distance_units_observed",
        "starting_surface",
        "ending_surface",
        "surface_enum_mapping_status",
    ):
        shot[key] = structured.get(key)
    shot.setdefault("physical_shot", True)
    shot.setdefault("synthetic_terminal_record", False)
    return shot


def _physical_key(shot):
    return "|".join(
        str(shot.get(key) or "?")
        for key in ("round_id", "user_guid", "hole_display")
    )


def _classify_new_shots(new_shots, state):
    """Mark high-confidence synthetic gimme closure records.

    In the field corpus GSPro appended isGimme+isHoled closure records whose
    GlobalShotNumber repeated the immediately preceding physical shot. They are kept
    as terminal evidence but explicitly excluded from physical-shot semantics.
    """
    last_by_hole = state.setdefault("last_physical_global_shot_by_hole", {})
    for shot in new_shots:
        key = _physical_key(shot)
        global_no = core._int(shot.get("global_shot_number"))
        previous = core._int(last_by_hole.get(key))
        synthetic = bool(
            shot.get("is_gimme")
            and shot.get("is_holed")
            and global_no is not None
            and previous is not None
            and global_no == previous
        )
        shot["synthetic_terminal_record"] = synthetic
        shot["physical_shot"] = not synthetic
        shot["synthetic_reason"] = (
            "isGimme+isHoled with repeated GlobalShotNumber" if synthetic else None
        )
        if not synthetic and global_no is not None:
            last_by_hole[key] = global_no
    return new_shots


def _read_current_round(path: Path, state: dict[str, Any]):
    new_shots, warning = _BASE_READ_CURRENT(path, state)
    _classify_new_shots(new_shots, state)
    for shot in new_shots:
        synthetic = bool(shot.get("synthetic_terminal_record"))
        if not synthetic and shot.get("distance_to_pin_yds") is not None:
            _CTX["structured_pin"] = {
                "epoch": time.time(),
                "hole": shot.get("hole_display"),
                "distance_to_pin_m": shot.get("distance_to_pin_m"),
                "distance_to_pin_yds": shot.get("distance_to_pin_yds"),
                "shot_id": shot.get("shot_id"),
                "source": "currentRound.DistanceToPin meters->yards",
            }
        if shot.get("round_id") is not None:
            _CTX["round_id"] = shot.get("round_id")

    # The core reader stores its own pre-enrichment summary as latest. Upgrade it
    # when the latest record was part of this new batch so evidence sees conversions.
    if new_shots and state.get("current_round_latest"):
        latest_id = str(state["current_round_latest"].get("shot_id"))
        for shot in new_shots:
            if str(shot.get("shot_id")) == latest_id:
                state["current_round_latest"] = shot
                break
    return new_shots, warning


def _emit(state, event, as_json):
    event = dict(event)
    shot = event.get("shot") or {}
    if event.get("event") == "shot-completed" and shot.get("synthetic_terminal_record"):
        event["event"] = "synthetic-terminal-record"
        event["action"] = "terminal-only"
        event["detail"] = (
            f"currentRound H{shot.get('hole_display')} S{shot.get('hole_shot')} "
            "synthetic gimme closure; not a physical shot"
        )
    return _BASE_EMIT(state, event, as_json)


def _latch_round_identity(state, shot=None, db=None, header=None):
    result = _BASE_LATCH(state, shot=shot, db=db, header=header)
    if state.get("round_id") is not None:
        _CTX["round_id"] = state.get("round_id")
    if state.get("db_round_id") is not None:
        _CTX["db_round_id"] = state.get("db_round_id")
    return result


def _identity_key(identity, hole=None):
    h = hole if hole is not None else core._int((identity or {}).get("hole_number"))
    rid = _CTX.get("round_id") or _CTX.get("db_round_id")
    if rid is not None and h is not None:
        return f"round-{rid}::hole-{int(h):02d}"
    return _BASE_IDENTITY_KEY(identity, hole)


def _db_consistency(state, db):
    result = dict(_BASE_DB_CONSISTENCY(state, db))
    result["active_hole_policy"] = "diagnostic-only-field-proven-stale"
    result["active_hole_live_authority"] = False
    return result


def _bootstrap(header, db, db_trust, shot, tee):
    """Bootstrap from screen identity; never trust DB ActiveHole as current hole."""
    hh = core._int((header or {}).get("hole_number"))
    db_hole = core._int((db or {}).get("ActiveHoleDisplay"))
    course = str(
        (header or {}).get("course_name")
        or (db or {}).get("CourseName")
        or ""
    ).strip() or None
    support, disagreements = [], []
    if hh is not None:
        support.append(f"header_hole={hh}")
    if shot == 1:
        support.append("shot=1")
    if tee:
        support.append("tee")
    if db_hole is not None:
        support.append(f"db_active_hole_diagnostic_only={db_hole}")
        if hh is not None and hh != db_hole:
            disagreements.append(f"header={hh} vs stale-db={db_hole}; db ignored")

    candidate = dict(header or {})
    if course:
        candidate["course_name"] = course
    preshot = shot == 1 or tee
    if hh is not None and course and preshot:
        candidate["hole_number"] = hh
        return candidate, {
            "accepted": True,
            "support": support,
            "disagreements": disagreements,
            "mode": "bootstrap-screen",
            "db_active_hole_used": False,
        }

    fallback = bool(
        course
        and candidate.get("par") is not None
        and candidate.get("hole_yards") is not None
        and shot == 1
        and tee
    )
    return (candidate if fallback else None), {
        "accepted": fallback,
        "support": support + (["bootstrap_fallback=par+yards"] if fallback else []),
        "disagreements": disagreements,
        "mode": "bootstrap-fallback" if fallback else "bootstrap-wait",
        "db_active_hole_used": False,
    }


def _transition(
    current,
    expected,
    db_hole,
    db_trusted,
    log_hole,
    log_fresh,
    header_hole,
    shot,
    tee,
):
    """Resolve expected N+1 after terminal without letting stale DB veto it."""
    support, stale, disagreements = [], [], []
    if db_hole is not None:
        stale.append(f"db={db_hole} diagnostic-only")

    if log_hole is not None:
        if log_fresh and log_hole == expected:
            return {
                "accepted": True,
                "authority": "structured",
                "expected_hole": expected,
                "deterministic_prior": f"hole-{current}-terminal -> expect-hole-{expected}",
                "authoritative_matches": [f"fresh-log=expected-{expected}"],
                "support": [],
                "stale_or_unknown": stale,
                "disagreements": [],
                "hard_contradictions": [],
                "uncalibrated_score": 0.95,
                "db_active_hole_policy": "ignored-for-live-transition",
            }
        if log_hole == current:
            stale.append(f"log=stale-{current}")
        elif log_fresh:
            disagreements.append(f"log={log_hole}")
        else:
            stale.append(f"log=old-{log_hole}")

    if header_hole == expected:
        support.append(f"header=expected-{expected}")
    elif header_hole == current:
        stale.append(f"header=stale-{current}")
    elif header_hole is not None:
        disagreements.append(f"header={header_hole}")

    if shot == 1:
        support.append("shot=1")
    elif shot is not None:
        disagreements.append(f"shot={shot}")
    if tee:
        support.append("tee")

    shot1_tee = shot == 1 and tee
    header_plus_preshot = header_hole == expected and (shot == 1 or tee)
    accepted = bool(shot1_tee or header_plus_preshot)
    score = 0.92 if shot1_tee else (0.88 if header_plus_preshot else 0.35)
    return {
        "accepted": accepted,
        "authority": "screen-recovery" if accepted else None,
        "expected_hole": expected,
        "deterministic_prior": f"hole-{current}-terminal -> expect-hole-{expected}",
        "authoritative_matches": [],
        "support": support,
        "stale_or_unknown": stale,
        "disagreements": disagreements,
        "hard_contradictions": [],
        "uncalibrated_score": score,
        "db_active_hole_policy": "ignored-for-live-transition",
    }


def _add_terminal_corroboration(state, reason, source, as_json):
    hole = core._int(state.get("current_hole"))
    latch = state.get("terminal_latch")
    if not isinstance(latch, dict) or core._int(latch.get("hole")) != hole:
        latch = {"hole": hole, "first_epoch": time.time(), "sources": []}
        state["terminal_latch"] = latch
    if not any(item.get("source") == source for item in latch.get("sources") or []):
        latch.setdefault("sources", []).append({
            "source": source,
            "reason": reason,
            "epoch": time.time(),
        })
        _BASE_EMIT(
            state,
            {
                "event": "terminal-corroborated",
                "action": "continue-expecting-next-hole",
                "identity_key": state.get("active_identity_key"),
                "detail": f"Hole {hole} terminal corroborated by {source}",
            },
            as_json,
        )


def _terminal(state, reason, as_json, source):
    _CTX["structured_pin"] = None
    hole = core._int(state.get("current_hole"))
    if (
        hole is not None
        and state.get("phase") == core.EXPECT_NEXT
        and core._int(state.get("expected_next_hole")) == hole + 1
    ):
        _add_terminal_corroboration(state, reason, source, as_json)
        return
    return _BASE_TERMINAL(state, reason, as_json, source)


def _enter_hole(state, hole, header, db, reason, as_json, *, prepare_tee=True):
    _CTX["structured_pin"] = None
    _CTX["last_pin"] = None
    _CTX["authoritative_hole"] = int(hole)
    result = _BASE_ENTER_HOLE(
        state,
        hole,
        header,
        db,
        reason,
        as_json,
        prepare_tee=prepare_tee,
    )
    # `_BASE_ENTER_HOLE` calls the monkey-patched identity-key function, but re-key
    # once more after any newly latched round ID for clarity.
    state["active_identity_key"] = _identity_key(state.get("active_identity"), hole)
    return result


def _maybe_advance_from_structured(state, db, db_trust, log_hole, log_fresh, header, as_json):
    """Only fresh output_log currentHole can provide live structured advancement.

    GSPro.db ActiveHole is intentionally ignored even when the DB row itself is the
    correct round/player/course row.
    """
    cur = core._int(state.get("current_hole"))
    if cur is None or cur >= 18 or state.get("phase") not in (core.PLAYING, core.EXPECT_NEXT):
        return False
    expected = (
        cur + 1
        if state["phase"] == core.PLAYING
        else core._int(state.get("expected_next_hole"))
    )
    if expected is None or not (log_fresh and log_hole == expected):
        return False
    if state["phase"] == core.PLAYING:
        _terminal(
            state,
            f"fresh output_log currentHole advanced to Hole {expected}",
            as_json,
            "fresh output_log currentHole",
        )
    preshot_visible = bool(_CTX.get("screen_shot") == 1 or _CTX.get("surface_tee"))
    _enter_hole(
        state,
        expected,
        header,
        db,
        "structured progression: fresh output_log currentHole",
        as_json,
        prepare_tee=preshot_visible,
    )
    return True


def _safe_shot_number(screen, tess):
    value, raw, warning = _BASE_SAFE_SHOT(screen, tess)
    _CTX["screen_shot"] = value
    return value, raw, warning


def _safe_surface(minimap, tess):
    value, warning = _BASE_SAFE_SURFACE(minimap, tess)
    label = (
        str(value.label or "").lower()
        if value is not None and value.recognized
        else None
    )
    _CTX["surface_label"] = label
    _CTX["surface_tee"] = bool(
        value is not None and value.recognized and value.is_tee
    )
    return value, warning


def _safe_header(screen, tess):
    value, warning = _BASE_SAFE_HEADER(screen, tess)
    _CTX["header"] = value
    return value, warning


def _distance_screen_read(screen, tess):
    try:
        value, _bbox, attempts = target_card_v9.read_target_distance_v9(
            screen,
            tesseract_path=tess,
            bbox_override=None,
            debug_dir=None,
        )
        valid = [item.get("value") for item in attempts if item.get("value") is not None]
        warning = None
        if len(set(int(v) for v in valid)) > 1:
            warning = "PIN distance OCR candidates disagreed: " + ",".join(str(int(v)) for v in valid)
        return float(value), warning, [
            {k: item.get(k) for k in ("label", "psm", "raw", "value")}
            for item in attempts
        ]
    except Exception as exc:
        return None, str(exc), []


def _resolve_pin(screen_value, screen_warning, candidates=None):
    now = time.time()
    screen_shot = _CTX.get("screen_shot")
    is_tee = bool(screen_shot == 1 or _CTX.get("surface_tee"))
    header = _CTX.get("header") or {}
    header_hole = core._int(header.get("hole_number"))
    authoritative_hole = core._int(_CTX.get("authoritative_hole"))
    header_yards = _numeric(header.get("hole_yards"))
    header_current = bool(
        header_yards is not None
        and (
            authoritative_hole is None
            or header_hole is None
            or header_hole == authoritative_hole
        )
    )

    structured = _CTX.get("structured_pin") if not is_tee else None
    if structured and structured.get("epoch") is not None:
        if now - float(structured["epoch"]) > 15.0:
            structured = None
    if structured and authoritative_hole is not None:
        if core._int(structured.get("hole")) not in (None, authoritative_hole):
            structured = None
    structured_yards = _numeric((structured or {}).get("distance_to_pin_yds"))

    source = None
    resolved = None
    warnings = [screen_warning] if screen_warning else []
    if screen_value is not None:
        screen_value = float(screen_value)
        if structured_yards is not None:
            tolerance = max(3.0, structured_yards * 0.05)
            if abs(screen_value - structured_yards) > tolerance:
                resolved, source = structured_yards, "currentRound-meters-to-yards"
                warnings.append(
                    f"screen PIN {screen_value:.1f} rejected vs structured {structured_yards:.1f}"
                )
            else:
                resolved, source = screen_value, "screen-consensus-validated-by-currentRound"
        elif is_tee and header_current and abs(screen_value - header_yards) > max(15.0, header_yards * 0.20):
            resolved, source = header_yards, "tee-header-yardage-fallback"
            warnings.append(
                f"screen tee PIN {screen_value:.1f} rejected vs header {header_yards:.1f}"
            )
        else:
            resolved, source = screen_value, "screen-consensus"
    elif structured_yards is not None:
        resolved, source = structured_yards, "currentRound-meters-to-yards"
        warnings.append("screen PIN unavailable; using structured DistanceToPin")
    elif is_tee and header_current:
        resolved, source = header_yards, "tee-header-yardage-fallback"
        warnings.append("screen tee PIN unavailable; using header yardage")

    previous = _CTX.get("last_pin")
    stable = 1
    if resolved is not None and previous and previous.get("value") is not None:
        if abs(float(previous["value"]) - float(resolved)) <= 0.5:
            stable = int(previous.get("stable_observations") or 1) + 1
    diag = {
        "epoch": now,
        "value": resolved,
        "source": source,
        "screen_value": screen_value,
        "structured_value": structured_yards,
        "header_yards": header_yards if header_current else None,
        "stable_observations": stable if resolved is not None else 0,
        "ocr_candidates": candidates or [],
        "warning": " | ".join(item for item in warnings if item) or None,
    }
    _CTX["last_pin"] = diag
    return resolved, diag["warning"]


def _safe_pin(screen, tess):
    value, warning, candidates = _distance_screen_read(screen, tess)
    return _resolve_pin(value, warning, candidates)


def _safe_result_overlay(screen, tess):
    value, raw, warning = _BASE_SAFE_OVERLAY(screen, tess)
    _CTX["last_overlay"] = {
        "epoch": time.time(),
        "value": value,
        "raw": raw,
        "warning": warning,
    }
    return value, raw, warning


def _structured_green(shot):
    if not shot:
        return False
    if str(shot.get("ending_surface") or "").lower() == "green":
        return True
    return _BASE_STRUCTURED_GREEN(shot)


def _structured_surface_text(shot):
    if not shot:
        return ""
    mapped = " ".join(
        str(shot.get(key) or "").lower()
        for key in ("ending_surface", "starting_surface")
    )
    return f"{mapped} {_BASE_STRUCTURED_SURFACE_TEXT(shot)}".strip()


def _append_evidence(state, payload):
    enriched = copy.deepcopy(payload)
    enriched["source_policy_v32"] = {
        "gspro_db_active_hole": "diagnostic-only",
        "output_log_all_players_holed_out": "terminal-authority",
        "next_hole": "deterministic-N-plus-1-with-screen-preshot-corroboration",
        "structured_distance_units": "meters-converted-to-yards",
        "screen_pin": "adaptive-consensus-with-structured/header-sanity",
    }
    if _CTX.get("structured_pin"):
        enriched["structured_pin_resolver"] = dict(_CTX["structured_pin"])
    if _CTX.get("last_pin"):
        enriched.setdefault("screen", {})["pin_resolver"] = dict(_CTX["last_pin"])

    pending = state.get("pending_tee")
    if pending:
        now = time.time()
        shot1 = _CTX.get("screen_shot") == 1
        tee = bool(_CTX.get("surface_tee"))
        header = _CTX.get("header") or {}
        expected_hole = (
            core._int(pending.get("hole"))
            or core._int(state.get("current_hole"))
        )
        header_expected = (
            core._int(header.get("hole_number")) == expected_hole
            if expected_hole
            else False
        )
        pin_diag = _CTX.get("last_pin") or {}
        pin_recent = bool(
            pin_diag.get("epoch")
            and now - float(pin_diag["epoch"]) <= 2.0
        )
        overlay = _CTX.get("last_overlay") or {}
        overlay_recent = bool(
            overlay.get("epoch")
            and now - float(overlay["epoch"]) <= 2.0
        )
        blockers = []
        if not (shot1 or tee):
            blockers.append("no-preshot-cue")
        if overlay_recent and overlay.get("value"):
            blockers.append(f"result-overlay-{overlay.get('value')}")
        if not pin_recent or pin_diag.get("value") is None:
            blockers.append("pin-distance-unavailable")
        elif int(pin_diag.get("stable_observations") or 0) < 2:
            blockers.append("pin-distance-not-yet-stable")
        enriched["tee_readiness"] = {
            "hole": expected_hole,
            "shot_1": shot1,
            "tee_surface": tee,
            "header_expected_hole": header_expected,
            "pin": pin_diag if pin_recent else None,
            "result_overlay": overlay if overlay_recent else None,
            "attempts": pending.get("attempts"),
            "blocked_by": blockers,
            "ready_by_observed_cues": not blockers,
        }
    return _BASE_APPEND_EVIDENCE(state, enriched)


def _run_capture(script_name, args, tee, *, hole_model_path=None):
    keys = (
        "LOOPER_TEE_PIN_FALLBACK_YDS",
        "LOOPER_STRUCTURED_PIN_YDS",
        "LOOPER_STRUCTURED_HOLE",
    )
    old = {key: os.environ.get(key) for key in keys}
    try:
        for key in keys:
            os.environ.pop(key, None)
        if tee:
            pin = (_CTX.get("last_pin") or {}).get("value")
            if pin is not None:
                os.environ["LOOPER_TEE_PIN_FALLBACK_YDS"] = str(float(pin))
        else:
            structured = _CTX.get("structured_pin") or {}
            if structured.get("distance_to_pin_yds") is not None:
                os.environ["LOOPER_STRUCTURED_PIN_YDS"] = str(
                    float(structured["distance_to_pin_yds"])
                )
            if structured.get("hole") is not None:
                os.environ["LOOPER_STRUCTURED_HOLE"] = str(structured["hole"])
        return _BASE_RUN_CAPTURE(
            script_name,
            args,
            tee,
            hole_model_path=hole_model_path,
        )
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _validate_tee_capture(capture_dir):
    ok, reason = _BASE_VALIDATE_TEE(capture_dir)
    if not ok:
        return ok, reason
    try:
        model = json.loads(
            (capture_dir / "hole_model.json").read_text(encoding="utf-8")
        )
        base = model.get("base_geometry")
        if isinstance(base, dict) and base.get("available") is False:
            return False, (
                "base HoleModel geometry unavailable: "
                f"{base.get('warning') or 'unknown'}"
            )
    except Exception as exc:
        return False, f"could not validate resilient base HoleModel: {exc}"
    return True, None


def install():
    core._cfg = _cfg
    core._blank_state = _blank_state
    core._summarize_shot = _summarize_shot
    core._read_current_round = _read_current_round
    core._emit = _emit
    core._latch_round_identity = _latch_round_identity
    core._identity_key = _identity_key
    core._db_consistency = _db_consistency
    core._bootstrap = _bootstrap
    core._transition = _transition
    core._terminal = _terminal
    core._enter_hole = _enter_hole
    core._maybe_advance_from_structured = _maybe_advance_from_structured
    core._safe_shot_number = _safe_shot_number
    core._safe_surface = _safe_surface
    core._safe_header = _safe_header
    core._safe_pin = _safe_pin
    core._safe_result_overlay = _safe_result_overlay
    core._structured_green = _structured_green
    core._structured_surface_text = _structured_surface_text
    core._append_evidence = _append_evidence
    core._run_capture = _run_capture
    core._validate_tee_capture = _validate_tee_capture


install()


if __name__ == "__main__":
    print(
        "Looper watcher policy v3.2 active over v3.1 engine: "
        "DB ActiveHole diagnostic-only; fail-soft capture probes enabled."
    )
    raise SystemExit(core.main())
