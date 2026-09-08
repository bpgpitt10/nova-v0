#!/usr/bin/env python3
"""Passive GSPro source/timing probe for Looper round-state research.

This tool intentionally presses no keys and changes no GSPro state. It watches the
machine-readable GSPro sources at high frequency while independently sampling the
screen readers already proven by the minimap work.

Captured sources:
- currentRound.dat: every changed full snapshot + normalized newly completed shots;
- output_log.txt: every appended raw byte + conservative parsed semantic facts;
- GSPro.db Round table: current row changes, including ActiveHole timing;
- screen: minimap surface, upper-left shot/DTP/elevation, lie slope and header OCR.

The purpose is source arbitration research: prove which structured source owns each
fact before TrustedRoundState replaces OCR-driven lifecycle inference.
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
    shot_ids_from_summaries,
    summarize_current_round_payload,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Passive GSPro structured-source/timing probe")
    p.add_argument("--gspro-dir", help="GSPro LocalLow folder; auto-discovers normal Windows path")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Optional minimap x,y,w,h override")
    p.add_argument("--tesseract")
    p.add_argument("--file-poll-ms", type=float, default=60.0)
    p.add_argument("--db-poll-ms", type=float, default=100.0)
    p.add_argument("--screen-poll-ms", type=float, default=500.0)
    p.add_argument("--screen-heartbeat-seconds", type=float, default=5.0)
    p.add_argument("--no-screen", action="store_true", help="Skip screen sampling; file/log/db capture still runs")
    p.add_argument("--duration-seconds", type=float, help="Optional automatic stop time")
    p.add_argument("--output-dir", default=str(Path(__file__).with_name("output")))
    return p.parse_args()


def _gspro_dir(explicit: str | None) -> Path:
    if explicit:
        path = Path(os.path.expandvars(os.path.expanduser(explicit)))
    else:
        path = Path.home() / "AppData" / "LocalLow" / "GSPro" / "GSPro"
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


class EventWriter:
    def __init__(self, output_root: Path) -> None:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.session_dir = output_root / f"gspro_event_probe_{stamp}"
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.current_round_dir = self.session_dir / "current_round_snapshots"
        self.screen_dir = self.session_dir / "screens"
        self.current_round_dir.mkdir(exist_ok=True)
        self.screen_dir.mkdir(exist_ok=True)
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

    @property
    def elapsed_ms(self) -> float:
        return (time.perf_counter() - self._start_perf) * 1000.0

    def emit(self, source: str, event: str, payload: dict[str, Any] | None = None, console: str | None = None) -> None:
        with self._lock:
            self._seq += 1
            key = f"{source}:{event}"
            self._counts[key] = self._counts.get(key, 0) + 1
            now = datetime.now(timezone.utc)
            record = {
                "seq": self._seq,
                "utc": now.isoformat(),
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
        if not raw:
            return
        with self._lock:
            self._raw_log.write(raw)

    def save_current_round(self, raw: bytes) -> str:
        with self._lock:
            self._current_round_snapshot += 1
            name = f"current_round_{self._current_round_snapshot:04d}.dat"
            (self.current_round_dir / name).write_bytes(raw)
            return name

    def save_screen(self, image) -> str | None:
        with self._lock:
            self._screen_snapshot += 1
            name = f"screen_{self._screen_snapshot:04d}.jpg"
            path = self.screen_dir / name
            ok = cv2.imwrite(str(path), image, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
            return name if ok else None

    def close(self) -> Path:
        self.emit("probe", "stopped", {"counts": self._counts})
        with self._lock:
            self._timeline.flush()
            self._timeline.close()
            self._raw_log.close()
            summary = {
                "session_dir": str(self.session_dir),
                "event_count": self._seq,
                "counts": self._counts,
            }
            (self.session_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        archive_base = str(self.session_dir)
        archive_path = Path(shutil.make_archive(archive_base, "zip", root_dir=self.session_dir))
        latest = self.session_dir.parent / "latest_gspro_event_probe.zip"
        shutil.copyfile(archive_path, latest)
        return latest


def _current_round_worker(path: Path, writer: EventWriter, stop: threading.Event, poll_s: float) -> None:
    last_hash: str | None = None
    known_shot_ids: set[str] = set()
    baseline_done = False
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

            payload = _decode_json_bytes(raw)
            summaries = summarize_current_round_payload(payload)
            snapshot = writer.save_current_round(raw)
            all_ids = shot_ids_from_summaries(summaries)
            metadata = {
                "path": str(path),
                "snapshot": snapshot,
                "sha256": digest,
                "size": len(raw),
                "file_mtime_ns": stat.st_mtime_ns,
                "shot_count": len(summaries),
                "latest_shot": summaries[-1] if summaries else None,
            }

            if not baseline_done:
                known_shot_ids = set(all_ids)
                writer.emit("current_round", "baseline", metadata, f"currentRound baseline: {len(summaries)} shot records")
                baseline_done = True
            else:
                writer.emit("current_round", "changed", metadata)
                for shot in summaries:
                    shot_id = shot.get("shot_id")
                    if shot_id in (None, "") or str(shot_id) in known_shot_ids:
                        continue
                    h = shot.get("hole_display")
                    s = shot.get("hole_shot")
                    writer.emit(
                        "current_round",
                        "shot_completed",
                        shot,
                        f"currentRound SHOT: H{h if h is not None else '?'} S{s if s is not None else '?'} | {str(shot_id)[:8]}",
                    )
                known_shot_ids.update(all_ids)

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
                offset = 0
                carry = ""

            if size > offset:
                with path.open("rb") as handle:
                    handle.seek(offset)
                    raw = handle.read(size - offset)
                offset += len(raw)
                writer.append_raw_log(raw)
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


def _read_latest_round_row(path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    connection = sqlite3.connect(str(path), timeout=0.05)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        columns = [str(row[1]) for row in connection.execute('PRAGMA table_info("Round")').fetchall()]
        if not columns:
            return None, []

        wanted = [
            "ID", "PlayerName", "PlayerID", "DateCreated", "DateModified",
            "CourseCode", "CourseName", "ActiveHole", "RoundStatus", "RoundType",
            "NumberOfPlayers", "RoundSettings", "RoundData", "CourseGKD",
        ]
        selected = [name for name in wanted if name in columns]
        if not selected:
            return None, columns
        quoted = ",".join(f'"{name}"' for name in selected)
        row = connection.execute(f'SELECT {quoted} FROM "Round" ORDER BY "ID" DESC LIMIT 1').fetchone()
        if row is None:
            return None, columns
        payload = dict(row)
        for encoded in ("RoundSettings", "RoundData"):
            if encoded in payload:
                value = payload.pop(encoded)
                if value is None:
                    payload[f"{encoded}Length"] = None
                    payload[f"{encoded}Sha256"] = None
                else:
                    raw = str(value).encode("utf-8", errors="replace")
                    payload[f"{encoded}Length"] = len(raw)
                    payload[f"{encoded}Sha256"] = hashlib.sha256(raw).hexdigest()
        return normalize_round_db_row(payload), columns
    finally:
        connection.close()


def _db_worker(path: Path, writer: EventWriter, stop: threading.Event, poll_s: float) -> None:
    last_signature: str | None = None
    schema_logged = False
    last_error: str | None = None

    while not stop.is_set():
        try:
            if not path.exists():
                if last_error != "missing":
                    writer.emit("gspro_db", "missing", {"path": str(path)}, "GSPro.db: missing")
                    last_error = "missing"
                stop.wait(poll_s)
                continue

            row, columns = _read_latest_round_row(path)
            if not schema_logged:
                writer.emit("gspro_db", "round_schema", {"columns": columns})
                schema_logged = True
            signature = json.dumps(row, sort_keys=True, default=str)
            if signature != last_signature:
                event = "baseline" if last_signature is None else "round_row_changed"
                console = None
                if row is not None:
                    console = (
                        f"GSPro.db {event}: round={row.get('ID')} "
                        f"ActiveHole raw={row.get('ActiveHoleRawZeroBased')} display={row.get('ActiveHoleDisplay')} "
                        f"status={row.get('RoundStatus')}"
                    )
                writer.emit("gspro_db", event, {"row": row, "db_mtime_ns": path.stat().st_mtime_ns}, console)
                last_signature = signature
            last_error = None
        except Exception as exc:
            message = str(exc)
            if message != last_error:
                writer.emit("gspro_db", "read_error", {"error": message})
                last_error = message
        stop.wait(poll_s)


def _screen_worker(
    writer: EventWriter,
    stop: threading.Event,
    monitor: int,
    roi: str | None,
    tesseract: str | None,
    poll_s: float,
    heartbeat_s: float,
) -> None:
    last_signature: str | None = None
    last_emit_perf = 0.0
    last_error: str | None = None

    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="gspro-screen-probe") as executor:
        while not stop.is_set():
            started = time.perf_counter()
            capture_epoch = time.time()
            try:
                screen = base.capture_monitor(monitor)
                minimap, _ = base.crop_minimap(screen, roi)

                surface_future = executor.submit(minimap_surface.read_minimap_surface, minimap, tesseract_path=tesseract)
                upper_future = executor.submit(upper_left_state.read_upper_left_state, screen, tesseract_path=tesseract)
                lie_future = executor.submit(lie_state.read_lie_state, screen, tesseract_path=tesseract)
                identity_future = executor.submit(round_identity.try_read_round_identity, screen, tesseract_path=tesseract)

                errors: dict[str, str] = {}
                surface = upper = lie = identity = None
                identity_warning = None
                try:
                    surface = surface_future.result()
                except Exception as exc:
                    errors["surface"] = str(exc)
                try:
                    upper = upper_future.result()
                except Exception as exc:
                    errors["upper_left"] = str(exc)
                try:
                    lie = lie_future.result()
                except Exception as exc:
                    errors["lie"] = str(exc)
                try:
                    identity, identity_warning = identity_future.result()
                except Exception as exc:
                    errors["identity"] = str(exc)

                surface_dict = _as_dict(surface)
                upper_dict = _as_dict(upper)
                lie_dict = _as_dict(lie)
                identity_dict = _as_dict(identity)
                signature_payload = {
                    "surface": surface_dict,
                    "upper_left": upper_dict,
                    "lie": lie_dict,
                    "identity": identity_dict,
                }
                signature = json.dumps(signature_payload, sort_keys=True, default=str)
                now_perf = time.perf_counter()
                changed = signature != last_signature
                heartbeat = (now_perf - last_emit_perf) >= heartbeat_s
                if changed or heartbeat:
                    screen_file = writer.save_screen(screen) if changed else None
                    payload = {
                        **signature_payload,
                        "identity_warning": identity_warning,
                        "errors": errors,
                        "capture_epoch": capture_epoch,
                        "capture_elapsed_ms": round(writer.elapsed_ms - ((time.time() - capture_epoch) * 1000.0), 3),
                        "screen_file": screen_file,
                        "changed": changed,
                    }
                    label = surface_dict.get("label") if isinstance(surface_dict, dict) else None
                    is_tee = surface_dict.get("is_tee") if isinstance(surface_dict, dict) else None
                    shot = upper_dict.get("shot_number") if isinstance(upper_dict, dict) else None
                    dtp = upper_dict.get("distance_to_pin_yds") if isinstance(upper_dict, dict) else None
                    hocr = identity_dict.get("hole_number") if isinstance(identity_dict, dict) else None
                    writer.emit(
                        "screen",
                        "observation",
                        payload,
                        f"SCREEN: surface={label or '?'} tee={is_tee} shot={shot} dtp={dtp} headerHole={hocr}",
                    )
                    last_signature = signature
                    last_emit_perf = now_perf
                last_error = None
            except Exception as exc:
                message = str(exc)
                if message != last_error:
                    writer.emit("screen", "read_error", {"error": message})
                    last_error = message

            elapsed = time.perf_counter() - started
            stop.wait(max(0.0, poll_s - elapsed))


def main() -> int:
    args = parse_args()
    gspro = _gspro_dir(args.gspro_dir)
    output_root = Path(args.output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    writer = EventWriter(output_root)
    stop = threading.Event()

    current_round = gspro / "currentRound.dat"
    output_log = gspro / "output_log.txt"
    db = gspro / "GSPro.db"

    manifest = {
        "schema_version": "looper-gspro-event-probe-v1",
        "purpose": "passive source/timing research; no GSPro keys or actions",
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "gspro_dir": str(gspro),
        "sources": {
            "current_round": str(current_round),
            "output_log": str(output_log),
            "gspro_db": str(db),
            "screen_enabled": not args.no_screen,
        },
        "poll_ms": {
            "file": args.file_poll_ms,
            "db": args.db_poll_ms,
            "screen": args.screen_poll_ms,
        },
    }
    (writer.session_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    writer.emit("probe", "started", manifest)

    print("Looper GSPro PASSIVE EVENT PROBE", flush=True)
    print("NO KEYS / NO CAPTURE ACTIONS / NO GSPro STATE CHANGES", flush=True)
    print(f"GSPro: {gspro}", flush=True)
    print(f"Output: {writer.session_dir}", flush=True)
    print("Play normally. Ctrl+C when finished; a ZIP will be created automatically.", flush=True)

    threads = [
        threading.Thread(
            target=_current_round_worker,
            args=(current_round, writer, stop, max(0.02, args.file_poll_ms / 1000.0)),
            daemon=True,
            name="current-round-watch",
        ),
        threading.Thread(
            target=_output_log_worker,
            args=(output_log, writer, stop, max(0.02, args.file_poll_ms / 1000.0)),
            daemon=True,
            name="output-log-watch",
        ),
        threading.Thread(
            target=_db_worker,
            args=(db, writer, stop, max(0.04, args.db_poll_ms / 1000.0)),
            daemon=True,
            name="gspro-db-watch",
        ),
    ]
    if not args.no_screen:
        threads.append(threading.Thread(
            target=_screen_worker,
            args=(
                writer,
                stop,
                args.monitor,
                args.roi,
                args.tesseract,
                max(0.15, args.screen_poll_ms / 1000.0),
                max(1.0, args.screen_heartbeat_seconds),
            ),
            daemon=True,
            name="screen-watch",
        ))

    for thread in threads:
        thread.start()

    deadline = time.monotonic() + args.duration_seconds if args.duration_seconds else None
    try:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                break
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=3.0)
        latest = writer.close()
        print(f"Saved probe ZIP: {latest}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
