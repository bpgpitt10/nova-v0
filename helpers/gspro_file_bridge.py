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
import math
import os
import re
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
# GSPro's own par per hole for each round (from the hole layout GSPro logs
# while a round is on), kept beside the shots.
PARS_FILE = "round-pars.jsonl"
MAX_LOG_TAIL_BYTES = 8 * 1024 * 1024
PARS_CHECK_SECONDS = 20.0
# A logged pin belongs to this round when GSPro's distance to the pin after
# each shot matches the distance from where the ball stopped to that pin.
PIN_MATCH_METERS = 3.0


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


def latest_hole_layout(log_text: str) -> list[dict] | None:
    """The last hole layout GSPro logged: one entry per hole, in hole order,
    with "par", "teePos" and "pinPos" (re-logged as the active hole changes)."""
    if not log_text:
        return None
    decoder = json.JSONDecoder()
    latest = None
    for match in re.finditer(r'\[\s*\{\s*"active"', log_text):
        try:
            value, _ = decoder.raw_decode(log_text[match.start():])
        except ValueError:
            continue
        if isinstance(value, list) and len(value) >= 9 and all(isinstance(row, dict) for row in value):
            latest = value
    return latest


def _xyz(value) -> tuple[float, float, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        point = (float(value["x"]), float(value.get("y", 0.0)), float(value["z"]))
    except (KeyError, TypeError, ValueError):
        return None
    return point if all(math.isfinite(v) for v in point) else None


def layout_pars_for_round(layout: list[dict], records: list[dict]) -> dict | None:
    """Par per hole from GSPro's logged layout, only when its pins are this
    round's: on every hole with a shot, GSPro's distance to the pin after the
    shot must match the distance from where the ball stopped to the logged pin
    (which also proves the layout's hole order). None if no hole can be checked
    or any hole disagrees."""
    pars: dict[str, int] = {}
    pins: dict[int, tuple[float, float, float]] = {}
    for index, row in enumerate(layout):
        par = row.get("par")
        if isinstance(par, int) and not isinstance(par, bool) and 2 <= par <= 7:
            pars[str(index + 1)] = par
        pin = _xyz(row.get("pinPos"))
        if pin:
            pins[index + 1] = pin
    if len(pars) < 9:
        return None
    votes: dict[int, list[bool]] = {}
    for record in records:
        try:
            hole = int(float(record.get("Hole"))) + 1
            to_pin = float(record.get("DistanceToPin"))
        except (TypeError, ValueError):
            continue
        end, pin = _xyz(record.get("EndingPOS")), pins.get(hole)
        if end is None or pin is None or not math.isfinite(to_pin):
            continue
        dx, dy, dz = end[0] - pin[0], end[1] - pin[1], end[2] - pin[2]
        off = min(abs(math.sqrt(dx * dx + dy * dy + dz * dz) - to_pin), abs(math.sqrt(dx * dx + dz * dz) - to_pin))
        votes.setdefault(hole, []).append(off <= PIN_MATCH_METERS)
    checked = {hole: sum(v) * 2 > len(v) for hole, v in votes.items()}
    if not checked or not all(checked.values()):
        return None
    return {"pars": pars, "checkedHoles": sorted(checked)}


class RoundRecorder:
    """Keeps every round GSPro writes to currentRound.dat.

    Append-only JSON lines in the companion's own data folder. A record is
    written again only when GSPro changes it, and consumers keep the latest
    version per (RoundID, ShotID).
    """

    def __init__(
        self,
        store_dir: Path,
        read_current_round: Callable[[], str | None],
        read_log_tail: Callable[[], str | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store_dir = Path(store_dir)
        self._read = read_current_round
        self._read_log = read_log_tail
        self._clock = clock
        self._lock = threading.Lock()
        self._seen: dict[str, str] = {}
        self._seq = 0
        self._active_round_id = None
        self._last_poll: str | None = None
        self._last_error: str | None = None
        self._pars: dict[str, dict] = {}
        self._last_pars_check = -1e9
        self._load()
        self._load_pars()

    @property
    def pars_path(self) -> Path:
        return self._store_dir / PARS_FILE

    def _load_pars(self) -> None:
        if not self.pars_path.is_file():
            return
        with open(self.pars_path, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and entry.get("roundId") is not None and isinstance(entry.get("pars"), dict):
                    self._pars[str(entry["roundId"])] = entry

    def _record_pars(self, records: list[dict]) -> None:
        """GSPro's par per hole for the round on now, checked against its pins."""
        if self._read_log is None or self._active_round_id is None:
            return
        now = self._clock()
        if now - self._last_pars_check < PARS_CHECK_SECONDS:
            return
        self._last_pars_check = now
        try:
            layout = latest_hole_layout(self._read_log() or "")
        except Exception:
            return
        if not layout:
            return
        round_id = self._active_round_id
        mine = [r for r in records if str(r.get("RoundID")) == str(round_id)]
        found = layout_pars_for_round(layout, mine)
        if not found:
            return
        course_key = next((str(r.get("CourseKey")) for r in mine if r.get("CourseKey")), None)
        previous = self._pars.get(str(round_id))
        if previous and previous.get("pars") == found["pars"] \
                and len(previous.get("checkedHoles") or []) >= len(found["checkedHoles"]):
            return
        entry = {"roundId": round_id, "courseKey": course_key, "observedAt": _utc_now(), **found}
        self._store_dir.mkdir(parents=True, exist_ok=True)
        with open(self.pars_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
        self._pars[str(round_id)] = entry

    def round_pars(self) -> list[dict]:
        """GSPro's par per hole for every round it was read for, newest first."""
        with self._lock:
            return sorted(self._pars.values(), key=lambda e: e.get("observedAt") or "", reverse=True)

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
            try:
                self._record_pars(records)
            except Exception:
                pass  # pars are a bonus; never stop recording shots
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


def log_tail_reader(folder: DataFolder) -> Callable[[], str | None]:
    """The end of GSPro's output_log.txt (read-only), where the hole layout is logged."""
    def read() -> str | None:
        info = stat_gspro_file(folder.directory(), "output_log.txt")
        if info["status"] != "ok":
            return None
        size = info["size"]
        info, data = read_gspro_file(folder.directory(), "output_log.txt", max(0, size - MAX_LOG_TAIL_BYTES), size)
        return data.decode("utf-8", errors="replace") if info["status"] == "ok" else None

    return read


def current_round_reader(folder: DataFolder) -> Callable[[], str | None]:
    def read() -> str | None:
        info, data = read_gspro_file(folder.directory(), "currentRound.dat")
        if info["status"] != "ok" or info.get("size", 0) > MAX_CURRENT_ROUND_BYTES:
            return None
        return data.decode("utf-8", errors="replace")

    return read
