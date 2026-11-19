#!/usr/bin/env python3
"""Looper roll replay: hit each club's stock shot on the GSPro range and record how far it rolls.

GSPro 4.1.9 changed bounce and roll, and added Course Type and Fairway Firmness.
Roll depends only on how the ball leaves the face (speed, launch, spin), and
Looper already knows that for every club in the bag. This fires each club's
stock shot into the Practice Range, with no swing, and records carry, total and
roll as GSPro plays them now.

Double-click it (open with Python), or run `python roll_replay.py`. It asks
what you want to test and what GSPro is set to, then hits the shots. Nothing to
remember: press Enter to take the suggested answer. Four tests:

  Fairway roll       whole bag on the Practice Range
  Designed shots     25 shots on the Practice Range that vary speed, launch and
                     spin independently, so a model can tell which one causes
                     the roll (a bag's stock shots can't: they move together)
  Landing on a green irons and wedges in On Course practice (carry, then how far
                     the ball released or spun back, and how flat the green was)
  Putt roll          putts at set speeds on a green: how far each rolls on this
                     course type, green firmness and stimp, flat, uphill or down
  Shots from a lie   On Course practice: drop the ball anywhere (rough, sand,
                     fringe, a slope), press Enter, and it hits three shots, one
                     soft, one medium, one hard. Move the ball and repeat. Records
                     what GSPro took off each shot for the lie, and the carry

Everything from one sitting goes into one file, looper_lab_<time>.csv.

Put this file in the same folder as test_shots.py and open_connect.py.

The rest of this note is for running one fairway setting from the command line:

  python roll_replay.py --type firm --fairway firm
  python roll_replay.py --type medium --fairway medium --clubs Driver,7i,PW --repeats 5

Before you run it:
  1. CLOSE THE UNEEKOR LAUNCHER (this tool takes its place).
  2. Open GSPro's Practice Range (Driving Range, hitting to the fairway).
  3. Do NOT have a Looper practice session running. With no session open,
     these shots stay out of your bag. (They are not swings.)
  4. Set Course Type and Fairway Firmness in the range setup, and tell this
     tool what you set with --type and --fairway. It cannot read or change
     them; it only writes them on each row.

What it does, per shot:
  1. sends the club's stock ball data, dead straight,
  2. waits for GSPro's "ball at rest" (GSPro takes one shot at a time),
  3. reads GSPro's own record of the shot from GSPro.db (read only) and writes
     one row to roll_replay_<time>.csv next to this file.

Run it once for each setting you want to compare. The stock range setup is
Medium (Bermuda) with Medium fairways. All nine: --type soft|medium|firm with
--fairway soft|medium|firm.

Options:
  --type medium       Course Type set in GSPro: soft, medium or firm (default medium)
  --fairway medium    Fairway Firmness set in GSPro: soft, medium or firm (default medium)
  --clubs all         clubs to hit, comma separated (default: the whole bag)
  --repeats 3         times each club is hit (default 3)
  --bag my_bag.json   another player's stock shots:
                      {"7i": {"speed": 113.1, "vla": 16.4, "spin": 6175, "carry": 157.6, "total": 166.0}, ...}
  --gap 1.5           seconds to wait after the ball stops before the next shot

At the end it prints each club's roll next to the roll in the stored bag. Send
the csv files to Claude.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from test_shots import BAG, OPEN_CONNECT_PORT, UNEEKOR_HOST, UNEEKOR_PORT, OpenConnectPath, pause_before_close  # noqa: E402

SETTINGS = ("soft", "medium", "firm")
FIELDS = [
    "course_type", "fairway_firmness", "club", "n", "status",
    "carry_yd", "total_yd", "roll_yd", "offline_yd", "peak_height", "descent_deg",
    "sent_speed_mph", "sent_vla_deg", "sent_spin_rpm", "gspro_speed_mph", "gspro_vla_deg", "gspro_spin_rpm",
    "stored_carry_yd", "stored_roll_yd", "row_id", "sent_at",
]


def gspro_db() -> Path:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    return home / "AppData" / "LocalLow" / "GSPro" / "GSPro" / "GSPro.db"


def latest_row(db_path: Path) -> tuple[int, dict[str, Any]] | None:
    """The newest Practice Range shot in GSPro.db (opened read only), or None."""
    uri = f"file:{db_path.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=1.0)
    try:
        row = connection.execute("SELECT ID, ShotData FROM DrivingRangeShot ORDER BY ID DESC LIMIT 1").fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    try:
        data = json.loads(row[1]) if isinstance(row[1], (str, bytes)) else row[1]
    except ValueError:
        data = {}
    return int(row[0]), data if isinstance(data, dict) else {}


def latest_row_safely(db_path: Path) -> tuple[int, dict[str, Any]] | None:
    """GSPro can hold the file for a moment while it writes: treat that as "nothing new yet"."""
    try:
        return latest_row(db_path)
    except sqlite3.Error:
        return None


def wait_for_new_row(db_path: Path, previous_id: int | None, timeout_s: float, sleep=time.sleep) -> tuple[int, dict[str, Any]] | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        row = latest_row_safely(db_path)
        if row is not None and (previous_id is None or row[0] > previous_id):
            return row
        sleep(0.25)
    return None


def _num(*values: Any) -> float | None:
    for value in values:
        try:
            if value is not None and value != "":
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def measure(data: dict[str, Any] | None) -> dict[str, Any]:
    """Carry, total and roll from GSPro's record of one range shot."""
    if not data:
        return {}
    carry = _num(data.get("Carry"), data.get("rawCarryGame"), data.get("rawCarryLM"))
    total = _num(data.get("TotalDistance"))
    spin = _num(data.get("TotalSpin"))
    if spin is None:
        back, side = _num(data.get("BackSpin")), _num(data.get("SideSpin"))
        spin = (back ** 2 + (side or 0.0) ** 2) ** 0.5 if back is not None else None
    return {
        "carry_yd": carry,
        "total_yd": total,
        "roll_yd": round(total - carry, 2) if carry is not None and total is not None else None,
        "offline_yd": _num(data.get("Offline")),
        "peak_height": _num(data.get("PeakHeight")),
        "descent_deg": _num(data.get("Decent"), data.get("Descent")),
        "gspro_speed_mph": _num(data.get("BallSpeed")),
        "gspro_vla_deg": _num(data.get("VLA")),
        "gspro_spin_rpm": round(spin) if spin is not None else None,
    }


def plan(clubs: list[str], repeats: int) -> list[str]:
    """Clubs in rounds (Driver, 7i, PW, Driver, ...) so a drift over time is not mistaken for a club effect."""
    return [club for _ in range(repeats) for club in clubs]


def pick_clubs(spec: str, bag: dict[str, dict[str, float]]) -> list[str]:
    if spec.strip().lower() in ("", "all"):
        return list(bag)
    by_name = {name.lower(): name for name in bag}
    wanted = [part.strip() for part in spec.split(",") if part.strip()]
    missing = [name for name in wanted if name.lower() not in by_name]
    if missing:
        raise ValueError(f"Not in the bag: {', '.join(missing)}. Clubs: {', '.join(bag)}")
    return [by_name[name.lower()] for name in wanted]


def summarize(rows: list[dict[str, Any]], bag: dict[str, dict[str, float]]) -> list[str]:
    lines = []
    for club in bag:
        hits = [row for row in rows if row["club"] == club and row.get("roll_yd") is not None]
        if not hits:
            continue
        mean = lambda key: sum(row[key] for row in hits) / len(hits)  # noqa: E731
        stored = bag[club]
        stored_roll = stored["total"] - stored["carry"] if "total" in stored and "carry" in stored else None
        was = f"  (stored bag: {stored_roll:4.1f})" if stored_roll is not None else ""
        lines.append(f"  {club:<6} carry {mean('carry_yd'):6.1f}  total {mean('total_yd'):6.1f}  roll {mean('roll_yd'):5.1f} yd"
                     f"{was}  [{len(hits)} shots]")
    return lines


def run(args: argparse.Namespace, read_line=input, db_path: Path | None = None, path: Any = None, sleep=time.sleep) -> int:
    if args.type not in SETTINGS or args.fairway not in SETTINGS:
        print("--type and --fairway must each be soft, medium or firm.")
        return 2
    bag: dict[str, dict[str, float]] = BAG
    if args.bag:
        try:
            bag = json.loads(Path(args.bag).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"Could not read {args.bag}: {exc}")
            return 2
    try:
        clubs = pick_clubs(args.clubs, bag)
    except ValueError as exc:
        print(exc)
        return 2
    db_path = db_path or gspro_db()
    if latest_row_safely(db_path) is None and not db_path.exists():
        print(f"GSPro's database was not found at {db_path}. Is GSPro installed on this PC?")
        pause_before_close(read_line)
        return 3

    shots = plan(clubs, args.repeats)
    out = HERE / f"roll_replay_{args.type}_{args.fairway}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    print(f"{len(shots)} shots: {args.repeats} each of {', '.join(clubs)}.")
    print(f"Recording as Course Type {args.type}, Fairway Firmness {args.fairway}. Check GSPro's range setup matches.")
    print("No Looper practice session should be running, so these stay out of your bag.")
    print(f"Results go to {out.name}\n")
    try:
        if read_line("Practice Range open and ready? Enter to start, q to stop. ").strip().lower() in ("q", "quit", "exit"):
            return 0
    except EOFError:
        return 0

    if path is None:
        ports = [args.port] if args.port else [UNEEKOR_PORT, OPEN_CONNECT_PORT]
        path = OpenConnectPath(args.host, ports, args.api_version, args.timeout)
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3

    rows: list[dict[str, Any]] = []
    try:
        with out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
            writer.writeheader()
            for index, club in enumerate(shots, start=1):
                stock = bag[club]
                before = latest_row_safely(db_path)
                shot = {"speed": stock["speed"], "vla": stock["vla"], "hla": 0.0, "spin": stock["spin"], "axis": 0.0}
                sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
                try:
                    # Blocks until GSPro says the ball is at rest: GSPro takes one shot at a time.
                    status = path.fire(shot)
                except (ConnectionError, OSError) as exc:
                    print(f"  could not send: {exc}")
                    break
                # GSPro writes the range record a moment after the ball stops.
                row_found = wait_for_new_row(db_path, before[0] if before else None, args.record_wait, sleep=sleep)
                stored_roll = round(stock["total"] - stock["carry"], 1) if "total" in stock and "carry" in stock else None
                row = {"course_type": args.type, "fairway_firmness": args.fairway, "club": club, "n": index, "status": status,
                       "sent_speed_mph": stock["speed"], "sent_vla_deg": stock["vla"], "sent_spin_rpm": stock["spin"],
                       "stored_carry_yd": stock.get("carry"), "stored_roll_yd": stored_roll,
                       "row_id": row_found[0] if row_found else None, "sent_at": sent_at,
                       **measure(row_found[1] if row_found else None)}
                writer.writerow(row)
                handle.flush()
                rows.append(row)
                if row.get("roll_yd") is not None:
                    print(f"  {index:>3}/{len(shots)}  {club:<6} carry {row['carry_yd']:6.1f}  total {row['total_yd']:6.1f}  roll {row['roll_yd']:5.1f} yd")
                else:
                    print(f"  {index:>3}/{len(shots)}  {club:<6} not recorded by GSPro   [{status}]")
                sleep(args.gap)
    except KeyboardInterrupt:
        print()
    finally:
        path.close()

    print(f"\n{len(rows)} shots recorded in {out}")
    for line in summarize(rows, bag):
        print(line)
    if rows and all(row.get("roll_yd") is None for row in rows):
        print("GSPro did not record any of these. They only count on the Practice Range (Driving Range). Tell Claude which screen you were on.")
    pause_before_close(read_line)
    return 0


# -- The guided session: double-click and answer questions -----------------------

M_TO_YD = 1.0936132983
M_TO_IN = 39.37007874
GREEN_SURFACE = 5
#: When GSPro sends no ball-at-rest, wait this long for the shot to fly and roll out.
NO_STOP_SIGNAL_WAIT_S = 15.0
#: Clubs offered from a spot: stock carry from this far short of the pin to this far past it.
GREEN_WINDOW_YD = (-14.0, 8.0)
LAB_FIELDS = [
    "test", "course_type", "fairway_firmness", "green_firmness", "stimp", "elevation_ft", "pin_distance_yd", "club", "n", "status",
    "carry_yd", "total_yd", "roll_yd", "sideways_yd", "roll_height_change_in", "finish_surface", "holed",
    "offline_yd", "peak_height", "descent_deg",
    "slope", "putt_roll_ft", "putt_height_change_in", "putt_to_cup_ft", "sent_hla_deg",
    "sent_speed_mph", "sent_vla_deg", "sent_spin_rpm", "gspro_speed_mph", "gspro_vla_deg", "gspro_spin_rpm",
    "stored_carry_yd", "stored_roll_yd", "row_id", "sent_at",
    "spot", "note", "lie_surface", "lie_speed_pct", "lie_spin_pct", "lie_vla_pct", "lie_type",
    "start_surface", "start_x", "start_y", "start_z", "moved_from_spot_yd", "log_speed_mph", "log_vla_deg", "log_spin_rpm",
    "landing_surface", "landing_material", "landing_spin_rpm", "log_course_type", "log_fairway_firmness", "log_green_firmness",
    "db_carry_yd", "db_total_yd", "db_raw_carry_game_yd", "db_raw_carry_lm_yd", "db_pin_yd",
]
M_TO_FT = 3.280839895
#: Putt speeds rolled by default, mph off the face.
PUTT_SPEEDS_MPH = (2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0)


def measure_putt(record: dict[str, Any] | None) -> dict[str, Any]:
    """How far a putt rolled and how much it climbed or dropped, from GSPro's record of it."""
    if not record:
        return {}
    start, end = _xyz(record.get("StartingPOS")), _xyz(record.get("EndingPOS"))
    shot_data = ((record.get("activeShot") or {}).get("sd")) or ((record.get("GhostData") or {}).get("atShotData")) or {}
    cup = _xyz(shot_data.get("tdpoint"))
    row: dict[str, Any] = {"row_id": record.get("ShotID"), "holed": bool(shot_data.get("isHoled")),
                           "finish_surface": record.get("EndingSurface"), "gspro_speed_mph": _num(record.get("BallSpeed"))}
    if start and end:
        row["putt_roll_ft"] = round(((end[0] - start[0]) ** 2 + (end[2] - start[2]) ** 2) ** 0.5 * M_TO_FT, 2)
        row["putt_height_change_in"] = round((end[1] - start[1]) * M_TO_IN, 1)
    if start and cup:
        row["putt_to_cup_ft"] = round(((cup[0] - start[0]) ** 2 + (cup[2] - start[2]) ** 2) ** 0.5 * M_TO_FT, 2)
    return row


def putt_shots(speeds: tuple[float, ...] | list[float], hla: float) -> dict[str, dict[str, float]]:
    return {f"{speed:g} mph": {"speed": speed, "vla": 0.0, "spin": 0.0, "hla": hla} for speed in speeds}


def gspro_round_file() -> Path:
    return gspro_db().parent / "currentRound.dat"


def _xyz(value: Any) -> tuple[float, float, float] | None:
    try:
        return float(value["x"]), float(value["y"]), float(value["z"])
    except (KeyError, TypeError, ValueError):
        return None


def newest_round_record(round_file: Path) -> dict[str, Any] | None:
    """The latest shot in GSPro's currentRound.dat (On Course practice and rounds), or None."""
    try:
        parsed = json.loads(round_file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    candidates: list[Any] = parsed if isinstance(parsed, list) else [
        item for value in (parsed.values() if isinstance(parsed, dict) else []) if isinstance(value, list) for item in value]
    shots = [c for c in candidates if isinstance(c, dict) and c.get("ShotID") and isinstance(c.get("GlobalShotNumber"), (int, float))]
    # Practice re-hits are added with the same shot number: the newest is the last one written.
    return max(enumerate(shots), key=lambda pair: (pair[1]["GlobalShotNumber"], pair[0]))[1] if shots else None


def measure_landing(record: dict[str, Any] | None) -> dict[str, Any]:
    """Carry, and what the ball did after it landed, from GSPro's record of one on-course shot.

    Roll is measured along the line of the shot: negative means it spun back.
    """
    if not record:
        return {}
    shot_data = ((record.get("GhostData") or {}).get("atShotData")) or ((record.get("activeShot") or {}).get("sd")) or {}
    start = _xyz(record.get("StartingPOS")) or _xyz(shot_data.get("BallStartPos"))
    end = _xyz(record.get("EndingPOS"))
    if not end and isinstance(shot_data.get("path"), list) and shot_data["path"]:
        end = _xyz((shot_data["path"][-1] or {}).get("pos"))  # practice records: the last point of the roll
    landed = _xyz(shot_data.get("tdpoint"))
    row: dict[str, Any] = {
        "row_id": record.get("ShotID"),
        "finish_surface": record.get("EndingSurface"),
        "holed": bool(shot_data.get("isHoled")),
        "gspro_speed_mph": _num((record.get("GhostData") or {}).get("lmfSP"), record.get("BallSpeed")),
        "landing_surface": shot_data.get("TDmaterial"),
        "descent_deg": _num(shot_data.get("descentAngle")),
        "landing_spin_rpm": _num(shot_data.get("finalSpin")),
    }
    if start and landed and end:
        dx, dz = landed[0] - start[0], landed[2] - start[2]
        carry_m = (dx * dx + dz * dz) ** 0.5
        if carry_m > 0.5:
            ux, uz = dx / carry_m, dz / carry_m
            rx, rz = end[0] - landed[0], end[2] - landed[2]
            along, across = rx * ux + rz * uz, rx * uz - rz * ux
            row.update({
                "carry_yd": round(carry_m * M_TO_YD, 2),
                "roll_yd": round(along * M_TO_YD, 2),
                "total_yd": round((carry_m + along) * M_TO_YD, 2),
                "sideways_yd": round(across * M_TO_YD, 2),
                "roll_height_change_in": round((end[1] - landed[1]) * M_TO_IN, 1),
            })
    return row


def record_fingerprint(record: dict[str, Any] | None) -> str | None:
    """What makes one recorded shot different from the last.

    Not just the ShotID: in practice modes GSPro can rewrite the same record for
    every shot (18 Nov: only the first putt of a set was seen as new).
    """
    if not record:
        return None
    shot_data = ((record.get("GhostData") or {}).get("atShotData")) or ((record.get("activeShot") or {}).get("sd")) or {}
    return json.dumps([record.get("ShotID"), record.get("GlobalShotNumber"), record.get("StartingPOS"),
                       record.get("EndingPOS"), record.get("BallSpeed"), record.get("TotalDistance"),
                       shot_data.get("tdpoint"), shot_data.get("finalSpin")], sort_keys=True, default=str)


def wait_for_new_record(round_file: Path, previous: str | None, timeout_s: float, sleep=time.sleep) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        latest = newest_round_record(round_file)
        if latest and record_fingerprint(latest) != previous:
            return latest
        sleep(0.25)
    return None


# --------------------------------------------------------------------------
# Shots from a lie: what GSPro takes off a shot for where the ball sits.

#: Three shots per spot, one from each row, moving along the row with each new spot.
#: Fifteen different shots, so every lie is hit soft, medium and hard, and over
#: a session each lie sees wedges, irons and long clubs.
LIE_SHOTS: tuple[tuple[tuple[str, float, float, float], ...], ...] = (
    (("soft 50", 50.0, 28.0, 7500.0), ("soft 60", 60.0, 24.0, 9000.0), ("soft 70", 70.0, 30.0, 6200.0),
     ("SW", 78.6, 26.6, 9856.0), ("soft 40", 40.0, 30.0, 5000.0)),
    (("PW", 94.4, 22.4, 8646.0), ("mid 95 low spin", 95.0, 14.0, 4200.0), ("mid 105", 105.0, 19.0, 7000.0),
     ("7i", 113.1, 16.4, 6175.0), ("mid 100 high", 100.0, 24.0, 9000.0)),
    (("5i", 123.5, 12.0, 5280.0), ("3H", 134.2, 8.7, 4701.0), ("Driver", 143.8, 11.1, 2812.0),
     ("hard 120", 120.0, 19.0, 6200.0), ("hard 145", 145.0, 14.0, 3200.0)),
)

LOG_LAUNCH_RE = re.compile(r"LaunchExt Vars:\s*sp\s*(-?[\d.]+),\s*el\s*(-?[\d.]+),\s*az\s*(-?[\d.]+),\s*ts\s*(-?[\d.]+)", re.I)
LOG_PENALTY_RE = re.compile(
    r"Penalty Surface\s+([A-Za-z_]+)\s*,\s*Spin\s*(\d+(?:\.\d+)?)%\s*,\s*Speed\s*(\d+(?:\.\d+)?)%\s*,\s*VLA\s*(\d+(?:\.\d+)?)%", re.I)
LOG_TYPE_RE = re.compile(r"corrected type\s+(-?\d+)", re.I)
LOG_PHYSICS_RE = re.compile(r"Physics Settings:\s*Green Firmness\s*(-?\d+)\s*Fairway Firmness\s*(-?\d+)\s*Course Type\s*(-?\d+)", re.I)
LOG_MATERIAL_RE = re.compile(r"\|\s*material\s+([A-Za-z_]+)", re.I)
LOG_KEEP_RE = re.compile(r"surface|penalty|lie|slope|launch|material|bunker|rough|fringe|sand|drop|physics|friction|shot fired", re.I)


def gspro_log() -> Path:
    """GSPro's log: Player.log on GSPro 4, output_log.txt before it. Whichever was written last."""
    folder = gspro_db().parent
    found = [p for p in (folder / "Player.log", folder / "output_log.txt") if p.exists()]
    return max(found, key=lambda p: p.stat().st_mtime) if found else folder / "Player.log"


def log_size(log_file: Path) -> int:
    try:
        return log_file.stat().st_size
    except OSError:
        return 0


def read_log_since(log_file: Path, offset: int) -> str:
    """What GSPro wrote to its log after `offset` (read only). The whole file if GSPro restarted it."""
    try:
        with log_file.open("rb") as handle:
            handle.seek(offset if offset <= log_file.stat().st_size else 0)
            return handle.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
    except OSError:
        return ""


def lie_from_log(text: str) -> dict[str, Any]:
    """GSPro's own lie penalty for the shot just hit: the last penalty line in `text`, if there is one."""
    row: dict[str, Any] = {}
    for line in text.splitlines():
        if (m := LOG_PENALTY_RE.search(line)):
            row.update({"lie_surface": m[1], "lie_spin_pct": float(m[2]), "lie_speed_pct": float(m[3]), "lie_vla_pct": float(m[4])})
        elif (m := LOG_TYPE_RE.search(line)):
            row["lie_type"] = int(m[1])
        elif (m := LOG_LAUNCH_RE.search(line)):
            row.update({"log_speed_mph": float(m[1]), "log_vla_deg": float(m[2]), "log_spin_rpm": float(m[4])})
        elif (m := LOG_PHYSICS_RE.search(line)):
            row.update({"log_green_firmness": int(m[1]), "log_fairway_firmness": int(m[2]), "log_course_type": int(m[3])})
        elif "landing_material" not in row and (m := LOG_MATERIAL_RE.search(line)):
            row["landing_material"] = m[1]  # the first thing the ball hit
    return row


def lie_shots_for_spot(spot: int) -> list[tuple[str, dict[str, float]]]:
    """The soft, medium and hard shot for spot number `spot` (1, 2, 3...)."""
    return [(name, {"speed": speed, "vla": vla, "hla": 0.0, "spin": spin, "axis": 0.0})
            for name, speed, vla, spin in (row[(spot - 1) % len(row)] for row in LIE_SHOTS)]


def lie_summary(rows: list[dict[str, Any]]) -> list[str]:
    """Per lie GSPro named: how many shots, and the range of speed and spin it left on the ball."""
    by: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by.setdefault(str(row.get("lie_surface") or f"no penalty line (surface {row.get('start_surface', '?')})"), []).append(row)
    lines = []
    for name, group in sorted(by.items()):
        speeds = [r["lie_speed_pct"] for r in group if r.get("lie_speed_pct") is not None]
        spins = [r["lie_spin_pct"] for r in group if r.get("lie_spin_pct") is not None]
        spots = len({r.get("spot") for r in group})
        detail = f": speed kept {min(speeds):.0f} to {max(speeds):.0f}%, spin kept {min(spins):.0f} to {max(spins):.0f}%" if speeds and spins else ""
        lines.append(f"  {name:<34} {len(group):>3} shots from {spots} spots{detail}")
    return lines


def lie_session(path: Any, read_line, writer: Any, flush, *, labels: dict[str, Any], round_file: Path, log_file: Path, db_path: Path,
                notes_file: Path, gap: float, record_wait: float, first_spot: int = 1, sleep=time.sleep) -> list[dict[str, Any]]:
    """Spot after spot: the player drops the ball and presses Enter, three shots are hit and recorded."""
    rows: list[dict[str, Any]] = []
    spot = first_spot
    while True:
        try:
            typed = read_line(f"\nSpot {spot}: drop the ball, then Enter to hit 3 shots. (Type a note first if you like, e.g. sand uphill. q to finish.) ").strip()
        except EOFError:
            break
        if typed.lower() in ("q", "quit"):
            break
        origin: tuple[float, float, float] | None = None
        for index, (name, shot) in enumerate(lie_shots_for_spot(spot), start=1):
            before_record = record_fingerprint(newest_round_record(round_file))
            before_log = log_size(log_file)
            before_row = latest_row_safely(db_path)
            sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            try:
                status = path.fire(shot)
            except (ConnectionError, OSError) as exc:
                print(f"  could not send: {exc}")
                return rows
            if "at rest" not in status:
                print(f"  (no ball-at-rest from GSPro; waiting {NO_STOP_SIGNAL_WAIT_S:g} s for the shot to finish)")
                sleep(NO_STOP_SIGNAL_WAIT_S)
            record = wait_for_new_record(round_file, before_record, record_wait, sleep=sleep)
            log_text = read_log_since(log_file, before_log)
            lie = lie_from_log(log_text)
            found = wait_for_new_row(db_path, before_row[0] if before_row else None, 3.0, sleep=sleep)
            data = found[1] if found else {}
            table = {"db_carry_yd": _num(data.get("Carry")), "db_total_yd": _num(data.get("TotalDistance")),
                     "db_raw_carry_game_yd": _num(data.get("rawCarryGame")), "db_raw_carry_lm_yd": _num(data.get("rawCarryLM")),
                     "db_pin_yd": _num(data.get("DistanceToPin"))} if found else {}
            start = _xyz((record or {}).get("StartingPOS"))
            origin = origin or start
            moved = round((((start[0] - origin[0]) ** 2 + (start[2] - origin[2]) ** 2) ** 0.5) * M_TO_YD, 1) if start and origin else None
            row = {"test": "lie", **labels, "spot": spot, "note": typed, "club": name, "n": index, "status": status,
                   "sent_speed_mph": shot["speed"], "sent_vla_deg": shot["vla"], "sent_spin_rpm": shot["spin"], "sent_at": sent_at,
                   **measure_landing(record), **lie, **table,
                   "start_surface": (record or {}).get("StartingSurface"), "moved_from_spot_yd": moved,
                   **({"start_x": round(start[0], 2), "start_y": round(start[1], 2), "start_z": round(start[2], 2)} if start else {})}
            writer.writerow(row)
            flush()
            rows.append(row)
            try:
                kept = [line.strip()[:300] for line in log_text.splitlines() if LOG_KEEP_RE.search(line)][:40]
                with notes_file.open("a", encoding="utf-8") as notes:
                    notes.write(f"--- spot {spot} shot {index} ({name}) {sent_at} note: {typed}\n" + "\n".join(kept) + "\n")
            except OSError:
                pass
            if lie.get("lie_speed_pct") is not None:
                took = f"{lie['lie_surface']}: speed kept {lie['lie_speed_pct']:.0f}%, spin {lie['lie_spin_pct']:.0f}%, launch {lie['lie_vla_pct']:.0f}%"
            else:
                took = f"no penalty line in GSPro's log (start surface {row.get('start_surface', 'not recorded')})"
            flown = row.get("carry_yd") if row.get("carry_yd") is not None else row.get("db_carry_yd")
            carry = f"carried {flown:.1f} yd" if flown is not None else "carry not recorded"
            elsewhere = f"  [hit from {moved:g} yd away from the first shot's spot]" if moved and moved > 2 else ""
            print(f"  {name:<16} {took}; {carry}{elsewhere}")
            sleep(gap)
        spot += 1
    return rows


# --------------------------------------------------------------------------
# Check what GSPro records: one shot, then a report of everything GSPro wrote.

TEXT_SUFFIXES = (".txt", ".log", ".json", ".dat", ".csv", ".xml")


def folder_snapshot(folder: Path) -> dict[str, tuple[int, float]]:
    """Every file under GSPro's data folder: size and time last written."""
    seen: dict[str, tuple[int, float]] = {}
    try:
        for item in folder.rglob("*"):
            try:
                if item.is_file():
                    stat = item.stat()
                    seen[str(item.relative_to(folder))] = (stat.st_size, stat.st_mtime)
            except OSError:
                continue
            if len(seen) > 20000:
                break
    except OSError:
        pass
    return seen


def db_counts(db_file: Path) -> dict[str, int]:
    """Rows per table (read only)."""
    try:
        with sqlite3.connect(f"file:{db_file.as_posix()}?mode=ro", uri=True, timeout=2.0) as conn:
            tables = [r[0] for r in conn.execute("select name from sqlite_master where type='table'")]
            return {t: conn.execute(f'select count(*) from "{t}"').fetchone()[0] for t in tables}
    except sqlite3.Error:
        return {}


def db_newest_row(db_file: Path, table: str) -> str:
    try:
        with sqlite3.connect(f"file:{db_file.as_posix()}?mode=ro", uri=True, timeout=2.0) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(f'select * from "{table}" order by rowid desc limit 1').fetchone()
            return json.dumps({k: (str(row[k])[:1500]) for k in row.keys()}, indent=1) if row else "(empty)"
    except sqlite3.Error as exc:
        return f"(could not read: {exc})"


def check_recording(path: Any, read_line, *, folder: Path, round_file: Path, out: Path, sleep=time.sleep) -> list[str]:
    """Hit one shot and write down every file, log line and database row GSPro changed because of it."""
    shot = {"speed": 94.4, "vla": 22.4, "hla": 0.0, "spin": 8646.0, "axis": 0.0}
    dbs = [p for p in folder.glob("*.db")]
    before_files = folder_snapshot(folder)
    before_counts = {db.name: db_counts(db) for db in dbs}
    before_record = newest_round_record(round_file)
    status = path.fire(shot)
    if "at rest" not in status:
        sleep(NO_STOP_SIGNAL_WAIT_S)
    sleep(4.0)  # let GSPro finish writing
    after_files = folder_snapshot(folder)
    lines = [f"Looper check: one PW shot (94.4 mph, 22.4 deg, 8646 rpm) at {time.strftime('%Y-%m-%dT%H:%M:%S')}", f"GSPro said: {status}",
             f"Folder: {folder}", f"Files in the folder: {len(after_files)}", "", "FILES GSPRO WROTE DURING THE SHOT"]
    changed = sorted(name for name, meta in after_files.items() if before_files.get(name) != meta)
    for name in changed:
        old_size = before_files.get(name, (0, 0.0))[0]
        lines.append(f"  {name}: {old_size} -> {after_files[name][0]} bytes" + ("  (new file)" if name not in before_files else ""))
    if not changed:
        lines.append("  none")
    for name in changed:
        old_size, new_size = before_files.get(name, (0, 0.0))[0], after_files[name][0]
        if not name.lower().endswith(TEXT_SUFFIXES) or name.lower().endswith("currentround.dat"):
            continue
        try:
            with (folder / name).open("rb") as handle:
                if new_size > old_size:
                    handle.seek(old_size)
                    text, what = handle.read(30000).decode("utf-8", errors="replace"), "TEXT ADDED TO"
                else:
                    text, what = handle.read(6000).decode("utf-8", errors="replace"), "START OF REWRITTEN"
        except OSError as exc:
            text, what = f"(could not read: {exc})", "TEXT ADDED TO"
        lines += ["", f"{what} {name}", text.strip()]
    lines += ["", "DATABASE TABLES THAT GAINED ROWS"]
    any_rows = False
    for db in dbs:
        after = db_counts(db)
        for table, count in sorted(after.items()):
            was = before_counts.get(db.name, {}).get(table, 0)
            if count != was:
                any_rows = True
                lines += [f"  {db.name} / {table}: {was} -> {count} rows. Newest row:", db_newest_row(db, table)]
    if not any_rows:
        lines.append("  none")
    after_record = newest_round_record(round_file)
    same = record_fingerprint(after_record) == record_fingerprint(before_record)
    lines += ["", f"currentRound.dat newest shot record: {'UNCHANGED by this shot' if same else 'changed'}"]
    if after_record:
        lines.append(json.dumps(after_record, default=str)[:6000])
    try:
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"  could not save the report: {exc}")
    return lines


def clubs_for_distance(distance_yd: float, bag: dict[str, dict[str, float]]) -> list[str]:
    """Clubs whose stock carry lands near the pin from here, shortest first."""
    low, high = distance_yd + GREEN_WINDOW_YD[0], distance_yd + GREEN_WINDOW_YD[1]
    fits = [club for club, stock in bag.items() if "carry" in stock and low <= stock["carry"] <= high]
    return sorted(fits, key=lambda club: bag[club]["carry"])


def choose(read_line, question: str, options: list[tuple[str, str]], default: str) -> str:
    """Ask a numbered question; Enter takes the default. Returns the chosen value."""
    print(question)
    for number, (value, text) in enumerate(options, start=1):
        print(f"  {number}  {text}{'   (Enter)' if value == default else ''}")
    while True:
        answer = read_line("> ").strip().lower()
        if answer == "":
            return default
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1][0]
        match = [value for value, text in options if answer in (value.lower(), text.lower())]
        if match:
            return match[0]
        print(f"  Type a number from 1 to {len(options)}, or press Enter.")


def ask_number(read_line, question: str, default: float, low: float, high: float) -> float:
    while True:
        answer = read_line(f"{question} [{default:g}] ").strip()
        if answer == "":
            return default
        try:
            value = float(answer)
        except ValueError:
            value = low - 1
        if low <= value <= high:
            return value
        print(f"  A number from {low:g} to {high:g}, or press Enter for {default:g}.")


#: Designed shots: five levels each of ball speed, launch and spin, combined so that every
#: speed meets every launch and every spin exactly once, and every launch meets every spin
#: exactly once (an orthogonal array, 25 shots). A normal bag can't do this: its fast shots
#: are always low and low-spin, so stock shots can't say which of the three causes the roll.
GRID_SPEEDS_MPH = (70.0, 95.0, 120.0, 145.0, 165.0)
GRID_LAUNCH_DEG = (9.0, 14.0, 19.0, 24.0, 30.0)
GRID_SPIN_RPM = (2200.0, 4200.0, 6200.0, 8200.0, 10200.0)


def designed_shots() -> dict[str, dict[str, float]]:
    """The 25 designed shots, named by their numbers: "120mph 19deg 6200rpm"."""
    shots: dict[str, dict[str, float]] = {}
    for i, speed in enumerate(GRID_SPEEDS_MPH):
        for j, launch in enumerate(GRID_LAUNCH_DEG):
            spin = GRID_SPIN_RPM[(i + j) % len(GRID_SPIN_RPM)]
            shots[f"{speed:g}mph {launch:g}deg {spin:g}rpm"] = {"speed": speed, "vla": launch, "spin": spin}
    return shots


SETTING_OPTIONS = [("soft", "Soft"), ("medium", "Medium"), ("firm", "Firm")]
TYPE_OPTIONS = [("soft", "Soft (Bentgrass)"), ("medium", "Medium (Bermuda)"), ("firm", "Firm (Links)")]


def putt_summary(rows: list[dict[str, Any]]) -> list[str]:
    """Average roll at each speed, and whether repeat putts matched."""
    lines = []
    widest = 0.0
    for speed in sorted({row["sent_speed_mph"] for row in rows}):
        rolls = [row["putt_roll_ft"] for row in rows if row["sent_speed_mph"] == speed and row.get("putt_roll_ft") is not None and not row.get("holed")]
        if not rolls:
            continue
        widest = max(widest, max(rolls) - min(rolls))
        lines.append(f"  {speed:>5.1f} mph: rolled {sum(rolls) / len(rolls):5.1f} ft ({len(rolls)} putts)")
    if any(sum(1 for row in rows if row["sent_speed_mph"] == speed) >= 2 for speed in {row["sent_speed_mph"] for row in rows}):
        lines.append(f"  Repeat putts matched to within {widest:.1f} ft." + (" One putt a speed is enough." if widest <= 0.3 else ""))
    return lines


def spread_note(rows: list[dict[str, Any]]) -> str | None:
    """Whether repeat shots of the same club came out the same (so one shot a club is enough)."""
    widest = 0.0
    repeats = False
    for club in {row["club"] for row in rows}:
        rolls = [row["roll_yd"] for row in rows if row["club"] == club and row.get("roll_yd") is not None]
        if len(rolls) >= 2:
            repeats = True
            widest = max(widest, max(rolls) - min(rolls))
    if not repeats:
        return None
    if widest <= 0.5:
        return f"Repeat shots matched to within {widest:.1f} yd: one shot a club is enough."
    return f"Repeat shots differed by up to {widest:.1f} yd: keep hitting at least two a club."


def fire_series(path: Any, read_line, writer: Any, flush, *, test: str, labels: dict[str, Any], bag: dict[str, dict[str, float]],
                clubs: list[str], repeats: int, gap: float, db_path: Path, round_file: Path, record_wait: float,
                confirm_each: bool, sleep=time.sleep) -> list[dict[str, Any]]:
    """Fire the shots for one setting and write a row for each. Returns the rows."""
    shots = plan(clubs, repeats)
    rows: list[dict[str, Any]] = []
    for index, club in enumerate(shots, start=1):
        stock = bag[club]
        if confirm_each:
            try:
                if read_line(f"  {club}, shot {index} of {len(shots)}. Ball back on the spot? Enter to hit, q to stop this set. ").strip().lower() in ("q", "quit"):
                    break
            except EOFError:
                break
        before_record = record_fingerprint(newest_round_record(round_file)) if test in ("green", "putt") else None
        before_row = latest_row_safely(db_path)
        before_id = before_row[0] if before_row else None
        shot = {"speed": stock["speed"], "vla": stock["vla"], "hla": stock.get("hla", 0.0), "spin": stock["spin"], "axis": 0.0}
        sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        try:
            status = path.fire(shot)  # blocks until GSPro's ball-at-rest: one shot at a time
        except (ConnectionError, OSError) as exc:
            print(f"  could not send: {exc}")
            break
        if "at rest" not in status:
            # GSPro did not say the ball had stopped: give it time to fly and roll out before anything else.
            print(f"  (no ball-at-rest from GSPro; waiting {NO_STOP_SIGNAL_WAIT_S:g} s for the shot to finish)")
            sleep(NO_STOP_SIGNAL_WAIT_S)
        if test == "putt":
            measured = measure_putt(wait_for_new_record(round_file, before_record, record_wait, sleep=sleep))
            if measured.get("putt_roll_ft") is None:
                # Practice greens list putts in GSPro's shot table instead (total distance, in yards).
                found = wait_for_new_row(db_path, before_id, 2.0, sleep=sleep)
                total = _num(found[1].get("TotalDistance")) if found else None
                if found and total is not None:
                    measured = {"row_id": found[0], "putt_roll_ft": round(total * 3.0, 2), "gspro_speed_mph": _num(found[1].get("BallSpeed"))}
        elif test == "green":
            measured = measure_landing(wait_for_new_record(round_file, before_record, record_wait, sleep=sleep))
        else:
            found = wait_for_new_row(db_path, before_id, record_wait, sleep=sleep)
            measured = {"row_id": found[0], **measure(found[1])} if found else {}
        stored_roll = round(stock["total"] - stock["carry"], 1) if "total" in stock and "carry" in stock else None
        row = {"test": test, **labels, "club": club, "n": index, "status": status,
               "sent_speed_mph": stock["speed"], "sent_vla_deg": stock["vla"], "sent_spin_rpm": stock["spin"],
               "sent_hla_deg": stock.get("hla"),
               "stored_carry_yd": stock.get("carry"), "stored_roll_yd": stored_roll, "sent_at": sent_at, **measured}
        writer.writerow(row)
        flush()
        rows.append(row)
        if test == "putt":
            if row.get("putt_roll_ft") is None:
                print(f"  {index:>3}/{len(shots)}  {club:<7} not recorded by GSPro   [{status}]")
            else:
                holed = "  (HOLED: roll cut short, not usable)" if row.get("holed") else ""
                height = f", {row['putt_height_change_in']:+.1f} in. height change" if row.get("putt_height_change_in") is not None else ""
                print(f"  {index:>3}/{len(shots)}  {club:<7} rolled {row['putt_roll_ft']:5.1f} ft{height}{holed}")
        elif row.get("roll_yd") is None:
            print(f"  {index:>3}/{len(shots)}  {club:<6} not recorded by GSPro   [{status}]")
        elif test == "green":
            on_green = "on the green" if row.get("finish_surface") == GREEN_SURFACE else f"finished off the green (surface {row.get('finish_surface')})"
            did = "spun back" if row["roll_yd"] < 0 else "released"
            print(f"  {index:>3}/{len(shots)}  {club:<6} carried {row['carry_yd']:6.1f}, {did} {abs(row['roll_yd']):4.1f} yd, "
                  f"{row['roll_height_change_in']:+.0f} in. height change, {on_green}")
        else:
            print(f"  {index:>3}/{len(shots)}  {club:<6} carry {row['carry_yd']:6.1f}  total {row['total_yd']:6.1f}  roll {row['roll_yd']:5.1f} yd")
        sleep(gap)
    return rows


def guided(read_line=input, db_path: Path | None = None, round_file: Path | None = None, path: Any = None,
           sleep=time.sleep, bag: dict[str, dict[str, float]] | None = None, out_dir: Path | None = None,
           log_file: Path | None = None) -> int:
    """Double-click mode: asks what to test and what GSPro is set to, then hits the shots."""
    bag = bag or BAG
    db_path = db_path or gspro_db()
    round_file = round_file or gspro_round_file()
    log_file = log_file or gspro_log()
    lie_spots = 0
    out = (out_dir or HERE) / f"looper_lab_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    print("Looper lab: measure how GSPro lands and rolls your shots, with no swings.\n")
    print("Before you start: CLOSE THE UNEEKOR LAUNCHER, have GSPro open, and do not have a")
    print("Looper practice session running (these shots are not swings and must stay out of your bag).\n")
    print("Press Enter at any question to take the answer marked (Enter) or shown in [brackets].\n")

    if path is None:
        path = OpenConnectPath(UNEEKOR_HOST, [UNEEKOR_PORT, OPEN_CONNECT_PORT], "2", 60.0)
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3

    answers: dict[str, Any] = {"type": "medium", "fairway": "medium", "green": "medium", "stimp": 10.0, "repeats": 2.0, "gap": 3.0, "test": "fairway"}
    total = 0
    try:
        with out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=LAB_FIELDS, extrasaction="ignore")
            writer.writeheader()
            while True:
                test = choose(read_line, "What do you want to test?", [
                    ("fairway", "Fairway roll: whole bag on the Practice Range"),
                    ("grid", "Designed shots: 25 shots that separate speed, launch and spin (Practice Range)"),
                    ("green", "Landing on a green: irons and wedges in On Course practice"),
                    ("putt", "Putt roll: putts at set speeds on a green"),
                    ("lie", "Shots from a lie: drop the ball anywhere in On Course practice, 3 shots per spot"),
                    ("check", "Check what GSPro records: one shot, then a report of every file GSPro wrote"),
                    ("quit", "Finished"),
                ], answers["test"])  # Enter repeats the last test, so nine settings are nine quick passes
                if test == "quit":
                    break
                if test == "check":
                    print("\nStay exactly where you are in GSPro (On Course practice, ball dropped). One PW shot is hit,")
                    print("then this looks at everything GSPro wrote because of it. It only reads.")
                    try:
                        if read_line("Enter to hit the shot, q to cancel. ").strip().lower() in ("q", "quit"):
                            print()
                            continue
                    except EOFError:
                        break
                    report = out.with_name(out.stem.replace("looper_lab", "looper_check") + f"_{time.strftime('%H%M%S')}.txt")
                    try:
                        found = check_recording(path, read_line, folder=db_path.parent, round_file=round_file, out=report, sleep=sleep)
                    except (ConnectionError, OSError) as exc:
                        print(f"  could not send: {exc}\n")
                        continue
                    wrote = found[found.index("FILES GSPRO WROTE DURING THE SHOT") + 1:]
                    for line in wrote[:wrote.index("")] if "" in wrote else wrote[:12]:
                        print(line)
                    print(f"\nSaved: {report}\nSend that file to Claude.\n")
                    continue
                answers["test"] = test
                answers["type"] = choose(read_line, "\nCourse Type set in GSPro right now?", TYPE_OPTIONS, answers["type"])
                labels: dict[str, Any] = {"course_type": answers["type"]}
                if test == "lie":
                    print("\nGSPro should be in On Course practice, on any hole.")
                    print("Drop the ball somewhere, come back here and press Enter. It hits three shots (soft, medium, hard),")
                    print("then you drop the ball somewhere else. Any lie is useful: rough, deep rough, sand, fringe, slopes,")
                    print("pine straw, cart path. A couple from the fairway too, as the comparison.")
                    print("If the ball does not come back to your spot between shots, leave it: each shot is recorded where it was hit.")
                    if not log_file.exists():
                        print(f"\nNote: GSPro's log was not found at {log_file}. Shots are still recorded, without GSPro's penalty.")
                    notes_file = out.with_name(out.stem + "_log.txt")
                    rows = lie_session(path, read_line, writer, handle.flush, labels=labels, round_file=round_file, log_file=log_file,
                                       db_path=db_path, notes_file=notes_file, gap=1.0, record_wait=8.0, first_spot=lie_spots + 1, sleep=sleep)
                    total += len(rows)
                    lie_spots = max([lie_spots] + [int(row["spot"]) for row in rows])
                    print()
                    for line in lie_summary(rows):
                        print(line)
                    if rows and all(row.get("lie_speed_pct") is None for row in rows):
                        print("  GSPro wrote no penalty line for any of these. Send the files anyway: the carries still show the effect.")
                    print(f"\nSaved so far: {total} shots in {out.name} (GSPro's log lines in {notes_file.name}).\n")
                    continue
                confirm_each = False
                shot_bag = bag
                if test == "putt":
                    answers["green"] = choose(read_line, "\nGreen Firmness set in GSPro right now?", SETTING_OPTIONS, answers["green"])
                    answers["stimp"] = ask_number(read_line, "Stimp set in GSPro right now?", answers["stimp"], 6, 13)
                    slope = choose(read_line, "\nWhich way does this putt run?", [
                        ("flat", "Flat"), ("uphill", "Uphill"), ("downhill", "Downhill"),
                    ], answers.get("slope", "flat"))
                    answers["slope"] = slope
                    labels.update({"green_firmness": answers["green"], "stimp": answers["stimp"], "slope": slope})
                    print("\nGSPro should have the ball on a green, ready for a putt, with room past the hole.")
                    answers["hla"] = ask_number(read_line, "Degrees to start it off line so it misses the hole and rolls out (negative is left)?",
                                                answers.get("hla", 3.0), -15, 15)
                    shot_bag = putt_shots(PUTT_SPEEDS_MPH, answers["hla"])
                    clubs = list(shot_bag)
                    typed = read_line(f"Speeds in mph? Enter for {', '.join(f'{v:g}' for v in PUTT_SPEEDS_MPH)}, or list your own (3,5,7): ").strip()
                    if typed:
                        try:
                            speeds = [float(part) for part in typed.split(",") if part.strip()]
                            if not speeds or any(not 0.5 <= speed <= 25 for speed in speeds):
                                raise ValueError
                        except ValueError:
                            print("  Speeds are numbers from 0.5 to 25, separated by commas.\n")
                            continue
                        shot_bag = putt_shots(speeds, answers["hla"])
                        clubs = list(shot_bag)
                        typed = ""
                    confirm_each = choose(read_line, "\nAfter each putt, does GSPro put the ball back on your spot by itself?", [
                        ("yes", "Yes, it resets"), ("no", "No, I put it back (I'll press Enter before each putt)"),
                    ], "no") == "no"
                elif test == "grid":
                    answers["fairway"] = choose(read_line, "\nFairway Firmness set in GSPro right now?", SETTING_OPTIONS, answers["fairway"])
                    labels["fairway_firmness"] = answers["fairway"]
                    answers["elevation"] = ask_number(read_line, "Elevation set in GSPro, in feet (0 for Global)?", answers.get("elevation", 0.0), -500, 12000)
                    labels["elevation_ft"] = answers["elevation"]
                    print("\nGSPro should be on the Practice Range (Driving Range), hitting to the fairway.")
                    print("These are not golf shots: some are fast with wedge spin, some slow and low. That is the point.")
                    shot_bag = designed_shots()
                    clubs = list(shot_bag)
                    typed = ""
                elif test == "fairway":
                    answers["fairway"] = choose(read_line, "\nFairway Firmness set in GSPro right now?", SETTING_OPTIONS, answers["fairway"])
                    labels["fairway_firmness"] = answers["fairway"]
                    # Altitude changes carry, not roll: run the bag at two or three elevations to measure it.
                    answers["elevation"] = ask_number(read_line, "Elevation set in GSPro, in feet (0 for Global)?", answers.get("elevation", 0.0), -500, 12000)
                    labels["elevation_ft"] = answers["elevation"]
                    print("\nGSPro should be on the Practice Range (Driving Range), hitting to the fairway.")
                    clubs = list(bag)
                    typed = read_line("Which clubs? Enter for the whole bag, or list them (Driver,7i,PW): ").strip()
                else:
                    answers["green"] = choose(read_line, "\nGreen Firmness set in GSPro right now?", SETTING_OPTIONS, answers["green"])
                    answers["stimp"] = ask_number(read_line, "Stimp set in GSPro right now?", answers["stimp"], 5, 16)
                    labels.update({"green_firmness": answers["green"], "stimp": answers["stimp"]})
                    print("\nGSPro should be in On Course practice with the ball dropped in the fairway, aimed at the pin.")
                    print("Pick a green that looks flat; the results show how much each shot's roll climbed or dropped.")
                    distance = ask_number(read_line, "How far is the ball from the pin, in yards (GSPro shows it)?", 120, 20, 260)
                    labels["pin_distance_yd"] = distance
                    clubs = clubs_for_distance(distance, bag)
                    if clubs:
                        print(f"From {distance:g} yd these land near the pin: {', '.join(clubs)}.")
                        typed = read_line("Which clubs? Enter for those, or list your own: ").strip()
                    else:
                        nearest = min(bag, key=lambda club: abs(bag[club].get("carry", 0) - distance))
                        print(f"No stock shot carries about {distance:g} yd. The nearest is {nearest} at {bag[nearest]['carry']:.0f} yd: "
                              f"drop the ball about {bag[nearest]['carry']:.0f} yd out for it.")
                        typed = read_line("Which clubs? List them, or Enter to go back: ").strip()
                        if not typed:
                            print()
                            continue
                    confirm_each = choose(read_line, "\nAfter each shot, does GSPro put the ball back on your spot by itself?", [
                        ("yes", "Yes, it resets"), ("no", "No, I put it back (I'll press Enter before each shot)"),
                    ], "no") == "no"
                if typed:
                    try:
                        clubs = pick_clubs(typed, bag)
                    except ValueError as exc:
                        print(f"  {exc}\n")
                        continue
                # GSPro's roll repeats exactly, so each designed shot is hit once.
                if test == "grid":
                    repeats = 1
                elif test == "putt":
                    repeats = int(ask_number(read_line, "Putts at each speed?", answers.get("putt_repeats", 2.0), 1, 10))
                    answers["putt_repeats"] = float(repeats)
                else:
                    repeats = int(ask_number(read_line, "Shots per club?", answers["repeats"], 1, 10))
                    answers["repeats"] = float(repeats)
                answers["gap"] = ask_number(read_line, "Extra seconds to wait once the ball has stopped (the flight itself is already waited for)?", answers["gap"], 0, 60)
                shots = repeats * len(clubs)
                what = "the 25 designed shots" if test == "grid" else f"{repeats} each of {', '.join(clubs)}"
                if test == "putt":
                    what = f"{repeats} each at {', '.join(clubs)}"
                try:
                    if read_line(f"\n{shots} shots: {what}. Enter to start, q to cancel. ").strip().lower() in ("q", "quit"):
                        print()
                        continue
                except EOFError:
                    break
                rows = fire_series(path, read_line, writer, handle.flush, test=test, labels=labels, bag=shot_bag, clubs=clubs,
                                   repeats=repeats, gap=answers["gap"], db_path=db_path, round_file=round_file,
                                   record_wait=8.0, confirm_each=confirm_each, sleep=sleep)
                total += len(rows)
                print()
                if test == "fairway":
                    for line in summarize(rows, bag):
                        print(line)
                note = spread_note(rows)
                if note:
                    print(f"  {note}")
                if test == "putt":
                    for line in putt_summary(rows):
                        print(line)
                    if rows and all(row.get("putt_roll_ft") is None for row in rows):
                        print("  GSPro did not record any of these putts. Tell Claude which GSPro screen you were on.")
                elif rows and all(row.get("roll_yd") is None for row in rows):
                    where = "On Course practice" if test == "green" else "the Practice Range (Driving Range)"
                    print(f"  GSPro did not record any of these. They only count in {where}. Tell Claude which screen you were on.")
                print(f"\nSaved so far: {total} shots in {out.name}.")
                print("Change the setting in GSPro for the next set, or choose Finished.\n")
    except (KeyboardInterrupt, EOFError):
        print()
    finally:
        path.close()
    if total:
        print(f"\n{total} shots saved in {out}\nSend that file to Claude.")
        if out.with_name(out.stem + "_log.txt").exists():
            print(f"Send {out.stem}_log.txt from the same folder too.")
    else:
        try:
            out.unlink()
        except OSError:
            pass
    pause_before_close(read_line)
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        return guided()  # double-clicked, or run with nothing after the name: ask questions
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--type", default="medium", help="Course Type set in GSPro: soft, medium or firm")
    p.add_argument("--fairway", default="medium", help="Fairway Firmness set in GSPro: soft, medium or firm")
    p.add_argument("--clubs", default="all", help="Clubs to hit, comma separated")
    p.add_argument("--repeats", type=int, default=3, help="Times each club is hit")
    p.add_argument("--bag", default="", help="JSON file of another player's stock shots")
    p.add_argument("--gap", type=float, default=1.5, help="Seconds to wait after the ball stops")
    p.add_argument("--record-wait", type=float, default=8.0, help="Seconds to wait for GSPro to save the shot")
    p.add_argument("--host", default=UNEEKOR_HOST)
    p.add_argument("--port", type=int, default=0, help="Use only this port")
    p.add_argument("--api-version", default="2")
    p.add_argument("--timeout", type=float, default=60.0, help="Seconds to wait for GSPro's ball-at-rest")
    return run(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
