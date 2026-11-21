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
  Wander             the same, but the tool moves the ball itself by clicking
                     GSPro's minimap, spot after spot, until you move the mouse
  Shots from a lie   On Course practice: drop the ball anywhere (rough, sand,
                     fringe, a slope), press Enter, and it hits three shots, one
                     soft, one medium, one hard. Move the ball and repeat. Records
                     what GSPro took off each shot for the lie, and the carry.
                     Type "chip stimp 11" at a spot just off a green for the chip
                     set: bump, chip, pitch and flop, each to 5, 10 and 16 yd,
                     one shot each. Set green firmness and stimp in GSPro and
                     repeat the set for each (3 firmnesses x 3 stimps). Your own
                     chip numbers go in chips.json next to this file.

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
import math
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
    "slope", "slope_deg_typed", "putt_roll_ft", "putt_height_change_in", "putt_grade_pct", "putt_to_cup_ft", "sent_hla_deg",
    "sent_speed_mph", "sent_vla_deg", "sent_spin_rpm", "gspro_speed_mph", "gspro_vla_deg", "gspro_spin_rpm",
    "stored_carry_yd", "stored_roll_yd", "row_id", "sent_at",
    "spot", "note", "lie_surface", "lie_speed_pct", "lie_spin_pct", "lie_vla_pct", "lie_type",
    "start_surface", "start_x", "start_y", "start_z", "moved_from_spot_yd", "log_speed_mph", "log_vla_deg", "log_spin_rpm",
    "landing_surface", "landing_material", "landing_spin_rpm", "log_course_type", "log_fairway_firmness", "log_green_firmness",
    "db_carry_yd", "db_total_yd", "db_raw_carry_game_yd", "db_raw_carry_lm_yd", "db_pin_yd",
    "gspro_hla_deg", "gspro_axis_deg", "landing_speed", "course_key", "hole", "land_x", "land_y", "land_z", "end_x", "end_y", "end_z",
    "peak_height_ft", "flown_vla_deg", "start_line_deg", "curve_yd", "offline_from_aim_yd", "aim_heading_deg",
    "db_offline_yd", "db_peak_height", "db_descent_deg", "db_vla_deg", "db_hla_deg", "db_backspin_rpm", "db_sidespin_rpm", "db_id",
    # Wander (wander.py): where it clicked the minimap, and the slope the companion read there.
    "click_x", "click_y", "slope_up_deg", "slope_right_deg", "slope_read",
    "pin_x", "pin_y", "pin_z", "pin_from_spot_yd", "aim",
]
M_TO_FT = 3.280839895
#: Putt speeds rolled by default, mph off the face.
PUTT_SPEEDS_MPH = (2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0)


def measure_putt(record: dict[str, Any] | None) -> dict[str, Any]:
    """How far a putt rolled and how much it climbed or dropped, from GSPro's record of it."""
    if not record:
        return {}
    active = ((record.get("activeShot") or {}).get("sd")) or {}
    shot_data = active or ((record.get("GhostData") or {}).get("atShotData")) or {}
    # On Course practice records do not always carry StartingPOS / EndingPOS: the ball's own path does.
    rolled = [p for p in (_xyz(point) for point in (active.get("pos") or [])) if p]
    if not rolled and isinstance(shot_data.get("path"), list):
        rolled = [p for p in (_xyz((point or {}).get("pos")) for point in shot_data["path"]) if p]
    start = _xyz(record.get("StartingPOS")) or _xyz(shot_data.get("BallStartPos")) or (rolled[0] if rolled else None)
    end = _xyz(record.get("EndingPOS")) or (rolled[-1] if rolled else None)
    cup = _xyz(shot_data.get("tdpoint"))
    row: dict[str, Any] = {"row_id": record.get("ShotID"), "holed": bool(shot_data.get("isHoled")),
                           "finish_surface": record.get("EndingSurface"),
                           "gspro_speed_mph": _num((record.get("GhostData") or {}).get("lmfSP"), record.get("BallSpeed")),
                           "course_key": record.get("CourseKey"), "hole": record.get("Hole")}
    if start and end:
        roll_m = ((end[0] - start[0]) ** 2 + (end[2] - start[2]) ** 2) ** 0.5
        row["putt_roll_ft"] = round(roll_m * M_TO_FT, 2)
        row["putt_height_change_in"] = round((end[1] - start[1]) * M_TO_IN, 1)
        if roll_m > 0.3:
            row["putt_grade_pct"] = round((end[1] - start[1]) / roll_m * 100.0, 2)  # + is uphill
        row.update({"start_x": round(start[0], 2), "start_y": round(start[1], 2), "start_z": round(start[2], 2),
                    "end_x": end[0], "end_y": end[1], "end_z": end[2]})
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
    ghost = record.get("GhostData") or {}
    row: dict[str, Any] = {
        "row_id": record.get("ShotID"),
        "finish_surface": record.get("EndingSurface"),
        "holed": bool(shot_data.get("isHoled")),
        "gspro_speed_mph": _num((record.get("GhostData") or {}).get("lmfSP"), record.get("BallSpeed")),
        # What GSPro actually launched after the lie: speed above, and launch, direction, spin and tilt here.
        "gspro_vla_deg": _num(ghost.get("lmfEL")), "gspro_hla_deg": _num(ghost.get("lmfAZ")),
        "gspro_spin_rpm": _num(ghost.get("lmfTS")), "gspro_axis_deg": _num(ghost.get("lmfSA")),
        "landing_surface": shot_data.get("TDmaterial"),
        "descent_deg": _num(shot_data.get("descentAngle")),
        "landing_spin_rpm": _num(shot_data.get("finalSpin")),
        "landing_speed": _num(shot_data.get("finalSpeed")),
        "course_key": record.get("CourseKey"), "hole": record.get("Hole"),
        "land_x": landed[0] if landed else None, "land_y": landed[1] if landed else None, "land_z": landed[2] if landed else None,
        "end_x": end[0] if end else None, "end_y": end[1] if end else None, "end_z": end[2] if end else None,
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
    # The flight itself, from GSPro's own path. GSPro's stored launch numbers (lmfEL, lmfAZ) carry the
    # grass penalty but NOT the slope: a sloped lie only shows in the path (checked 18 Nov on 27 shots).
    # activeShot's path is in course coordinates; the copy under GhostData is not (checked on real records).
    raw_path = (((record.get("activeShot") or {}).get("sd") or {}).get("pos") or shot_data.get("pos") or [])
    flight = [p for p in (_xyz(point) for point in raw_path) if p]
    aim_deg = _num(ghost.get("ballDirection"))
    if start and landed and len(flight) >= 3:
        row["peak_height_ft"] = round((max(p[1] for p in flight) - start[1]) * M_TO_FT, 1)
        sx, sy, sz = (flight[1][i] - flight[0][i] for i in range(3))
        length = (sx * sx + sz * sz) ** 0.5
        if length > 1e-6:
            row["flown_vla_deg"] = round(math.degrees(math.atan2(sy, length)), 2)
            ux, uz = sx / length, sz / length
            lx, lz = landed[0] - start[0], landed[2] - start[2]
            row["curve_yd"] = round((lx * uz - lz * ux) * M_TO_YD, 2)  # + is right of where it started
            if aim_deg is not None:
                # ballDirection is the aim as a compass heading in GSPro's world: 0 is +z, 90 is +x.
                ax, az = math.sin(math.radians(aim_deg)), math.cos(math.radians(aim_deg))
                turned = (math.degrees(math.atan2(sx, sz)) - aim_deg + 180.0) % 360.0 - 180.0
                row["start_line_deg"] = round(turned, 2)  # + is right of the aim
                row["offline_from_aim_yd"] = round((lx * az - lz * ax) * M_TO_YD, 2)
                row["aim_heading_deg"] = round(aim_deg, 2)
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
#: GSPro writes the pin each shot, in the same course coordinates as the round record (metres).
LOG_PIN_RE = re.compile(r"pinPos:\s*\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)")
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
        if (m := LOG_PIN_RE.search(line)):
            row.update({"pin_x": float(m[1]), "pin_y": float(m[2]), "pin_z": float(m[3])})
    return row


def save_shot_table(db_path: Path, out: Path) -> int:
    """Copy every shot GSPro has in its shot table to a csv (read only). Returns how many."""
    try:
        with sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=2.0) as conn:
            found = conn.execute("SELECT ID, DateCreated, ShotData FROM DrivingRangeShot ORDER BY ID").fetchall()
    except sqlite3.Error:
        return 0
    rows = []
    for shot_id, created, raw in found:
        try:
            data = json.loads(raw) if isinstance(raw, (str, bytes)) else {}
        except ValueError:
            data = {}
        rows.append({"ID": shot_id, "DateCreated": created, **(data if isinstance(data, dict) else {})})
    if not rows:
        return 0
    names = list(dict.fromkeys(key for row in rows for key in row))
    try:
        with out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=names)
            writer.writeheader()
            writer.writerows(rows)
    except OSError:
        return 0
    return len(rows)


#: Carry against the same shot at stock spin (GSPro, 18 Nov: 5i, 6i, 7i, SW at 0.7x and 1.25x spin).
SPIN_CARRY = {0.7: 1.04, 1.0: 1.0, 1.25: 0.965}
#: Carry grows about as ball speed to the power 1.5 for a fixed launch and spin (GSPro, 60 to 100 mph at 24 deg).
CARRY_SPEED_POWER = 1.5
#: Land this far short of the number typed, so the ball finishes near the pin and not over the back.
GREEN_SHORT_YD = 2.0


def green_speed(shot: dict[str, float], plays: float | None) -> dict[str, float]:
    """The shot with its ball speed changed so it lands on the yardage typed.

    `plays` is what the last shot from this spot carried as a share of its flat carry; None before any shot.
    """
    wanted = max(10.0, shot["_target"] - GREEN_SHORT_YD) / (plays if plays and 0.4 < plays < 1.6 else 1.0)
    scale = (wanted / shot["_flat_carry"]) ** (1.0 / CARRY_SPEED_POWER)
    scale = min(1.2, max(0.75, scale))
    return {"speed": round(shot["speed"] * scale, 1), "vla": shot["vla"], "hla": 0.0, "spin": shot["spin"], "axis": 0.0}


# --------------------------------------------------------------------------
# Chip sets (Brian, 20 Nov): from just off a green (Briarwood West hole 1), each chip type to a few
# carries, one shot each. Change green firmness and stimp in GSPro between sets: 3 firmnesses x 3 stimps.
#: Each chip type's launch, and its ball speed and spin for a 10 yd carry. From TrackMan's chip study
#: ("The Chip Shot Code": launch 6-14 deg ~1,500 rpm, 15-20 ~2,000, 21-26 ~2,500, 27-35 ~3,000; about
#: 500 rpm per 5 mph of club speed), so spin scales with ball speed for the other carries, and the flop
#: stops by its landing angle, not by spin. Speeds are the engine's flight model for a 10 yd carry.
#: A player's own numbers go in chips.json next to this file
#: ({"bump": {"speed": .., "vla": .., "spin": .., "carry": ..}, ...}) and are used instead.
CHIP_TYPES: dict[str, dict[str, float]] = {
    "bump": {"speed": 34.0, "vla": 12.0, "spin": 1300.0, "carry": 10.0},
    "chip": {"speed": 27.2, "vla": 20.0, "spin": 2000.0, "carry": 10.0},
    "pitch": {"speed": 24.1, "vla": 28.0, "spin": 3000.0, "carry": 10.0},
    "flop": {"speed": 22.2, "vla": 40.0, "spin": 2600.0, "carry": 10.0},
}
CHIP_CARRIES_YD = (5.0, 10.0, 16.0)
#: At chip speeds carry grows about as speed^1.9 (the engine: 1.86 to 2.02 across the four types).
CHIP_SPEED_POWER = 1.9  # engine, with spin scaling with speed: 1.87 to 1.94
CHIP_FILE = "chips.json"


def chip_types(folder: Path = HERE) -> dict[str, dict[str, float]]:
    """Brian's chips.json if it is there and reads cleanly, else the placeholders."""
    try:
        loaded = json.loads((folder / CHIP_FILE).read_text(encoding="utf-8"))
        out = {str(name).lower(): {key: float(value[key]) for key in ("speed", "vla", "spin", "carry")}
               for name, value in loaded.items()}
        if out and all(v["speed"] > 0 and v["carry"] > 0 for v in out.values()):
            return out
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    return CHIP_TYPES


def read_chip_carries(typed: str) -> tuple[float, ...]:
    """'chip' -> the stock carries; 'chip 4 8 12' -> those (1 to 40 yd)."""
    found = re.search(r"\bchip\b((?:\s+\d{1,2}(?:\.\d)?)+)", typed, re.I)
    carries = tuple(float(x) for x in found[1].split()) if found else ()
    return carries if carries and all(1 <= c <= 40 for c in carries) else CHIP_CARRIES_YD


def chip_set(types: dict[str, dict[str, float]], carries: tuple[float, ...] = CHIP_CARRIES_YD) -> list[tuple[str, dict[str, float]]]:
    """Every type to every carry, one shot each, grouped by type so each type's first chip corrects the rest."""
    return [(f"{name} {carry:g} yd", {"speed": ref["speed"], "vla": ref["vla"], "hla": 0.0, "spin": ref["spin"], "axis": 0.0,
                                      "_chip": name, "_ref_speed": ref["speed"], "_ref_spin": ref["spin"],
                                      "_ref_carry": ref["carry"], "_target": carry})
            for name, ref in types.items() for carry in carries]


def chip_speed(shot: dict[str, float], plays: float | None) -> dict[str, float]:
    """Ball speed for the carry wanted. `plays` = what this type actually carried over what the scale said (None at first)."""
    plays = plays if plays and 0.3 < plays < 3.0 else 1.0
    scale = min(2.5, max(0.3, (shot["_target"] / (shot["_ref_carry"] * plays)) ** (1.0 / CHIP_SPEED_POWER)))
    # A shorter chip is a slower swing: less spin too (TrackMan: ~500 rpm per 5 mph of club speed).
    return {"speed": round(shot["_ref_speed"] * scale, 1), "vla": shot["vla"], "hla": 0.0,
            "spin": round(shot.get("_ref_spin", shot["spin"]) * scale), "axis": 0.0}


def chip_expected_carry(shot: dict[str, float], sent_speed: float) -> float:
    return shot["_ref_carry"] * (sent_speed / shot["_ref_speed"]) ** CHIP_SPEED_POWER


def chip_summary(rows: list[dict[str, Any]]) -> list[str]:
    lines = []
    for row in rows:
        carry = row.get("carry_yd") if row.get("carry_yd") is not None else row.get("db_carry_yd")
        roll, finish = row.get("roll_yd"), row.get("finish_surface")
        where = "on the green" if finish == GREEN_SURFACE else f"finished on surface {finish}" if finish is not None else ""
        lines.append(f"  {row['club']:<14} carried {carry:5.1f} yd, rolled {roll:5.1f} yd {where}" if carry is not None and roll is not None
                     else f"  {row['club']:<14} not recorded")
    return lines


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


def hit_spot(path: Any, writer: Any, flush, *, labels: dict[str, Any], spot: int, typed: str,
             spot_shots: list[tuple[str, dict[str, float]]], round_file: Path, log_file: Path, db_path: Path,
             notes_file: Path, gap: float, record_wait: float, sleep=time.sleep, test: str = "lie") -> tuple[list[dict[str, Any]], bool]:
    """Hit `spot_shots` from where the ball is now and record each one. (rows, still connected)."""
    rows: list[dict[str, Any]] = []
    origin: tuple[float, float, float] | None = None
    plays = None  # carry here as a share of the same shot's flat, sea-level carry (hill, altitude, lie)
    chip_plays: dict[str, float] = {}  # per chip type: carried over what the speed scale said
    for index, (name, shot) in enumerate(spot_shots, start=1):
        planned = shot
        if "_chip" in shot:
            shot = chip_speed(shot, chip_plays.get(shot["_chip"]))
        elif "_target" in shot:
            shot = green_speed(shot, plays)
        before_record = record_fingerprint(newest_round_record(round_file))
        before_log = log_size(log_file)
        before_row = latest_row_safely(db_path)
        sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        try:
            status = path.fire(shot)
        except (ConnectionError, OSError) as exc:
            print(f"  could not send: {exc}")
            return rows, False
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
                 "db_pin_yd": _num(data.get("DistanceToPin")),
                 # What GSPro flew after the lie: a slope shows up here as offline, height and launch.
                 "db_offline_yd": _num(data.get("Offline")), "db_peak_height": _num(data.get("PeakHeight")),
                 "db_descent_deg": _num(data.get("Decent")), "db_vla_deg": _num(data.get("VLA")), "db_hla_deg": _num(data.get("HLA")),
                 "db_backspin_rpm": _num(data.get("BackSpin")), "db_sidespin_rpm": _num(data.get("SideSpin")),
                 "db_id": found[0]} if found else {}
        start = _xyz((record or {}).get("StartingPOS"))
        origin = origin or start
        moved = round((((start[0] - origin[0]) ** 2 + (start[2] - origin[2]) ** 2) ** 0.5) * M_TO_YD, 1) if start and origin else None
        row = {"test": test, **labels, "spot": spot, "note": typed, "club": name, "n": index, "status": status,
               "sent_speed_mph": shot["speed"], "sent_vla_deg": shot["vla"], "sent_spin_rpm": shot["spin"], "sent_at": sent_at,
               **measure_landing(record), **lie, **table,
               "start_surface": (record or {}).get("StartingSurface"), "moved_from_spot_yd": moved,
               **({"start_x": round(start[0], 2), "start_y": round(start[1], 2), "start_z": round(start[2], 2)} if start else {})}
        writer.writerow(row)
        flush()
        rows.append(row)
        flown_yd = row.get("carry_yd") if row.get("carry_yd") is not None else row.get("db_carry_yd")
        if "_chip" in planned:
            if flown_yd:
                chip_plays[planned["_chip"]] = flown_yd / chip_expected_carry(planned, shot["speed"])
        elif flown_yd and (row.get("db_raw_carry_game_yd") or 0) > 5:
            plays = flown_yd / row["db_raw_carry_game_yd"]
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
        if row.get("flown_vla_deg") is not None:
            carry += f"; launched {row['flown_vla_deg']:.1f} deg (sent {shot['vla']:g})"
        if row.get("start_line_deg") is not None:
            off, turn = row["offline_from_aim_yd"], row["start_line_deg"]
            carry += f", started {abs(turn):.1f} deg {'right' if turn > 0 else 'left'}, landed {abs(off):.1f} yd {'right' if off > 0 else 'left'}"
        if row.get("peak_height_ft") is not None:
            carry += f", peak {row['peak_height_ft']:.0f} ft"
        if row.get("landing_surface") == GREEN_SURFACE and row.get("roll_yd") is not None:
            carry += f"; LANDED ON THE GREEN, {'spun back' if row['roll_yd'] < 0 else 'released'} {abs(row['roll_yd']):.1f} yd"
        elsewhere = f"  [hit from {moved:g} yd away from the first shot's spot]" if moved and moved > 2 else ""
        print(f"  {name:<16} {took}; {carry}{elsewhere}")
        sleep(gap)
    return rows, True


def lie_session(path: Any, read_line, writer: Any, flush, *, labels: dict[str, Any], round_file: Path, log_file: Path, db_path: Path,
                notes_file: Path, gap: float, record_wait: float, first_spot: int = 1, sleep=time.sleep) -> list[dict[str, Any]]:
    """Spot after spot: the player drops the ball and presses Enter, three shots are hit and recorded."""
    rows: list[dict[str, Any]] = []
    spot = first_spot
    while True:
        try:
            typed = read_line(f"\nSpot {spot}: drop the ball, then Enter to hit 3 shots. Type the slope first if it is not flat (2 up 3 left). "
                              "Add g and the yards to the pin (g 145) to also hit 2 of your clubs at the green; "
                              "gg 145 hits only the green, 6 shots. Type stimp 11 once to record the stimp. "
                              "Start with the word all to hit all 25 designed shots from here. "
                              "chip hits the chip set (4 types to 5, 10 and 16 yd). q to finish. ").strip()
        except EOFError:
            break
        if typed.lower() in ("q", "quit"):
            break
        spot_shots = lie_shots_for_spot(spot)
        stimp_typed = re.search(r"\bstimp\s*(\d{1,2}(?:\.\d)?)", typed, re.I)
        if re.search(r"\bchip\b", typed, re.I):
            # Chip set: every chip type to each carry, one shot each. Green firmness comes from GSPro's log;
            # the stimp GSPro does not write anywhere, so it must be typed.
            if stimp_typed:
                labels = {**labels, "stimp": float(stimp_typed[1])}
            if not labels.get("stimp"):
                print("  Type the stimp GSPro is set to with the chip set (chip stimp 11). GSPro does not write it anywhere.")
                continue
            types = chip_types()
            spot_shots = chip_set(types, read_chip_carries(typed))
            print(f"  Chip set at stimp {labels['stimp']:g}: {len(spot_shots)} chips"
                  + ("" if types is not CHIP_TYPES else " (placeholder chip numbers: no chips.json yet)") + ".")
            spot_rows, connected = hit_spot(path, writer, flush, labels=labels, spot=spot, typed=typed, spot_shots=spot_shots,
                                            round_file=round_file, log_file=log_file, db_path=db_path, notes_file=notes_file,
                                            gap=gap, record_wait=record_wait, sleep=sleep, test="chip")
            for line in chip_summary(spot_rows):
                print(line)
            rows.extend(spot_rows)
            if not connected:
                return rows
            spot += 1
            continue
        if typed.lower() == "all" or typed.lower().startswith("all "):
            # One lie, every combination of speed, launch and spin: shows what the penalty depends on.
            typed = typed[3:].strip()
            spot_shots = [(name, {"speed": v["speed"], "vla": v["vla"], "hla": 0.0, "spin": v["spin"], "axis": 0.0})
                          for name, v in designed_shots().items()]
        # "g 145" in the note: also hit the two stock clubs that carry nearest 145 yd, to land shots on the green.
        # "gg 145": only shots at the green, six of them: the same two clubs with less, stock and more spin,
        # so the green sees different landings from one spot.
        stimp_note = re.search(r"\bstimp\s*(\d{1,2}(?:\.\d)?)", typed, re.I)
        if stimp_note:
            labels = {**labels, "stimp": float(stimp_note[1])}  # stays until another stimp is typed
        to_green = re.search(r"\b(gg|g)\s*(\d{2,3})\b", typed, re.I)
        if to_green:
            distance = float(to_green[2])
            nearest = sorted((club for club in BAG if "carry" in BAG[club]), key=lambda club: abs(BAG[club]["carry"] - distance))[:2]
            only_green = to_green[1].lower() == "gg"
            spins = ((0.7, " less spin"), (1.0, ""), (1.25, " more spin")) if only_green else ((1.0, ""),)
            # Each is sped up or slowed down to land on the number typed (see green_speed), stock spin first
            # so the first landing corrects the rest for the hill, the altitude and the lie.
            green_shots = [(f"{club} to green{tag}", {"speed": BAG[club]["speed"], "vla": BAG[club]["vla"], "hla": 0.0,
                                                       "spin": round(BAG[club]["spin"] * factor), "axis": 0.0,
                                                       "_flat_carry": BAG[club]["carry"] * SPIN_CARRY.get(factor, 1.0), "_target": distance})
                           for club in nearest for factor, tag in sorted(spins, key=lambda pair: pair[0] != 1.0)]
            spot_shots = green_shots if only_green else spot_shots + green_shots
        spot_rows, connected = hit_spot(path, writer, flush, labels=labels, spot=spot, typed=typed, spot_shots=spot_shots,
                                        round_file=round_file, log_file=log_file, db_path=db_path, notes_file=notes_file,
                                        gap=gap, record_wait=record_wait, sleep=sleep)
        rows.extend(spot_rows)
        if not connected:
            return rows
        spot += 1
    return rows


# --------------------------------------------------------------------------
# Putt sets: one line per set, like the lie test.
#: Rolled in each set, mph off the face. 8 mph runs about 42 ft at stimp 11 and about 50 ft at stimp 13.
PUTT_SET_SPEEDS_MPH = (2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0)
#: A stimpmeter lets the ball go at about 6 ft/s; the stimp is how many feet it then rolls on the flat.
STIMP_RELEASE_MPH = 4.09
#: Putts of one speed that land this close together count as the same: one a speed is then enough.
PUTT_REPEAT_MATCH_FT = 0.3
PUTT_SLOPES = {"flat": "flat", "level": "flat", "up": "uphill", "uphill": "uphill", "down": "downhill", "downhill": "downhill"}
#: GSPro's Course Type as typed (Brian, 20 Nov: confirm it, with the green firmness, every set).
#: Stored as the range test does: soft = Bentgrass, medium = Bermuda, firm = Links.
PUTT_GRASS = {"bentgrass": "soft", "bent": "soft", "bermuda": "medium", "links": "firm"}
PUTT_FIRMNESS = ("soft", "medium", "firm")
GRASS_NAME = {"soft": "Bentgrass", "medium": "Bermuda", "firm": "Links"}


def read_putt_line(typed: str, state: dict[str, Any]) -> list[str]:
    """Apply one typed line to the putt settings. Returns what it did not understand."""
    unknown: list[str] = []
    words = typed.lower().replace(",", " ").split()
    index = 0
    while index < len(words):
        word = words[index]
        following = words[index + 1] if index + 1 < len(words) else ""
        number = _num(following)
        if word == "stimp" and number is not None and 5 <= number <= 15:
            state["stimp"] = number
            index += 2
        elif word in PUTT_SLOPES:
            state["slope"] = PUTT_SLOPES[word]
            state["slope_deg"] = None
            if number is not None and state["slope"] != "flat" and 0 < number <= 15:
                state["slope_deg"] = number  # what the HUD says, if the player knows it
                index += 1
            index += 1
        elif word == "off" and number is not None and -15 <= number <= 15:
            state["hla"] = number
            index += 2
        elif word == "speeds":
            speeds = []
            index += 1
            while index < len(words) and (value := _num(words[index])) is not None:
                speeds.append(value)
                index += 1
            if speeds and all(0.5 <= speed <= 25 for speed in speeds):
                state["speeds"] = tuple(speeds)
            else:
                unknown.append("speeds")
        elif word in ("twice", "once"):
            state["repeats"] = 2 if word == "twice" else 1
            index += 1
        elif word in PUTT_GRASS:
            state["course_type"] = PUTT_GRASS[word]
            index += 1
        elif word in PUTT_FIRMNESS:
            state["green_firmness"] = word
            index += 1
        else:
            unknown.append(word)
            index += 1
    return unknown


def putt_set_summary(rows: list[dict[str, Any]], slope: str) -> list[str]:
    """What one set showed: the measured slope, the stimp the rolls work out to, and whether repeats matched."""
    good = [row for row in rows if row.get("putt_roll_ft") is not None and not row.get("holed")]
    lines: list[str] = []
    if not good:
        return ["  GSPro recorded none of these putts. Tell Claude which GSPro screen you were on."]
    grades = [row["putt_grade_pct"] for row in good if row.get("putt_grade_pct") is not None]
    if grades:
        grade = sum(grades) / len(grades)
        way = "flat" if abs(grade) < 0.25 else ("uphill" if grade > 0 else "downhill")
        lines.append(f"  Measured slope: {abs(grade):.1f}% {way} ({abs(math.degrees(math.atan(grade / 100.0))):.1f} deg).")
        if way != slope and not (way == "flat" and slope == "flat"):
            lines.append(f"  You typed {slope}. The measured slope is what gets used; nothing to redo.")
    if slope == "flat" and (not grades or abs(sum(grades) / len(grades)) < 0.5):
        implied = [row["putt_roll_ft"] * (STIMP_RELEASE_MPH / row["sent_speed_mph"]) ** 2 for row in good if row["sent_speed_mph"] >= 3]
        if implied:
            lines.append(f"  These rolls work out to about stimp {sum(implied) / len(implied):.1f}.")
    widest, repeated = 0.0, False
    for speed in {row["sent_speed_mph"] for row in good}:
        rolls = [row["putt_roll_ft"] for row in good if row["sent_speed_mph"] == speed]
        if len(rolls) >= 2:
            repeated, widest = True, max(widest, max(rolls) - min(rolls))
    if repeated:
        lines.append(f"  Repeat putts matched to within {widest:.1f} ft."
                     + (" From here each speed is rolled once." if widest <= PUTT_REPEAT_MATCH_FT else " Each speed stays at two putts."))
    holed = sum(1 for row in rows if row.get("holed"))
    if holed:
        lines.append(f"  {holed} went in the hole and can't be used. Type off 5 to start them further off line.")
    return lines


def putt_settings_check(rows: list[dict[str, Any]], course_type: str | None, green_firmness: str | None) -> list[str]:
    """What GSPro's own physics line says these putts were on (GSPro writes it with every putt, 20 Nov).
    Typing the grass and firmness is optional; if typed, it is checked against the log."""
    codes = {"0": "soft", "1": "medium", "2": "firm"}
    logged = {(codes.get(str(row.get("log_course_type"))), codes.get(str(row.get("log_green_firmness")))) for row in rows
              if row.get("log_course_type") not in (None, "") and row.get("log_green_firmness") not in (None, "")}
    if not logged:
        return ["  GSPro's log had no settings line for these putts. Type the grass and firmness (bermuda medium) to record them."]
    if not (course_type and green_firmness):
        seen = ", ".join(f"{GRASS_NAME.get(t or '', '?')} {f}" for t, f in sorted(logged, key=str))
        return [f"  GSPro says: {seen} greens." + ("" if len(logged) == 1 else " (The setting changed during the set.)")]
    if logged == {(course_type, green_firmness)}:
        return [f"  GSPro's log agrees: {GRASS_NAME.get(course_type or '', '?')} {green_firmness} greens."]
    seen = ", ".join(f"{GRASS_NAME.get(t or '', '?')} {f}" for t, f in sorted(logged, key=str))
    return [f"  CHECK GSPRO: its log says {seen}, you typed {GRASS_NAME.get(course_type or '', '?')} {green_firmness}. "
            "Both are in the file; fix the setting or what you typed and roll the set again."]


def putt_session(path: Any, read_line, writer: Any, flush, *, labels: dict[str, Any], round_file: Path, log_file: Path, db_path: Path,
                 notes_file: Path, gap: float, record_wait: float, first_set: int = 1, sleep=time.sleep) -> list[dict[str, Any]]:
    """Set after set of putts from wherever the ball is. One typed line changes what the next set is."""
    rows: list[dict[str, Any]] = []
    state: dict[str, Any] = {"stimp": None, "slope": "flat", "slope_deg": None, "hla": 3.0, "speeds": PUTT_SET_SPEEDS_MPH, "repeats": 1,
                             "course_type": None, "green_firmness": None}
    number = first_set
    while True:
        speeds = state["speeds"]
        if state["slope"] == "downhill" and speeds == PUTT_SET_SPEEDS_MPH:
            speeds = speeds[:-1]  # the fastest would run off most greens downhill
        count = len(speeds) * state["repeats"]
        slope_text = state["slope"] + (f" {state['slope_deg']:g} deg" if state["slope_deg"] else "")
        green_text = (f", {GRASS_NAME[state['course_type']]} {state['green_firmness']} greens"
                      if state["course_type"] and state["green_firmness"] else "")
        have = (f"stimp {state['stimp']:g}" if state["stimp"] else "NO STIMP YET") + f"{green_text}, {slope_text}"
        try:
            typed = read_line(f"\nPutt set {number} ({have}): Enter to roll {count} putts, {speeds[0]:g} to {speeds[-1]:g} mph. "
                              "Type what changed first: stimp 11, then flat, up or down (up 2 if you know the degrees). "
                              "q to finish. ").strip()
        except EOFError:
            break
        if typed.lower() in ("q", "quit"):
            break
        unknown = read_putt_line(typed, state) if typed else []
        if unknown:
            print(f"  Did not understand: {' '.join(unknown)}. Use: bentgrass / bermuda / links, soft / medium / firm, "
                  "stimp 11 / flat / up / down / up 2 / off 5 / speeds 2 4 6 / twice / once.")
            continue
        if typed:
            continue  # show the new settings in the prompt; Enter alone rolls the set
        if not state["stimp"]:
            print("  Type the stimp GSPro is set to first (stimp 11). GSPro does not write it anywhere.")
            continue
        speeds = state["speeds"][:-1] if state["slope"] == "downhill" and state["speeds"] == PUTT_SET_SPEEDS_MPH else state["speeds"]
        set_rows: list[dict[str, Any]] = []
        shots = [speed for speed in speeds for _ in range(state["repeats"])]
        for index, speed in enumerate(shots, start=1):
            shot = {"speed": speed, "vla": 0.0, "hla": state["hla"], "spin": 0.0, "axis": 0.0}
            before_record = record_fingerprint(newest_round_record(round_file))
            before_log = log_size(log_file)
            before_row = latest_row_safely(db_path)
            sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            try:
                status = path.fire(shot)
            except (ConnectionError, OSError) as exc:
                print(f"  could not send: {exc}")
                return rows + set_rows
            if "at rest" not in status:
                print(f"  (no ball-at-rest from GSPro; waiting {NO_STOP_SIGNAL_WAIT_S:g} s for the putt to finish)")
                sleep(NO_STOP_SIGNAL_WAIT_S)
            measured = measure_putt(wait_for_new_record(round_file, before_record, record_wait, sleep=sleep))
            if measured.get("putt_roll_ft") is None:
                # Practice greens list putts in GSPro's shot table instead (total distance, in yards).
                found = wait_for_new_row(db_path, before_row[0] if before_row else None, 2.0, sleep=sleep)
                total = _num(found[1].get("TotalDistance")) if found else None
                if found and total is not None:
                    measured = {**measured, "db_id": found[0], "putt_roll_ft": round(total * 3.0, 2),
                                "gspro_speed_mph": _num(found[1].get("BallSpeed"))}
            log_text = read_log_since(log_file, before_log)
            from_log = {key: value for key, value in lie_from_log(log_text).items() if key.startswith("log_")}
            row = {"test": "putt", **labels, "stimp": state["stimp"], "course_type": state["course_type"],
                   "green_firmness": state["green_firmness"], "slope": state["slope"], "slope_deg_typed": state["slope_deg"],
                   "spot": number, "note": slope_text, "club": f"{speed:g} mph", "n": index, "status": status,
                   "sent_speed_mph": speed, "sent_vla_deg": 0.0, "sent_spin_rpm": 0.0, "sent_hla_deg": state["hla"], "sent_at": sent_at,
                   **measured, **from_log}
            writer.writerow(row)
            flush()
            set_rows.append(row)
            try:
                kept = [line.strip()[:300] for line in log_text.splitlines() if LOG_KEEP_RE.search(line)][:20]
                with notes_file.open("a", encoding="utf-8") as notes:
                    notes.write(f"--- putt set {number} putt {index} ({speed:g} mph) {sent_at} {have}\n" + "\n".join(kept) + "\n")
            except OSError:
                pass
            if row.get("putt_roll_ft") is None:
                print(f"  {index:>2}/{len(shots)}  {speed:>4g} mph  not recorded by GSPro   [{status}]")
            else:
                grade = row.get("putt_grade_pct")
                hill = "" if grade is None else f", {abs(grade):.1f}% {'up' if grade > 0 else 'down'}" if abs(grade) >= 0.25 else ", level"
                holed = "  (HOLED: roll cut short, not usable)" if row.get("holed") else ""
                print(f"  {index:>2}/{len(shots)}  {speed:>4g} mph  rolled {row['putt_roll_ft']:5.1f} ft{hill}{holed}")
            sleep(gap)
        rows.extend(set_rows)
        for line in putt_set_summary(set_rows, state["slope"]):
            print(line)
        for line in putt_settings_check(set_rows, state["course_type"], state["green_firmness"]):
            print(line)
        if state["repeats"] == 2:
            matched = [max(r) - min(r) for r in ([row["putt_roll_ft"] for row in set_rows if row["sent_speed_mph"] == speed
                                                   and row.get("putt_roll_ft") is not None and not row.get("holed")] for speed in speeds) if len(r) >= 2]
            if matched and max(matched) <= PUTT_REPEAT_MATCH_FT:
                state["repeats"] = 1
        number += 1
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
    putt_sets = 0
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
                    ("putt", "Putt roll: sets of putts on a green, flat, uphill or downhill, at each stimp"),
                    ("lie", "Shots from a lie: drop the ball anywhere in On Course practice, 3 shots per spot"),
                    ("wander", "Wander: the tool moves the ball round the hole itself and hits 3 shots per spot (On Course practice)"),
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
                labels: dict[str, Any] = {}
                if test != "putt":  # the putt test reads the course type and firmness from GSPro's log
                    answers["type"] = choose(read_line, "\nCourse Type set in GSPro right now?", TYPE_OPTIONS, answers["type"])
                    labels = {"course_type": answers["type"]}
                if test == "putt":
                    print("\nGSPro should be in On Course practice with the ball on a green, and room for a putt to roll out.")
                    print("Each set rolls putts from 2 to 8 mph, started a little off line so they miss the hole.")
                    print("Type the stimp GSPro is set to (stimp 11), and flat, up or down when you move. Then Enter rolls the")
                    print("set: one putt a speed (GSPro repeats itself exactly). Grass and green firmness come from GSPro's log;")
                    print("each set ends with what GSPro says they were. To change the stimp: change it in GSPro, type it here.")
                    notes_file = out.with_name(out.stem + "_log.txt")
                    rows = putt_session(path, read_line, writer, handle.flush, labels=labels, round_file=round_file, log_file=log_file,
                                        db_path=db_path, notes_file=notes_file, gap=1.0, record_wait=8.0, first_set=putt_sets + 1, sleep=sleep)
                    total += len(rows)
                    putt_sets = max([putt_sets] + [int(row["spot"]) for row in rows])
                    print(f"\nSaved so far: {total} shots in {out.name} (GSPro's log lines in {notes_file.name}).\n")
                    continue
                if test == "wander":
                    import wander as wander_tool
                    print("\nGSPro in On Course practice, any hole, minimap showing. The Looper Companion running (it reads")
                    print("the slope under the ball). It works down the hole: from the tee it steps forward, then takes")
                    print("spots across the hole before each step; inside 50 yd (or after a par 3's tee shots) it picks the")
                    print("next hole with the flag button. GSPro should be full screen: the buttons are found by position.")
                    print("To stop: move the mouse. About 45 seconds a spot.")
                    side = choose(read_line, "Which side is GSPro's minimap on?", [("right", "Right"), ("left", "Left")],
                                  answers.get("side", "right"))
                    answers["side"] = side
                    typed = read_line("Which hole is the ball on? It moves on to the next hole by itself. (Enter for 1) ").strip()
                    hole = int(typed) if typed.isdigit() and 1 <= int(typed) <= 18 else 1
                    typed = read_line("How many spots? Enter for 3 (a quick check that the clicks move the ball); "
                                      "150 is about 2 hours. ").strip()
                    spots = int(typed) if typed.isdigit() and int(typed) > 0 else 3
                    try:
                        desktop = wander_tool.Desktop()
                    except OSError as exc:
                        print(exc)
                        continue
                    print("Starting in 5 seconds. Hands off the mouse.")
                    sleep(5)
                    notes_file = out.with_name(out.stem + "_log.txt")
                    rows = wander_tool.wander(path, writer, handle.flush, desktop=desktop, spots=spots, shots_per_spot=3,
                                              side=side, labels={**labels, "test": "wander"}, round_file=round_file,
                                              log_file=log_file, db_path=db_path, notes_file=notes_file,
                                              first_spot=lie_spots + 1, sleep=sleep, hole=hole)
                    total += len(rows)
                    lie_spots = max([lie_spots] + [int(row["spot"]) for row in rows])
                    print()
                    for line in lie_summary(rows):
                        print(line)
                    print(f"\nSaved so far: {total} shots in {out.name} (GSPro's log lines in {notes_file.name}).\n")
                    continue
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
        # Double-clicked: a crash would close the window before anyone could read it, so the
        # error is printed, saved next to this file, and the window waits for Enter.
        try:
            return guided()  # ask questions
        except KeyboardInterrupt:
            return 130
        except Exception:  # noqa: BLE001
            import traceback
            text = traceback.format_exc()
            print("\nThe shot tool hit an error and stopped:\n")
            print(text)
            crash = HERE / f"looper_crash_{time.strftime('%Y%m%d_%H%M%S')}.txt"
            try:
                crash.write_text(text, encoding="utf-8")
                print(f"Saved as {crash.name}. Send it to Claude.")
            except OSError:
                pass
            try:
                input("Press Enter to close. ")
            except EOFError:
                pass
            return 1
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
