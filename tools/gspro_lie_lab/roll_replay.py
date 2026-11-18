#!/usr/bin/env python3
"""Looper roll replay: hit each club's stock shot on the GSPro range and record how far it rolls.

GSPro 4.1.9 changed bounce and roll, and added Course Type and Fairway Firmness.
Roll depends only on how the ball leaves the face (speed, launch, spin), and
Looper already knows that for every club in the bag. This fires each club's
stock shot into the Practice Range, with no swing, and records carry, total and
roll as GSPro plays them now.

  python roll_replay.py
  python roll_replay.py --type firm --fairway firm
  python roll_replay.py --clubs Driver,7i,PW --repeats 5

Put this file in the same folder as test_shots.py and open_connect.py.

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


def main(argv: list[str] | None = None) -> int:
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
