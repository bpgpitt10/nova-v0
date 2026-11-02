"""Read-only evidence capture from GSPro's local files.

Nothing here writes into the GSPro folder. Files are read, hashed, sliced or
copied into the lab's own session folder.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Any

METERS_TO_YARDS = 1.0936132983377078
LOG_FILE = "output_log.txt"
ROUND_FILE = "currentRound.dat"
DB_FILE = "GSPro.db"
HASH_LIMIT_BYTES = 64 * 1024 * 1024
COPY_LIMIT_BYTES = 32 * 1024 * 1024
TEXT_SUFFIXES = {".txt", ".log", ".dat", ".json", ".csv", ".xml", ".ini", ".cfg"}


# --------------------------------------------------------------------------
# Locating GSPro

def default_gspro_dir() -> Path | None:
    """%USERPROFILE%\\AppData\\LocalLow\\GSPro\\GSPro, as the companion finds it."""
    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        local_low = Path(appdata).parent / "LocalLow"
        candidates += [local_low / "GSPro" / "GSPro", local_low / "GSPro"]
    home = Path.home()
    candidates += [home / "AppData" / "LocalLow" / "GSPro" / "GSPro", home / "AppData" / "LocalLow" / "GSPro"]
    for path in candidates:
        if (path / LOG_FILE).exists() or (path / ROUND_FILE).exists():
            return path
    return None


# --------------------------------------------------------------------------
# Folder snapshots (discovery)

def _sha256(path: Path) -> str | None:
    try:
        if path.stat().st_size > HASH_LIMIT_BYTES:
            return None
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest()
    except OSError:
        return None


def snapshot_folder(root: Path, max_depth: int = 4) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        if depth >= max_depth:
            dirnames[:] = []
        for name in filenames:
            path = Path(dirpath) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            out[path.relative_to(root).as_posix()] = {
                "size": stat.st_size,
                "mtimeNs": stat.st_mtime_ns,
                "sha256": _sha256(path),
            }
    return out


def diff_snapshots(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    changes = []
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if old is None:
            change = "new"
        elif new is None:
            change = "deleted"
        elif old["size"] != new["size"] or old["sha256"] != new["sha256"] or (
            old["sha256"] is None and old["mtimeNs"] != new["mtimeNs"]
        ):
            change = "modified"
        else:
            continue
        changes.append({
            "path": rel,
            "change": change,
            "sizeBefore": old["size"] if old else None,
            "sizeAfter": new["size"] if new else None,
        })
    return changes


def _copy_sqlite(path: Path) -> Path:
    """Copy a SQLite file (and its -wal/-shm) so reads never lock GSPro's copy."""
    temp_dir = Path(tempfile.mkdtemp(prefix="lielab-db-"))
    target = temp_dir / path.name
    shutil.copy2(path, target)
    for suffix in ("-wal", "-shm"):
        side = path.with_name(path.name + suffix)
        if side.exists():
            shutil.copy2(side, temp_dir / side.name)
    return target


def sqlite_table_state(path: Path) -> dict[str, dict[str, Any]]:
    """Row count and max rowid per table, from a private copy."""
    state: dict[str, dict[str, Any]] = {}
    copy = _copy_sqlite(path)
    try:
        with sqlite3.connect(f"file:{copy.as_posix()}?mode=ro", uri=True) as connection:
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                try:
                    count, max_rowid = connection.execute(
                        f"SELECT COUNT(*), MAX(rowid) FROM {quoted}").fetchone()
                except sqlite3.Error:
                    count, max_rowid = connection.execute(f"SELECT COUNT(*), NULL FROM {quoted}").fetchone()
                state[table] = {"rows": count, "maxRowid": max_rowid}
    finally:
        shutil.rmtree(copy.parent, ignore_errors=True)
    return state


def sqlite_rows_after(path: Path, table: str, after_rowid: int | None, limit: int = 200) -> list[dict[str, Any]]:
    copy = _copy_sqlite(path)
    try:
        with sqlite3.connect(f"file:{copy.as_posix()}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            quoted = '"' + table.replace('"', '""') + '"'
            rows = connection.execute(
                f"SELECT rowid AS _rowid, * FROM {quoted} WHERE rowid > ? ORDER BY rowid LIMIT ?",
                (after_rowid or 0, limit),
            ).fetchall()
            return [{key: row[key] for key in row.keys()} for row in rows]
    finally:
        shutil.rmtree(copy.parent, ignore_errors=True)


def read_from(path: Path, offset: int, limit: int = 4 * 1024 * 1024) -> str:
    with path.open("rb") as handle:
        handle.seek(offset)
        return handle.read(limit).decode("utf-8", errors="replace")


# --------------------------------------------------------------------------
# output_log.txt parsing (mirrors src/adapters/gsproPenaltyLog.ts)

LAUNCH_RE = re.compile(
    r"LaunchExt Vars:\s*sp\s*(-?[\d.]+),\s*el\s*(-?[\d.]+),\s*az\s*(-?[\d.]+),\s*ts\s*(-?[\d.]+),"
    r"\s*sa\s*(-?[\d.]+)(?:,\s*cy\s*(-?[\d.]+))?(?:,\s*id\s*(\d+))?", re.I)
PENALTY_RE = re.compile(
    r"Penalty Surface\s+([A-Za-z_]+)\s*,\s*Spin\s*(\d+(?:\.\d+)?)%\s*,\s*Speed\s*(\d+(?:\.\d+)?)%"
    r"\s*,\s*VLA\s*(\d+(?:\.\d+)?)%", re.I)
TYPE_RE = re.compile(r"corrected type\s+(-?\d+)", re.I)
# Lines worth keeping verbatim even when we don't understand them yet.
INTEREST_RE = re.compile(r"surface|penalty|lie|slope|launch|material|bunker|rough|fringe|club|encore|practice", re.I)


def parse_log_slice(text: str) -> dict[str, Any]:
    launches, penalties, types, interesting = [], [], [], []
    for line in text.splitlines():
        if (m := LAUNCH_RE.search(line)):
            launches.append({
                "ballSpeedMph": float(m[1]), "vlaDeg": float(m[2]), "hlaDeg": float(m[3]),
                "spinRpm": float(m[4]), "spinAxisDeg": float(m[5]),
                "carryHint": float(m[6]) if m[6] else None, "launchId": int(m[7]) if m[7] else None,
            })
        elif (m := PENALTY_RE.search(line)):
            penalties.append({
                "surfaceName": m[1], "spin": float(m[2]) / 100, "speed": float(m[3]) / 100,
                "vla": float(m[4]) / 100,
            })
        elif (m := TYPE_RE.search(line)):
            types.append(int(m[1]))
        if INTEREST_RE.search(line) and len(interesting) < 60:
            interesting.append(line.strip()[:300])
    return {"launches": launches, "penalties": penalties, "typeCodes": types, "interestingLines": interesting}


# --------------------------------------------------------------------------
# currentRound.dat parsing (mirrors src/adapters/browserGsproCourseArchive.ts)

def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _vec(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    x, y, z = _num(value.get("x")), _num(value.get("y")), _num(value.get("z"))
    return None if None in (x, y, z) else {"x": x, "y": y, "z": z}


def round_records(text: str) -> list[dict[str, Any]]:
    parsed = json.loads(text)
    if isinstance(parsed, list):
        items = parsed
    elif isinstance(parsed, dict):
        items = [item for value in parsed.values() if isinstance(value, list) for item in value]
    else:
        items = []
    return [item for item in items if isinstance(item, dict)]


def summarize_record(record: dict[str, Any]) -> dict[str, Any]:
    ghost = record.get("GhostData") if isinstance(record.get("GhostData"), dict) else {}
    at_shot = ghost.get("atShotData") if isinstance(ghost.get("atShotData"), dict) else {}
    active = record.get("activeShot") if isinstance(record.get("activeShot"), dict) else {}
    sd = active.get("sd") if isinstance(active.get("sd"), dict) else {}
    start = _vec(record.get("StartingPOS"))
    end = _vec(record.get("EndingPOS"))
    touchdown = _vec(at_shot.get("tdpoint")) or _vec(sd.get("tdpoint"))

    def flat(a: dict[str, float] | None, b: dict[str, float] | None) -> float | None:
        if a is None or b is None:
            return None
        return math.hypot(b["x"] - a["x"], b["z"] - a["z"]) * METERS_TO_YARDS

    total_m = _num(record.get("TotalDistance"))
    return {
        "roundId": _num(record.get("RoundID")),
        "shotId": record.get("ShotID"),
        "globalShotNumber": _num(record.get("GlobalShotNumber")),
        "hole": _num(record.get("Hole")),
        "holeShot": _num(record.get("HoleShot")),
        "courseKey": record.get("CourseKey"),
        "startingSurface": _num(record.get("StartingSurface")),
        "endingSurface": _num(record.get("EndingSurface")),
        "touchdownMaterial": _num(sd.get("TDmaterial")),
        "clubIndex": _num(record.get("ClubIndex")),
        "start": start,
        "end": end,
        "touchdown": touchdown,
        "carryYds": flat(start, touchdown),
        "restYds": flat(start, end),
        "totalYds": total_m * METERS_TO_YARDS if total_m is not None else None,
        "touchdownSpinRpm": _num(sd.get("finalSpin")),
        "touchdownSpeed": _num(sd.get("finalSpeed")),
        "gsproLaunch": {key: _num(ghost.get(key)) for key in ("lmfSP", "lmfEL", "lmfAZ", "lmfTS", "lmfBS", "lmfSS", "lmfSA")},
    }


def latest_record(text: str) -> dict[str, Any] | None:
    records = round_records(text)
    if not records:
        return None

    def order(record: dict[str, Any]) -> tuple[float, float]:
        return (_num(record.get("GlobalShotNumber")) or -1.0, _num(record.get("ShotID")) or -1.0)

    return max(records, key=order)


# --------------------------------------------------------------------------
# Per-shot watcher (run mode)

class ShotWatcher:
    """Tracks GSPro files between shots and saves what changed per shot."""

    def __init__(self, gspro_dir: Path, evidence_dir: Path, db_table: str | None = None) -> None:
        self.gspro_dir = gspro_dir
        self.evidence_dir = evidence_dir
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        self.db_table = db_table
        self.log_path = gspro_dir / LOG_FILE
        self.round_path = gspro_dir / ROUND_FILE
        self.db_path = gspro_dir / DB_FILE
        self.log_offset = self._size(self.log_path)
        self.round_hash = _sha256(self.round_path) if self.round_path.exists() else None
        self.db_rowid: int | None = None
        if db_table and self.db_path.exists():
            state = sqlite_table_state(self.db_path).get(db_table)
            self.db_rowid = state["maxRowid"] if state else None
        self._mark: dict[str, Any] = {}

    @staticmethod
    def _size(path: Path) -> int:
        try:
            return path.stat().st_size
        except OSError:
            return 0

    def _stat(self, path: Path) -> tuple[int, int] | None:
        try:
            stat = path.stat()
            return stat.st_size, stat.st_mtime_ns
        except OSError:
            return None

    def mark(self) -> None:
        """Call just before firing a shot."""
        self._mark = {
            "at": time.monotonic(),
            "log": self._stat(self.log_path),
            "round": self._stat(self.round_path),
            "db": self._stat(self.db_path),
            "lastChange": time.monotonic(),
            "lastStats": None,
        }

    def done(self, quiet_s: float = 2.0, fallback_s: float = 14.0) -> bool:
        """Heuristic 'ball has stopped' when GSPro sends no 202."""
        stats = (self._stat(self.log_path), self._stat(self.round_path), self._stat(self.db_path))
        now = time.monotonic()
        if stats != self._mark.get("lastStats"):
            self._mark["lastStats"] = stats
            self._mark["lastChange"] = now
        quiet = now - self._mark["lastChange"] >= quiet_s
        result_written = stats[1] != self._mark.get("round") or stats[2] != self._mark.get("db")
        if result_written and quiet:
            return True
        return now - self._mark["at"] >= fallback_s and quiet

    def collect(self, tag: str) -> dict[str, Any]:
        """Save everything that changed since the last collect()."""
        out: dict[str, Any] = {"tag": tag}
        # Log: appended slice. GSPro rewrites the log on restart: handle shrink.
        size = self._size(self.log_path)
        if size < self.log_offset:
            self.log_offset = 0
        text = read_from(self.log_path, self.log_offset) if size > self.log_offset else ""
        self.log_offset = size
        if text:
            (self.evidence_dir / f"{tag}.log.txt").write_text(text, encoding="utf-8")
        out["log"] = parse_log_slice(text)
        out["logBytes"] = len(text)
        # currentRound.dat: copy when it changed.
        out["round"] = None
        out["roundChanged"] = False
        if self.round_path.exists():
            digest = _sha256(self.round_path)
            if digest != self.round_hash:
                self.round_hash = digest
                out["roundChanged"] = True
                raw = self.round_path.read_bytes()
                if len(raw) <= COPY_LIMIT_BYTES:
                    with gzip.open(self.evidence_dir / f"{tag}.currentRound.dat.gz", "wb") as handle:
                        handle.write(raw)
                try:
                    record = latest_record(raw.decode("utf-8", errors="replace"))
                    out["round"] = summarize_record(record) if record else None
                except (ValueError, TypeError) as exc:
                    out["roundParseError"] = str(exc)
        # Optional DB table discovered during `discover`.
        out["dbRows"] = []
        if self.db_table and self.db_path.exists():
            try:
                rows = sqlite_rows_after(self.db_path, self.db_table, self.db_rowid)
                if rows:
                    self.db_rowid = rows[-1]["_rowid"]
                out["dbRows"] = rows
            except (sqlite3.Error, OSError) as exc:
                out["dbError"] = str(exc)
        return out
