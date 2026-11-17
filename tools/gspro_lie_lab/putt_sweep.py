#!/usr/bin/env python3
"""Looper putt sweep: roll a set of putts at exact speeds and record how far each goes.

For measuring how a GSPro green behaves (how far a putt rolls for its speed, and
what uphill and downhill do to that) without a putter in your hand. Every putt
is sent at an exact speed straight down the current aim line, so the only thing
that changes between putts is the speed, and between runs the green.

  python putt_sweep.py --label "normal flat"
  python putt_sweep.py --label "normal uphill" --speeds 3,5,7,9 --repeats 3

Put this file in the same folder as test_shots.py. As with test_shots.py,
CLOSE THE UNEEKOR LAUNCHER FIRST, have GSPro on a green ready for a putt, then
run it.

What it does, per putt:
  1. sends the putt (ball speed in mph, no loft, no spin),
  2. waits for GSPro's "ball at rest",
  3. reads GSPro's own record of the putt (where it started and stopped) and
     writes one row to putt_sweep_<time>.csv next to this file.

By default it stops before every putt so you can put the ball back (Mulligan,
or just let GSPro move on) and press Enter. Use --auto to fire them back to
back when GSPro resets the ball for you.

Options:
  --speeds 2,3,4,5,6,8,10   ball speeds in mph (default)
  --repeats 3               times each speed is rolled (default 3)
  --hla 0                   start direction in degrees; negative is left. Use a
                            few degrees to miss the hole on purpose so the
                            putt rolls out and is not swallowed by the cup.
  --label "normal flat"     written on every row: the green setting and slope
  --auto                    do not wait for Enter between putts

At the end it prints the average roll for each speed. Send the csv to Claude.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from test_shots import OPEN_CONNECT_PORT, UNEEKOR_HOST, UNEEKOR_PORT, OpenConnectPath, pause_before_close  # noqa: E402

M_TO_FT = 3.280839895
M_TO_IN = 39.37007874
FIELDS = [
    "label", "n", "sent_speed_mph", "sent_hla_deg", "status",
    "roll_ft", "height_change_in", "start_to_cup_ft", "holed", "gspro_speed", "target_direction_deg",
    "log_roll_ft", "shot_id", "start_x", "start_y", "start_z", "end_x", "end_y", "end_z", "sent_at",
]


def gspro_folder() -> Path:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    return home / "AppData" / "LocalLow" / "GSPro" / "GSPro"


def _xyz(value: Any) -> tuple[float, float, float] | None:
    try:
        return float(value["x"]), float(value["y"]), float(value["z"])
    except (KeyError, TypeError, ValueError):
        return None


def newest_record(folder: Path) -> dict[str, Any] | None:
    """The latest shot in GSPro's currentRound.dat, or None if it can't be read."""
    try:
        parsed = json.loads((folder / "currentRound.dat").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    candidates: list[Any] = parsed if isinstance(parsed, list) else [
        item for value in (parsed.values() if isinstance(parsed, dict) else []) if isinstance(value, list) for item in value]
    shots = [c for c in candidates if isinstance(c, dict) and c.get("ShotID") and isinstance(c.get("GlobalShotNumber"), (int, float))]
    return max(shots, key=lambda c: c["GlobalShotNumber"]) if shots else None


def last_log_roll_ft(folder: Path, offset: int) -> tuple[float | None, int]:
    """The last "Roll dist ft" GSPro logged after byte `offset`, and the new end of the log."""
    path = folder / "output_log.txt"
    try:
        size = path.stat().st_size
        if size < offset:
            offset = 0
        with path.open("rb") as handle:
            handle.seek(offset)
            text = handle.read().decode("utf-8", "replace")
    except OSError:
        return None, offset
    matches = re.findall(r"Roll dist ft\s*([-+]?\d+(?:\.\d+)?)", text)
    return (float(matches[-1]) if matches else None), size


def measure(record: dict[str, Any] | None) -> dict[str, Any]:
    """Roll, height change and the rest, from GSPro's record of one putt."""
    if not record:
        return {}
    start, end = _xyz(record.get("StartingPOS")), _xyz(record.get("EndingPOS"))
    shot_data = ((record.get("activeShot") or {}).get("sd")) or ((record.get("GhostData") or {}).get("atShotData")) or {}
    cup = _xyz(shot_data.get("tdpoint"))
    row: dict[str, Any] = {
        "shot_id": record.get("ShotID"),
        "gspro_speed": record.get("BallSpeed"),
        "holed": bool(shot_data.get("isHoled")),
        "target_direction_deg": shot_data.get("TargetDirection"),
    }
    if start and end:
        row.update({
            "roll_ft": round(math.hypot(end[0] - start[0], end[2] - start[2]) * M_TO_FT, 2),
            "height_change_in": round((end[1] - start[1]) * M_TO_IN, 1),
            "start_x": start[0], "start_y": start[1], "start_z": start[2],
            "end_x": end[0], "end_y": end[1], "end_z": end[2],
        })
    if start and cup:
        row["start_to_cup_ft"] = round(math.hypot(cup[0] - start[0], cup[2] - start[2]) * M_TO_FT, 2)
    return row


def plan(speeds: list[float], repeats: int) -> list[float]:
    """Speeds in rounds (2,3,4, 2,3,4, ...) so a drift over time is not mistaken for a speed effect."""
    return [speed for _ in range(repeats) for speed in speeds]


def summarize(rows: list[dict[str, Any]]) -> list[str]:
    lines = []
    by_speed: dict[float, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("roll_ft") is not None and not row.get("holed"):
            by_speed.setdefault(row["sent_speed_mph"], []).append(row)
    for speed in sorted(by_speed):
        rolls = [r["roll_ft"] for r in by_speed[speed]]
        heights = [r.get("height_change_in") or 0.0 for r in by_speed[speed]]
        spread = max(rolls) - min(rolls)
        lines.append(f"  {speed:>5.1f} mph: rolled {sum(rolls) / len(rolls):6.1f} ft on average "
                     f"({len(rolls)} putts, {spread:.1f} ft between shortest and longest, "
                     f"{sum(heights) / len(heights):+.1f} in. height change)")
    return lines


def run(args: argparse.Namespace, read_line=input) -> int:
    speeds = [float(part) for part in str(args.speeds).split(",") if part.strip()]
    if not speeds or any(not 0.5 <= speed <= 25 for speed in speeds):
        print("Speeds must be between 0.5 and 25 mph, for example --speeds 2,3,4,5,6,8,10")
        return 2
    folder = gspro_folder()
    ports = [args.port] if args.port else [UNEEKOR_PORT, OPEN_CONNECT_PORT]
    path = OpenConnectPath(args.host, ports, args.api_version, args.timeout)
    putts = plan(speeds, args.repeats)
    out = HERE / f"putt_sweep_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    print(f"{len(putts)} putts ({args.repeats} each at {', '.join(f'{s:g}' for s in speeds)} mph), label \"{args.label}\".")
    print(f"Results go to {out.name}\n")
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3

    rows: list[dict[str, Any]] = []
    _, log_offset = last_log_roll_ft(folder, 0)
    try:
        with out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
            writer.writeheader()
            for index, speed in enumerate(putts, start=1):
                if not args.auto:
                    try:
                        answer = read_line(f"Putt {index} of {len(putts)}: {speed:g} mph. Ball ready? Enter to roll it, q to stop. ")
                    except EOFError:
                        break
                    if answer.strip().lower() in ("q", "quit", "exit"):
                        break
                before = newest_record(folder)
                before_id = before.get("ShotID") if before else None
                shot = {"speed": speed, "vla": 0.0, "hla": args.hla, "spin": 0.0, "axis": 0.0}
                sent_at = time.strftime("%Y-%m-%dT%H:%M:%S")
                try:
                    status = path.fire(shot)
                except (ConnectionError, OSError) as exc:
                    print(f"  could not send: {exc}")
                    break
                # GSPro writes the record a moment after the ball stops.
                record = None
                deadline = time.time() + 6.0
                while time.time() < deadline:
                    latest = newest_record(folder)
                    if latest and latest.get("ShotID") != before_id:
                        record = latest
                        break
                    time.sleep(0.25)
                log_roll, log_offset = last_log_roll_ft(folder, log_offset)
                row = {"label": args.label, "n": index, "sent_speed_mph": speed, "sent_hla_deg": args.hla,
                       "status": status, "log_roll_ft": log_roll, "sent_at": sent_at, **measure(record)}
                if row.get("roll_ft") is None and log_roll is not None:
                    row["roll_ft"] = log_roll  # no round record (some practice modes): GSPro's log has the roll
                writer.writerow(row)
                handle.flush()
                rows.append(row)
                roll = f"{row['roll_ft']:.1f} ft" if row.get("roll_ft") is not None else "roll not recorded"
                height = f", {row['height_change_in']:+.1f} in." if row.get("height_change_in") is not None else ""
                holed = " (HOLED: roll cut short, not counted)" if row.get("holed") else ""
                print(f"  {speed:g} mph -> {roll}{height}{holed}   [{status}]")
                if args.auto:
                    time.sleep(args.gap)
    except KeyboardInterrupt:
        print()
    finally:
        path.close()

    print(f"\n{len(rows)} putts recorded in {out}")
    for line in summarize(rows):
        print(line)
    if rows and all(row.get("roll_ft") is None for row in rows):
        print("GSPro did not record a roll for any putt. Tell Claude which GSPro screen you were on.")
    pause_before_close(read_line)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--speeds", default="2,3,4,5,6,8,10", help="Ball speeds in mph, comma separated")
    p.add_argument("--repeats", type=int, default=3, help="Times each speed is rolled")
    p.add_argument("--hla", type=float, default=0.0, help="Start direction in degrees (negative is left)")
    p.add_argument("--label", default="unlabelled", help="Green setting and slope, e.g. \"normal flat\"")
    p.add_argument("--auto", action="store_true", help="Fire back to back without waiting for Enter")
    p.add_argument("--gap", type=float, default=2.0, help="Seconds between putts with --auto")
    p.add_argument("--host", default=UNEEKOR_HOST)
    p.add_argument("--port", type=int, default=0, help="Use only this port")
    p.add_argument("--api-version", default="2")
    p.add_argument("--timeout", type=float, default=45.0, help="Seconds to wait for GSPro's ball-at-rest")
    return run(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
