#!/usr/bin/env python3
"""Looper test shots: hit GSPro shots from the keyboard, no swing.

For testing Looper on the sim without hitting balls. Type a club and press
Enter: GSPro gets Brian's stock ball data for that club, straight down the
current aim line (so after Auto Aim it flies at Looper's target).

  python test_shots.py              connect and type shots (or double-click it, open with Python)
  python test_shots.py --api-version 2

At the prompt:
  7i                stock 7-iron (any club in the bag: Driver 3H 5i 6i 7i 8i 9i PW GW SW LW)
  155               a 155-yard carry (the club that gets there, swing eased off)
  7i L / 7i R       start it 3 degrees left / right (LL / RR for 6)
  7i draw / fade    curve it (hook / slice for more)
  7i 90%            a softer swing (ball speed x 0.9)
  raw 110 17 6000 [hla] [axis]   any ball data: mph, launch deg, spin rpm, start deg, axis deg
  bag               list the stock numbers
  q                 disconnect and quit

On the green, concede the hole in GSPro rather than putting.

Close the Uneekor launcher first: GSPconnect takes one launch monitor at a
time, and this connects in its place on 127.0.0.1:921. Reopen it to hit real
balls again. Shots fired here land in Looper's round like real ones; tell
Claude which rounds were tests so they're left out of your stats.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from open_connect import DEFAULT_HOST, DEFAULT_PORT, Launch, OpenConnectClient, OpenConnectError  # noqa: E402

# Brian's stock shots: median of the middle-50% carry band of included,
# untagged shots per club in Supabase `shots` (4 Nov 2026; same method as
# plan.STOCK). Carry/total are calm and flat, for reference only.
BAG: dict[str, dict[str, float]] = {
    "Driver": {"speed": 143.8, "vla": 11.1, "spin": 2812, "carry": 232.9, "total": 249.1},
    "3H": {"speed": 134.2, "vla": 8.7, "spin": 4701, "carry": 196.2, "total": 209.2},
    "5i": {"speed": 123.5, "vla": 12.0, "spin": 5280, "carry": 177.3, "total": 188.1},
    "6i": {"speed": 121.5, "vla": 14.4, "spin": 5031, "carry": 178.2, "total": 188.4},
    "7i": {"speed": 113.1, "vla": 16.4, "spin": 6175, "carry": 157.6, "total": 166.0},
    "8i": {"speed": 105.7, "vla": 17.7, "spin": 7029, "carry": 144.3, "total": 146.9},
    "9i": {"speed": 102.9, "vla": 19.3, "spin": 7804, "carry": 137.1, "total": 144.1},
    "PW": {"speed": 94.4, "vla": 22.4, "spin": 8646, "carry": 120.4, "total": 125.3},
    "GW": {"speed": 88.7, "vla": 24.9, "spin": 9702, "carry": 110.0, "total": 114.6},
    "SW": {"speed": 78.6, "vla": 26.6, "spin": 9856, "carry": 88.6, "total": 90.8},
    "LW": {"speed": 75.6, "vla": 27.7, "spin": 10856, "carry": 84.1, "total": 87.1},
}

ALIASES = {"d": "Driver", "dr": "Driver", "drv": "Driver", "driver": "Driver", "3h": "3H", "h": "3H", "hybrid": "3H"}
for _club in BAG:
    ALIASES.setdefault(_club.lower(), _club)
for _n in range(5, 10):
    if f"{_n}i" in BAG:
        ALIASES.setdefault(str(_n), f"{_n}i")

# GSPro: negative HLA starts left; negative spin axis curves left (right-hander).
START = {"l": -3.0, "r": 3.0, "ll": -6.0, "rr": 6.0}
CURVE = {"draw": -6.0, "fade": 6.0, "hook": -15.0, "slice": 15.0}
CARRY_POWER = 1.15  # carry ~ speed^1.15 for small changes; close enough for a test shot
MIN_SPEED_MUL = 0.5


class ShotError(ValueError):
    pass


def club_for_carry(target: float) -> tuple[str, float]:
    """The shortest club that carries the target, and the speed multiplier to get there."""
    reach = [(c, s) for c, s in BAG.items() if s["carry"] >= target]
    if not reach:
        return "Driver", 1.0
    club, stock = min(reach, key=lambda cs: cs[1]["carry"])
    mul = (target / stock["carry"]) ** (1 / CARRY_POWER)
    return club, max(MIN_SPEED_MUL, mul)


def parse(text: str) -> dict[str, Any]:
    """One typed line -> a shot: club, label, ball speed, VLA, spin, HLA, spin axis."""
    words = text.strip().split()
    if not words:
        raise ShotError("Type a club (7i), a carry (155) or 'q'.")
    head, rest = words[0].lower(), words[1:]
    if head == "raw":
        try:
            nums = [float(w) for w in rest]
        except ValueError as exc:
            raise ShotError("raw needs numbers: raw mph launch spin [start] [axis]") from exc
        if len(nums) < 3:
            raise ShotError("raw needs at least: raw mph launch spin")
        nums += [0.0] * (5 - len(nums))
        return {"club": "raw", "label": "raw ball data", "speed": nums[0], "vla": nums[1],
                "spin": nums[2], "hla": nums[3], "axis": nums[4]}
    if re.fullmatch(r"\d+(\.\d+)?", head) and head not in ALIASES:
        target = float(head)
        club, mul = club_for_carry(target)
        label = f"{target:.0f} yd carry: {club} at {mul * 100:.0f}%"
        if mul == 1.0 and BAG[club]["carry"] < target:
            label = f"{target:.0f} yd is past your driver; stock Driver"
    else:
        club = ALIASES.get(head)
        if club is None:
            raise ShotError(f"'{words[0]}' isn't a club in the bag ({' '.join(BAG)}).")
        mul = 1.0
        label = f"stock {club}"
    hla = axis = 0.0
    swing = 1.0
    for word in rest:
        w = word.lower()
        if w in START:
            hla = START[w]
        elif w in CURVE:
            axis = CURVE[w]
        elif re.fullmatch(r"\d+(\.\d+)?%", w):
            swing = float(w[:-1]) / 100
        else:
            raise ShotError(f"Don't know '{word}'. Try L, R, LL, RR, draw, fade, hook, slice or 90%.")
    stock = BAG[club]
    mul *= swing
    extras = [x for x in (
        f"{swing * 100:.0f}% swing" if swing != 1.0 else "",
        f"{abs(hla):.0f}° {'left' if hla < 0 else 'right'}" if hla else "",
        next((k for k, v in CURVE.items() if v == axis), "") if axis else "",
    ) if x]
    if extras:
        label += ", " + ", ".join(extras)
    return {"club": club, "label": label, "speed": round(stock["speed"] * mul, 1), "vla": stock["vla"],
            "spin": round(stock["spin"]), "hla": hla, "axis": axis}


def describe(shot: dict[str, Any]) -> str:
    return (f"{shot['speed']:.1f} mph, {shot['vla']:.1f}° up, {shot['spin']:.0f} rpm"
            + (f", start {shot['hla']:+.0f}°" if shot["hla"] else "")
            + (f", axis {shot['axis']:+.0f}°" if shot["axis"] else ""))


def print_bag() -> None:
    print("Club    mph  launch   spin  carry  total  (calm, flat)")
    for club, s in BAG.items():
        print(f"{club:<6} {s['speed']:5.1f}  {s['vla']:5.1f}  {s['spin']:5.0f}  {s['carry']:5.0f}  {s['total']:5.0f}")


def run(args: argparse.Namespace, read_line=input) -> int:
    print(__doc__.split("At the prompt:")[1].split("Close the Uneekor")[0].rstrip())
    print(f"\nConnecting to GSPro at {args.host}:{args.port} (API version {args.api_version}) ...")
    try:
        client = OpenConnectClient(args.host, args.port, api_version=args.api_version)
        client.connect()
    except OpenConnectError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3
    print("Connected. GSPro should show a launch monitor as ready.\n")
    try:
        while True:
            try:
                line = read_line("shot> ")
            except EOFError:
                break
            if line.strip().lower() in ("q", "quit", "exit"):
                break
            if line.strip().lower() == "bag":
                print_bag()
                continue
            if not line.strip():
                continue
            try:
                shot = parse(line)
            except ShotError as exc:
                print(exc)
                continue
            launch = Launch(ballSpeedMph=shot["speed"], vlaDeg=shot["vla"], hlaDeg=shot["hla"],
                            spinRpm=shot["spin"], spinAxisDeg=shot["axis"])
            try:
                result = client.fire(launch, wait_for_stop_s=args.timeout, is_done=lambda: True)
            except OSError as exc:
                print(f"Lost the connection to GSPro ({exc}). Run this again.")
                return 4
            codes = [r.get("Code") for r in result["replies"]]
            errors = [r for r in result["replies"] if isinstance(r.get("Code"), int) and r["Code"] >= 500]
            if errors:
                print(f"GSPro refused it: {errors[0].get('Message') or errors[0]}")
            elif result["gotReceived"]:
                print(f"Hit: {shot['label']} ({describe(shot)})")
            else:
                print(f"GSPro didn't confirm the shot (replies: {codes or 'none'}). If the ball didn't move, check GSPro is waiting for a shot.")
            time.sleep(0.2)
    except KeyboardInterrupt:
        print()
    finally:
        client.close()
        print("Disconnected. Reopen the Uneekor launcher to hit real balls.")
        pause_before_close(read_line)
    return 0


def pause_before_close(read_line=input) -> None:
    """Opened by double-click, the window closes on exit: keep the last message on screen."""
    try:
        read_line("Press Enter to close.")
    except (EOFError, KeyboardInterrupt):
        pass


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--api-version", default="1", help="Open Connect API version (1 or 2)")
    p.add_argument("--timeout", type=float, default=6.0, help="Seconds to wait for GSPro to take a shot")
    return run(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
