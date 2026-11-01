"""Read-only bridge to GSPro's own data files, plus a round recorder.

The hosted Looper web app used to need a browser folder grant to read
currentRound.dat, output_log.txt and GSPro.db. The companion already finds
GSPro's data folder, so it serves those three files instead:

* Only the three allowlisted file names are ever served. No paths are accepted
  from the browser and no absolute paths are returned to it.
* Reads are read-only. GSPro's folder is never written.
* The round recorder keeps every round's raw currentRound.dat records in the
  companion's own folder (not GSPro's), so rounds played while the browser is
  closed are not lost. Records are stored verbatim; the web app keeps the one
  parser.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import gspro_native_discovery as native

ALLOWED_GSPRO_FILES = ("currentRound.dat", "output_log.txt", "GSPro.db")
MAX_RESPONSE_BYTES = 256 * 1024 * 1024
MAX_CURRENT_ROUND_BYTES = 64 * 1024 * 1024
FOLDER_CACHE_SECONDS = 15.0
RECORDER_POLL_SECONDS = 3.0
RECORDS_FILE = "round-records.jsonl"
MAX_RECORDS_PER_PAGE = 2000


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class DataFolder:
    """Caches GSPro's discovered data folder so polling stays cheap."""

    def __init__(
        self,
        discover: Callable[[], dict] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._discover = discover or (lambda: native.discover_gspro_data_directory())
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: tuple[float, Path | None] | None = None

    def directory(self) -> Path | None:
        with self._lock:
            now = self._clock()
            if self._cached and now - self._cached[0] < FOLDER_CACHE_SECONDS:
                return self._cached[1]
            try:
                found = self._discover().get("directory")
            except Exception:
                found = None
            directory = Path(found) if found else None
            self._cached = (now, directory)
            return directory


def _allowed_path(directory: Path | None, name: str) -> Path | None:
    if directory is None or name not in ALLOWED_GSPRO_FILES:
        return None
    return directory / name


def stat_gspro_file(directory: Path | None, name: str) -> dict:
    """Size and modified time only; never the path."""
    if name not in ALLOWED_GSPRO_FILES:
        return {"name": name, "status": "forbidden"}
    path = _allowed_path(directory, name)
    if path is None:
        return {"name": name, "status": "gspro-folder-not-found"}
    try:
        info = path.stat()
    except FileNotFoundError:
        return {"name": name, "status": "not-found"}
    except OSError:
        return {"name": name, "status": "unreadable"}
    if not path.is_file():
        return {"name": name, "status": "not-found"}
    return {
        "name": name,
        "status": "ok",
        "size": info.st_size,
        "lastModified": info.st_mtime_ns // 1_000_000,
    }


def read_gspro_file(
    directory: Path | None,
    name: str,
    start: int | None = None,
    end: int | None = None,
) -> tuple[dict, bytes]:
    """Read [start, end) of an allowlisted file. Returns (stat, bytes)."""
    info = stat_gspro_file(directory, name)
    if info["status"] != "ok":
        return info, b""
    size = info["size"]
    begin = 0 if start is None else max(0, min(int(start), size))
    finish = size if end is None else max(begin, min(int(end), size))
    if finish - begin > MAX_RESPONSE_BYTES:
        return {**info, "status": "too-large"}, b""
    path = _allowed_path(directory, name)
    try:
        with open(path, "rb") as handle:  # type: ignore[arg-type]
            handle.seek(begin)
            data = handle.read(finish - begin)
    except OSError:
        return {**info, "status": "unreadable"}, b""
    return {**info, "start": begin, "end": begin + len(data)}, data


def parse_round_records(text: str) -> list[dict]:
    """Same candidate rules as the web app's parseRoundCandidates."""
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return []
    if isinstance(parsed, list):
        candidates = parsed
    elif isinstance(parsed, dict):
        candidates = [item for value in parsed.values() if isinstance(value, list) for item in value]
    else:
        candidates = []
    records = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        if candidate.get("ShotID") in (None, "") or candidate.get("RoundID") in (None, ""):
            continue
        records.append(candidate)
    return records


def _number(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number == number else 0.0


def active_round_id(records: list[dict]):
    """The round GSPro is on now: same ordering rule as the web app."""
    if not records:
        return None
    ordered = sorted(
        records,
        key=lambda record: _number(record.get("GlobalShotNumber"))
        if record.get("GlobalShotNumber") is not None
        else _number(record.get("HoleShot")),
    )
    return ordered[-1].get("RoundID")


def _fingerprint(record: dict) -> str:
    return hashlib.sha1(
        json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


class RoundRecorder:
    """Keeps every round GSPro writes to currentRound.dat.

    Append-only JSON lines in the companion's own data folder. A record is
    written again only when GSPro changes it, and consumers keep the latest
    version per (RoundID, ShotID).
    """

    def __init__(self, store_dir: Path, read_current_round: Callable[[], str | None]) -> None:
        self._store_dir = Path(store_dir)
        self._read = read_current_round
        self._lock = threading.Lock()
        self._seen: dict[str, str] = {}
        self._seq = 0
        self._active_round_id = None
        self._last_poll: str | None = None
        self._last_error: str | None = None
        self._load()

    @property
    def path(self) -> Path:
        return self._store_dir / RECORDS_FILE

    def _load(self) -> None:
        if not self.path.is_file():
            return
        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue  # a torn final line from a crash is skipped, not fatal
                record = entry.get("record")
                if not isinstance(record, dict):
                    continue
                self._seq = max(self._seq, int(entry.get("seq", 0)))
                self._seen[self._key(record)] = _fingerprint(record)

    @staticmethod
    def _key(record: dict) -> str:
        return f"{record.get('RoundID')}:{record.get('ShotID')}"

    def poll_once(self) -> int:
        """Record new or changed shots. Returns how many were written."""
        try:
            text = self._read()
        except Exception as error:  # GSPro mid-write, file missing, etc.
            with self._lock:
                self._last_error = type(error).__name__
            return 0
        records = parse_round_records(text) if text else []
        written = 0
        with self._lock:
            self._last_poll = _utc_now()
            self._last_error = None
            if records:
                self._active_round_id = active_round_id(records)
            fresh = []
            for record in records:
                key = self._key(record)
                fingerprint = _fingerprint(record)
                if self._seen.get(key) == fingerprint:
                    continue
                self._seq += 1
                fresh.append({"seq": self._seq, "observedAt": self._last_poll, "record": record})
                self._seen[key] = fingerprint
            if fresh:
                self._store_dir.mkdir(parents=True, exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as handle:
                    for entry in fresh:
                        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                written = len(fresh)
        return written

    def records_after(self, after: int, limit: int = 500) -> dict:
        limit = max(1, min(int(limit), MAX_RECORDS_PER_PAGE))
        after = max(0, int(after))
        entries: list[dict] = []
        more = False
        with self._lock:
            if self.path.is_file():
                with open(self.path, "r", encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            continue
                        if int(entry.get("seq", 0)) <= after:
                            continue
                        if len(entries) >= limit:
                            more = True
                            break
                        entries.append(entry)
            return {
                "records": entries,
                "nextAfter": entries[-1]["seq"] if entries else after,
                "more": more,
                "latestSeq": self._seq,
                "activeRoundId": self._active_round_id,
                "lastPollAt": self._last_poll,
                "lastError": self._last_error,
            }

    def status(self) -> dict:
        with self._lock:
            return {
                "latestSeq": self._seq,
                "roundsSeen": len({key.split(":", 1)[0] for key in self._seen}),
                "activeRoundId": self._active_round_id,
                "lastPollAt": self._last_poll,
                "lastError": self._last_error,
            }

    def run_forever(self, stop: threading.Event, interval: float = RECORDER_POLL_SECONDS) -> None:
        while not stop.is_set():
            self.poll_once()
            stop.wait(interval)


def default_store_dir() -> Path:
    override = os.environ.get("LOOPER_COMPANION_DATA_DIR")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA")
    root = Path(base) if base else Path.home() / "AppData" / "Local"
    return root / "Looper" / "Companion" / "rounds"


def current_round_reader(folder: DataFolder) -> Callable[[], str | None]:
    def read() -> str | None:
        info, data = read_gspro_file(folder.directory(), "currentRound.dat")
        if info["status"] != "ok" or info.get("size", 0) > MAX_CURRENT_ROUND_BYTES:
            return None
        return data.decode("utf-8", errors="replace")

    return read
