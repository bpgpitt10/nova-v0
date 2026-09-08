#!/usr/bin/env python3
"""Passive GSPro source/timing probe v3 for Looper live-state research.

NO KEYS. NO GSPro MUTATION. This is instrumentation only.

V3 is deliberately source-agnostic while we establish authority/timing:
- currentRound.dat: save every changed byte snapshot, including transient invalid JSON,
  then normalize completed-shot records and new ShotIDs;
- output_log.txt: save every appended byte exactly and conservatively extract research
  signals without discarding unknown lines;
- GSPro.db: capture schema once, then observe BOTH the latest Round row and the row
  correlated to currentRound.RoundID. This avoids accidentally hiding a fresh pre-shot
  round behind stale currentRound data;
- screen: sample existing Looper readers as independent validation. Raw header/shot OCR
  remains in the payload but does not drive screenshot change detection, preventing
  known 1/7 OCR jitter from flooding the research artifact.

Opaque RoundSettings/RoundData values are saved exactly when their content changes.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import time
from typing import Any

import cv2

import lie_state
import minimap_surface
import probe as base
import round_identity
import upper_left_state

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.gspro_sources import (  # noqa: E402
    normalize_round_db_row,
    parse_output_log_line,
    round_ids_from_summaries,
    shot_ids_from_summaries,
    summarize_current_round_payload,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Passive GSPro structured-source/timing probe v3")
    p.add_argument("--gspro-dir", help="GSPro LocalLow folder; auto-discovers normal Windows path")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Optional minimap x,y,w,h override")
    p.add_argument("--tesseract")
    p.add_argument("--file-poll-ms", type=float, default=60.0)
    p.add_argument("--db-poll-ms", type=float, default=100.0)
    p.add_argument("--screen-poll-ms", type=float, default=500.0)
    p.add_argument("--screen-heartbeat-seconds", type=float, default=5.0)
    p.add_argument("--no-screen", action="store_true")
    p.add_argument("--duration-seconds", type=float)
    p.add_argument("--output-dir", default=str(Path(__file__).with_name("output")))
    return p.parse_args()


def _gspro_dir(explicit: str | None) -> Path:
    path = (
        Path(os.path.expandvars(os.path.expanduser(explicit)))
        if explicit
        else Path.home() / "AppData" / "LocalLow" / "GSPro" / "GSPro"
    )
    if not path.exists():
        raise FileNotFoundError(f"GSPro directory not found: {path}")
    return path


def _decode_json_bytes(raw: bytes) -> Any:
    last_error: Exception | None = None
    for enc in ("utf-8-sig", "utf-16", "utf-8"):
        try:
            return json.loads(raw.decode(enc))
        except Exception as exc:
            last_error = exc
    raise ValueError(f"could not decode currentRound.dat JSON: {last_error}")


def _as_dict(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return value
    return str(value)


def _json_hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _latest_shot(summaries: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not summaries:
        return None
    numbered = [row for row in summaries if isinstance(row.get("global_shot_number"), int)]
    return max(numbered, key=lambda row: int(row["global_shot_number"])) if numbered else summaries[-1]


class SharedProbeState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._round_id: int | None = None
        self._course_key: str | None = None
        self._last_completed_hole: int | None = None

    def update_from_current_round(self, latest: dict[str, Any] | None) -> None:
        if not latest:
            return
        with self._lock:
            try:
                value = latest.get("round_id")
                self._round_id = int(value) if value is not None else self._round_id
            except (TypeError, ValueError):
                pass
            if latest.get("course_key"):
                self._course_key = str(latest["course_key"])
            if isinstance(latest.get("hole_display"), int):
                self._last_completed_hole = int(latest["hole_display"])

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "current_round_id": self._round_id,
                "course_key": self._course_key,
                "last_completed_hole": self._last_completed_hole,
            }


class EventWriter:
    def __init__(self, output_root: Path) -> None:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.session_dir = output_root / f"gspro_event_probe_v3_{stamp}"
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.current_round_dir = self.session_dir / "current_round_snapshots"
        self.screen_dir = self.session_dir / "screens"
        self.db_artifact_dir = self.session_dir / "db_artifacts"
        self.current_round_dir.mkdir(exist_ok=True)
        self.screen_dir.mkdir(exist_ok=True)
        self.db_artifact_dir.mkdir(exist_ok=True)
        self.timeline_path = self.session_dir / "timeline.jsonl"
        self.raw_log_path = self.session_dir / "output_log_delta.txt"
        self._timeline = self.timeline_path.open("a", encoding="utf-8", buffering=1)
        self._raw_log = self.raw_log_path.open("ab", buffering=0)
        self._lock = threading.Lock()
        self._start_perf = time.perf_counter()
        self._seq = 0
        self._counts: dict[str, int] = {}
        self._current_round_snapshot = 0
        self._screen_snapshot = 0
        self._db_artifact_snapshot = 0

    @property
    def elapsed_ms(self) -> float:
        return (time.perf_counter() - self._start_perf) * 1000.0

    def emit(self, source: str, event: str, payload: dict[str, Any] | None = None, console: str | None = None) -> None:
        with self._lock:
            self._seq += 1
            key = f"{source}:{event}"
            self._counts[key] = self._counts.get(key, 0) + 1
            record = {
                "seq": self._seq,
                "utc": datetime.now(timezone.utc).isoformat(),
                "epoch": time.time(),
                "elapsed_ms": round(self.elapsed_ms, 3),
                "source": source,
                "event": event,
                "payload": payload or {},
            }
            self._timeline.write(json.dumps(record, separators=(",", ":"), default=str) + "\n")
            if console:
                print(console, flush=True)

    def append_raw_log(self, raw: bytes) -> None:
        if raw:
            with self._lock:
                self._raw_log.write(raw)

    def save_current_round(self, raw: bytes, *, valid_json: bool) -> str:
        with self._lock:
            self._current_round_snapshot += 1
            status = "valid" if valid_json else "invalid"
            name = f"current_round_{self._current_round_snapshot:04d}_{status}.dat"
            (self.current_round_dir / name).write_bytes(raw)
            return name

    def save_screen(self, image) -> str | None:
        with self._lock:
            self._screen_snapshot += 1
            name = f"screen_{self._screen_snapshot:04d}.jpg"
            path = self.screen_dir / name
            ok = cv2.imwrite(str(path), image, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
            return name if ok else None

    def save_db_artifact(self, row_label: str, round_id: Any, field: str, raw: bytes) -> str:
        with self._lock:
            self._db_artifact_snapshot += 1
            safe_round = str(round_id if round_id is not None else "unknown").replace("/", "_")
            safe_field = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in field)
            name = f"{self._db_artifact_snapshot:04d}_{row_label}_round-{safe_round}_{safe_field}.bin"
            (self.db_artifact_dir / name).write_bytes(raw)
            return name

    def save_db_schema(self, schema: dict[str, Any]) -> None:
        (self.session_dir / "gspro_db_schema.json").write_text(
            json.dumps(schema, indent=2, default=str), encoding="utf-8"
        )

    def close(self) -> Path:
        self.emit("probe", "stopped", {"counts": self._counts})
        with self._lock:
            self._timeline.flush()
            self._timeline.close()
            self._raw_log.close()
            (self.session_dir / "summary.json").write_text(json.dumps({
                "session_dir": str(self.session_dir),
                "event_count": self._seq,
                "counts": self._counts,
            }, indent=2), encoding="utf-8")
        archive_path = Path(shutil.make_archive(str(self.session_dir), "zip", root_dir=self.session_dir))
        latest = self.session_dir.parent / "latest_gspro_event_probe.zip"
        shutil.copyfile(archive_path, latest)
        return latest


def _current_round_worker(path: Path, writer: EventWriter, shared: SharedProbeState, stop: threading.Event, poll_s: float) -> None:
    last_hash: str | None = None
    known_shot_ids: set[str] = set()
    baseline_done = False
    last_round_ids: set[int] = set()
    last_error: str | None = None

    while not stop.is_set():
        try:
            if not path.exists():
                if last_error != "missing":
                    writer.emit("current_round", "missing", {"path": str(path)}, "currentRound.dat: missing")
                    last_error = "missing"
                stop.wait(poll_s)
                continue

            stat = path.stat()
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if digest == last_hash:
                stop.wait(poll_s)
                continue

            try:
                payload = _decode_json_bytes(raw)
                summaries = summarize_current_round_payload(payload)
            except Exception as exc:
                snapshot = writer.save_current_round(raw, valid_json=False)
                writer.emit("current_round", "parse_error", {
                    "path": str(path), "snapshot": snapshot, "sha256": digest,
                    "size": len(raw), "file_mtime_ns": stat.st_mtime_ns, "error": str(exc),
                }, "currentRound transient parse error captured")
                last_hash = digest
                last_error = str(exc)
                stop.wait(poll_s)
                continue

            snapshot = writer.save_current_round(raw, valid_json=True)
            all_ids = shot_ids_from_summaries(summaries)
            round_ids = round_ids_from_summaries(summaries)
            latest = _latest_shot(summaries)
            shared.update_from_current_round(latest)
            metadata = {
                "path": str(path), "snapshot": snapshot, "sha256": digest,
                "size": len(raw), "file_mtime_ns": stat.st_mtime_ns,
                "shot_count": len(summaries), "round_ids": sorted(round_ids), "latest_shot": latest,
            }

            if not baseline_done:
                known_shot_ids = set(all_ids)
                last_round_ids = set(round_ids)
                writer.emit("current_round", "baseline", metadata, f"currentRound baseline: {len(summaries)} shot records")
                baseline_done = True
            else:
                if round_ids != last_round_ids and round_ids:
                    writer.emit("current_round", "round_ids_changed", {
                        "previous_round_ids": sorted(last_round_ids),
                        "current_round_ids": sorted(round_ids),
                    })
                writer.emit("current_round", "changed", metadata)
                for shot in summaries:
                    shot_id = shot.get("shot_id")
                    if shot_id in (None, "") or str(shot_id) in known_shot_ids:
                        continue
                    writer.emit("current_round", "shot_completed", shot,
                                f"currentRound SHOT: H{shot.get('hole_display') or '?'} S{shot.get('hole_shot') or '?'} | {str(shot_id)[:8]}")
                known_shot_ids.update(all_ids)
                last_round_ids = set(round_ids)

            last_hash = digest
            last_error = None
        except Exception as exc:
            message = str(exc)
            if message != last_error:
                writer.emit("current_round", "read_error", {"error": message})
                last_error = message
        stop.wait(poll_s)


def _output_log_worker(path: Path, writer: EventWriter, stop: threading.Event, poll_s: float) -> None:
    offset: int | None = None
    carry = ""
    last_error: str | None = None
    while not stop.is_set():
        try:
            if not path.exists():
                if last_error != "missing":
                    writer.emit("output_log", "missing", {"path": str(path)}, "output_log.txt: missing")
                    last_error = "missing"
                stop.wait(poll_s)
                continue

            size = path.stat().st_size
            if offset is None:
                offset = size
                writer.emit("output_log", "baseline", {"path": str(path), "start_offset": offset}, f"output_log baseline offset: {offset}")
                stop.wait(poll_s)
                continue
            if size < offset:
                writer.emit("output_log", "truncated", {"old_offset": offset, "new_size": size})
                offset, carry = 0, ""
            if size > offset:
                start_offset = offset
                with path.open("rb") as handle:
                    handle.seek(offset)
                    raw = handle.read(size - offset)
                offset += len(raw)
                writer.append_raw_log(raw)
                writer.emit("output_log", "bytes_appended", {
                    "start_offset": start_offset, "end_offset": offset,
                    "byte_count": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                })
                text = carry + raw.decode("utf-8", errors="replace")
                parts = text.splitlines(keepends=True)
                carry = ""
                for part in parts:
                    if not part.endswith(("\n", "\r")):
                        carry = part
                        continue
                    line = part.rstrip("\r\n")
                    for fact in parse_output_log_line(line):
                        payload = fact.to_dict()
                        kind = payload.pop("kind")
                        console = None
                        if kind == "surface_material":
                            console = f"output_log MATERIAL: {payload.get('material')}"
                        elif kind == "active_game_state":
                            console = f"output_log STATE: H{payload.get('hole_display')} strokes={payload.get('strokes')}"
                        elif kind == "current_hole_observation":
                            console = f"output_log HOLE: H{payload.get('hole_display')}"
                        elif kind == "hole_terminal":
                            console = "output_log HOLE TERMINAL: AllPlayersHoledOut"
                        elif kind == "wind_log_line":
                            console = f"output_log WIND: {payload.get('raw')}"
                        writer.emit("output_log", kind, payload, console)
            last_error = None
        except Exception as exc:
            message = str(exc)
            if message != last_error:
                writer.emit("output_log", "read_error", {"error": message})
                last_error = message
        stop.wait(poll_s)


def _sqlite_schema(path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(str(path), timeout=0.2)
    try:
        connection.execute("PRAGMA query_only=ON")
        objects = connection.execute(
            "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY type,name"
        ).fetchall()
        schema: dict[str, Any] = {"objects": []}
        for name, kind, sql in objects:
            escaped = str(name).replace("'", "''")
            try:
                columns = [{
                    "cid": row[0], "name": row[1], "type": row[2],
                    "notnull": row[3], "default": row[4], "pk": row[5],
                } for row in connection.execute(f"PRAGMA table_info('{escaped}')").fetchall()]
            except sqlite3.Error:
                columns = []
            schema["objects"].append({"name": name, "type": kind, "sql": sql, "columns": columns})
        return schema
    finally:
        connection.close()


def _bytes_for_db_value(value: Any) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value
    if isinstance(value, memoryview):
        return bytes(value)
    return str(value).encode("utf-8", errors="replace")


def _read_round_rows(path: Path, preferred_round_id: int | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[dict[str, Any]]]:
    connection = sqlite3.connect(str(path), timeout=0.08)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        columns = [str(row[1]) for row in connection.execute('PRAGMA table_info("Round")').fetchall()]
        if not columns:
            return None, None, []
        wanted = [
            "ID", "PlayerName", "PlayerID", "DateCreated", "DateModified", "CourseCode", "CourseName",
            "ActiveHole", "RoundStatus", "RoundType", "NumberOfPlayers", "RoundSettings", "RoundData", "CourseGKD",
        ]
        selected = [name for name in wanted if name in columns]
        if not selected:
            return None, None, []
        quoted = ",".join(f'"{name}"' for name in selected)

        def prepare(row: sqlite3.Row | None) -> dict[str, Any] | None:
            if row is None:
                return None
            payload = dict(row)
            artifacts: dict[str, bytes | None] = {}
            for field in ("RoundSettings", "RoundData"):
                if field not in payload:
                    continue
                raw = _bytes_for_db_value(payload.pop(field))
                artifacts[field] = raw
                payload[f"{field}Length"] = len(raw) if raw is not None else None
                payload[f"{field}Sha256"] = hashlib.sha256(raw).hexdigest() if raw is not None else None
            normalized = normalize_round_db_row(payload)
            normalized["_artifacts"] = artifacts
            return normalized

        latest_order = ' ORDER BY "ID" DESC' if "ID" in columns else ""
        latest = prepare(connection.execute(f'SELECT {quoted} FROM "Round"{latest_order} LIMIT 1').fetchone())
        correlated = None
        if preferred_round_id is not None and "ID" in columns:
            correlated = prepare(connection.execute(
                f'SELECT {quoted} FROM "Round" WHERE "ID"=? LIMIT 1', (preferred_round_id,)
            ).fetchone())

        recent_fields = [name for name in (
            "ID", "PlayerName", "CourseCode", "CourseName", "ActiveHole", "RoundStatus", "RoundType", "DateModified"
        ) if name in columns]
        recent: list[dict[str, Any]] = []
        if recent_fields:
            q = ",".join(f'"{name}"' for name in recent_fields)
            recent = [dict(row) for row in connection.execute(f'SELECT {q} FROM "Round"{latest_order} LIMIT 5').fetchall()]
        return correlated, latest, recent
    finally:
        connection.close()


def _strip_artifacts(row: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, bytes | None]]:
    if row is None:
        return None, {}
    clean = dict(row)
    artifacts = dict(clean.pop("_artifacts", {}) or {})
    return clean, artifacts


def _db_worker(path: Path, writer: EventWriter, shared: SharedProbeState, stop: threading.Event, poll_s: float) -> None:
    last_signature: str | None = None
    last_artifact_hashes: dict[tuple[str, Any, str], str] = {}
    last_error: str | None = None

    # Schema is expensive and nearly static. Snapshot it once, not every 100ms.
    try:
        schema = _sqlite_schema(path)
        writer.save_db_schema(schema)
        writer.emit("gspro_db", "schema_snapshot", {
            "sha256": _json_hash(schema), "object_count": len(schema.get("objects") or []),
        })
    except Exception as exc:
        writer.emit("gspro_db", "schema_error", {"error": str(exc)})

    while not stop.is_set():
        try:
            if not path.exists():
                if last_error != "missing":
                    writer.emit("gspro_db", "missing", {"path": str(path)}, "GSPro.db: missing")
                    last_error = "missing"
                stop.wait(poll_s)
                continue
            shared_snapshot = shared.snapshot()
            correlated_raw, latest_raw, recent = _read_round_rows(path, shared_snapshot.get("current_round_id"))
            correlated, correlated_artifacts = _strip_artifacts(correlated_raw)
            latest, latest_artifacts = _strip_artifacts(latest_raw)

            new_artifact_files: dict[str, str] = {}
            for label, row, artifacts in (
                ("correlated", correlated, correlated_artifacts),
                ("latest", latest, latest_artifacts),
            ):
                row_id = row.get("ID") if row else None
                for field, raw in artifacts.items():
                    if raw is None:
                        continue
                    digest = hashlib.sha256(raw).hexdigest()
                    key = (label, row_id, field)
                    if last_artifact_hashes.get(key) != digest:
                        new_artifact_files[f"{label}.{field}"] = writer.save_db_artifact(label, row_id, field, raw)
                        last_artifact_hashes[key] = digest

            payload = {
                "current_round_correlated_row": correlated,
                "latest_round_row": latest,
                "rows_match": bool(correlated is not None and latest is not None and correlated.get("ID") == latest.get("ID")),
                "recent_round_rows": recent,
                "current_round_context": shared_snapshot,
                "db_mtime_ns": path.stat().st_mtime_ns,
                "new_artifact_files": new_artifact_files,
            }
            signature = _json_hash({k: v for k, v in payload.items() if k not in ("db_mtime_ns", "new_artifact_files")})
            if signature != last_signature:
                event = "baseline" if last_signature is None else "round_context_changed"
                latest_hole = (latest or {}).get("ActiveHoleDisplayAssumingZeroBased")
                corr_hole = (correlated or {}).get("ActiveHoleDisplayAssumingZeroBased")
                writer.emit(
                    "gspro_db", event, payload,
                    f"GSPro.db {event}: latest round={(latest or {}).get('ID')} H~{latest_hole} | currentRound-correlated round={(correlated or {}).get('ID')} H~{corr_hole}",
                )
                last_signature = signature
            last_error = None
        except Exception as exc:
            message = str(exc)
            if message != last_error:
                writer.emit("gspro_db", "read_error", {"error": message})
                last_error = message
        stop.wait(poll_s)


def _screen_change_signature(surface: dict | None, upper: dict | None, lie: dict | None) -> dict[str, Any]:
    """Only use gameplay facts that should change with the playable state.

    Header hole and upper-left shot OCR are still captured in every emitted payload,
    but known OCR digit jitter is deliberately excluded from screenshot-trigger logic.
    """
    return {
        "surface": {
            "label": (surface or {}).get("label"), "is_tee": (surface or {}).get("is_tee"),
            "recognized": (surface or {}).get("recognized"),
        },
        "dtp": (upper or {}).get("distance_to_pin_yds"),
        "elevation": (upper or {}).get("elevation_delta_yds"),
        "lie_up_down": (lie or {}).get("signed_up_down_deg"),
        "lie_left_right": (lie or {}).get("signed_left_right_deg"),
    }


def _screen_worker(writer: EventWriter, stop: threading.Event, monitor: int, roi: str | None,
                   tesseract: str | None, poll_s: float, heartbeat_s: float) -> None:
    last_signature: str | None = None
    last_emit_perf = 0.0
    last_error: str | None = None
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="gspro-screen-probe") as executor:
        while not stop.is_set():
            loop_started = time.perf_counter()
            capture_epoch = time.time()
            capture_elapsed_ms = writer.elapsed_ms
            try:
                screen = base.capture_monitor(monitor)
                minimap, _ = base.crop_minimap(screen, roi)
                futures = {
                    "surface": executor.submit(minimap_surface.read_minimap_surface, minimap, tesseract_path=tesseract),
                    "upper": executor.submit(upper_left_state.read_upper_left_state, screen, tesseract_path=tesseract),
                    "lie": executor.submit(lie_state.read_lie_state, screen, tesseract_path=tesseract),
                    "identity": executor.submit(round_identity.try_read_round_identity, screen, tesseract_path=tesseract),
                }
                errors: dict[str, str] = {}
                surface = upper = lie = identity = None
                identity_warning = None
                try:
                    surface = futures["surface"].result()
                except Exception as exc:
                    errors["surface"] = str(exc)
                try:
                    upper = futures["upper"].result()
                except Exception as exc:
                    errors["upper_left"] = str(exc)
                try:
                    lie = futures["lie"].result()
                except Exception as exc:
                    errors["lie"] = str(exc)
                try:
                    identity, identity_warning = futures["identity"].result()
                except Exception as exc:
                    errors["identity"] = str(exc)

                surface_dict, upper_dict, lie_dict, identity_dict = map(
                    _as_dict, (surface, upper, lie, identity)
                )
                change_facts = _screen_change_signature(surface_dict, upper_dict, lie_dict)
                signature = _json_hash(change_facts)
                now_perf = time.perf_counter()
                changed = signature != last_signature
                heartbeat = (now_perf - last_emit_perf) >= heartbeat_s
                if changed or heartbeat:
                    screen_file = writer.save_screen(screen) if changed else None
                    payload = {
                        "change_facts": change_facts,
                        "surface": surface_dict, "upper_left": upper_dict, "lie": lie_dict,
                        "identity": identity_dict, "identity_warning": identity_warning,
                        "errors": errors, "capture_epoch": capture_epoch,
                        "capture_started_elapsed_ms": round(capture_elapsed_ms, 3),
                        "processing_elapsed_ms": round((time.perf_counter() - loop_started) * 1000.0, 3),
                        "screen_size": [int(screen.shape[1]), int(screen.shape[0])],
                        "screen_file": screen_file, "changed": changed,
                    }
                    label = (surface_dict or {}).get("label") if isinstance(surface_dict, dict) else None
                    is_tee = (surface_dict or {}).get("is_tee") if isinstance(surface_dict, dict) else None
                    shot = (upper_dict or {}).get("shot_number") if isinstance(upper_dict, dict) else None
                    dtp = (upper_dict or {}).get("distance_to_pin_yds") if isinstance(upper_dict, dict) else None
                    hocr = (identity_dict or {}).get("hole_number") if isinstance(identity_dict, dict) else None
                    writer.emit("screen", "observation", payload,
                                f"SCREEN: surface={label or '?'} tee={is_tee} shotOCR={shot} dtp={dtp} headerHoleOCR={hocr}")
                    last_signature, last_emit_perf = signature, now_perf
                last_error = None
            except Exception as exc:
                message = str(exc)
                if message != last_error:
                    writer.emit("screen", "read_error", {"error": message})
                    last_error = message
            stop.wait(max(0.0, poll_s - (time.perf_counter() - loop_started)))


def main() -> int:
    args = parse_args()
    gspro = _gspro_dir(args.gspro_dir)
    output_root = Path(args.output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    writer, shared, stop = EventWriter(output_root), SharedProbeState(), threading.Event()
    current_round, output_log, db = gspro / "currentRound.dat", gspro / "output_log.txt", gspro / "GSPro.db"

    manifest = {
        "schema_version": "looper-gspro-event-probe-v3",
        "purpose": "passive source/timing research; no GSPro keys or actions",
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "gspro_dir": str(gspro),
        "sources": {"current_round": str(current_round), "output_log": str(output_log),
                    "gspro_db": str(db), "screen_enabled": not args.no_screen},
        "poll_ms": {"file": args.file_poll_ms, "db": args.db_poll_ms, "screen": args.screen_poll_ms},
        "research_questions": [
            "Does latest GSPro.db Round.ActiveHole change before the next tee shot is hit?",
            "Does output_log currentHole provide a timely current-hole source at the new tee?",
            "Which output_log material values appear for fairway/rough/sand/green/penalty states?",
            "What is the timing order among ShotCompleted, AllPlayersHoledOut, latest ActiveHole and Tee screen state?",
            "Do output_log lines expose usable wind speed/direction rather than only diagnostics?",
            "Do structured distance values consistently align with displayed DTP?",
        ],
    }
    (writer.session_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    writer.emit("probe", "started", manifest)
    print("Looper GSPro PASSIVE EVENT PROBE v3", flush=True)
    print("NO KEYS / NO CAPTURE ACTIONS / NO GSPro STATE CHANGES", flush=True)
    print(f"GSPro: {gspro}", flush=True)
    print(f"Output: {writer.session_dir}", flush=True)
    print("Play normally. Ctrl+C when finished; a ZIP will be created automatically.", flush=True)

    threads = [
        threading.Thread(target=_current_round_worker,
                         args=(current_round, writer, shared, stop, max(0.02, args.file_poll_ms / 1000.0)), daemon=True),
        threading.Thread(target=_output_log_worker,
                         args=(output_log, writer, stop, max(0.02, args.file_poll_ms / 1000.0)), daemon=True),
        threading.Thread(target=_db_worker,
                         args=(db, writer, shared, stop, max(0.04, args.db_poll_ms / 1000.0)), daemon=True),
    ]
    if not args.no_screen:
        threads.append(threading.Thread(target=_screen_worker, args=(
            writer, stop, args.monitor, args.roi, args.tesseract,
            max(0.15, args.screen_poll_ms / 1000.0), max(1.0, args.screen_heartbeat_seconds),
        ), daemon=True))
    for thread in threads:
        thread.start()

    deadline = time.monotonic() + args.duration_seconds if args.duration_seconds else None
    try:
        while deadline is None or time.monotonic() < deadline:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=3.0)
        print(f"Saved probe ZIP: {writer.close()}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
