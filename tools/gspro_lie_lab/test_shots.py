#!/usr/bin/env python3
"""Looper test shots: hit GSPro shots from the keyboard, no swing.

For testing Looper on the sim without hitting balls. Type a club and press
Enter: GSPro gets Brian's stock ball data for that club, straight down the
current aim line (so after Auto Aim it flies at Looper's target).

  double-click test_shots.py (open with Python), or: python test_shots.py

At the prompt:
  7i                stock 7-iron (any club in the bag: Driver 3H 5i 6i 7i 8i 9i PW GW SW LW)
  155               a 155-yard carry (the club that gets there, swing eased off)
  7i L / 7i R       start it 3 degrees left / right (LL / RR for 6)
  7i draw / fade    curve it (hook / slice for more)
  7i 90%            a softer swing (ball speed x 0.9)
  raw 110 17 6000 [hla] [axis]   any ball data: mph, launch deg, spin rpm, start deg, axis deg
  bag               list the stock numbers
  q                 quit

On the green, concede the hole in GSPro rather than putting.

How shots get to GSPro: the same way the Uneekor's do. Brian's sim runs
Uneekor launcher -> GSPconnect (127.0.0.1:59002) -> GSPro, so each shot is the
EYE MINI LITE packet GSPconnect already accepts (from the September calibration
harness, tools/uneekor_gspconnect_smoke.py on gspro-lie-calibration-harness-v1).
Leave the Uneekor launcher and GSPro as they are. GSPconnect sends no reply on
this path, so watch GSPro for the ball. `--via openconnect` uses GSPro Open
Connect on port 921 instead (only when GSPro is set to an Open API monitor).

Shots fired here land in Looper's round like real ones; tell Claude which
rounds were tests so they're left out of your stats.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import socket
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

UNEEKOR_HOST = "127.0.0.1"
UNEEKOR_PORT = 59002
UNEEKOR_DEVICE = "UNEEKOR EYEMINILITE"
OPEN_CONNECT_PORT = 921

# Brian's stock shots: median of the middle-50% carry band of included,
# untagged shots per club in Supabase `shots` (4 Nov 2026; same method as
# plan.STOCK). Club speed is the same band's median; attack angle isn't
# recorded on these clubs, so it's a typical value. Carry/total are calm and
# flat, for reference only.
BAG: dict[str, dict[str, float]] = {
    "Driver": {"speed": 143.8, "vla": 11.1, "spin": 2812, "carry": 232.9, "total": 249.1, "club": 97.6, "aoa": 0.0},
    "3H": {"speed": 134.2, "vla": 8.7, "spin": 4701, "carry": 196.2, "total": 209.2, "club": 97.9, "aoa": -2.0},
    "5i": {"speed": 123.5, "vla": 12.0, "spin": 5280, "carry": 177.3, "total": 188.1, "club": 89.8, "aoa": -3.5},
    "6i": {"speed": 121.5, "vla": 14.4, "spin": 5031, "carry": 178.2, "total": 188.4, "club": 87.6, "aoa": -3.5},
    "7i": {"speed": 113.1, "vla": 16.4, "spin": 6175, "carry": 157.6, "total": 166.0, "club": 83.5, "aoa": -4.0},
    "8i": {"speed": 105.7, "vla": 17.7, "spin": 7029, "carry": 144.3, "total": 146.9, "club": 79.3, "aoa": -4.0},
    "9i": {"speed": 102.9, "vla": 19.3, "spin": 7804, "carry": 137.1, "total": 144.1, "club": 77.6, "aoa": -4.5},
    "PW": {"speed": 94.4, "vla": 22.4, "spin": 8646, "carry": 120.4, "total": 125.3, "club": 72.6, "aoa": -4.5},
    "GW": {"speed": 88.7, "vla": 24.9, "spin": 9702, "carry": 110.0, "total": 114.6, "club": 71.1, "aoa": -5.0},
    "SW": {"speed": 78.6, "vla": 26.6, "spin": 9856, "carry": 88.6, "total": 90.8, "club": 63.4, "aoa": -5.0},
    "LW": {"speed": 75.6, "vla": 27.7, "spin": 10856, "carry": 84.1, "total": 87.1, "club": 61.1, "aoa": -5.0},
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


def nearest_club(ball_speed: float) -> str:
    return min(BAG, key=lambda c: abs(BAG[c]["speed"] - ball_speed))


def parse(text: str) -> dict[str, Any]:
    """One typed line -> a shot: label, ball data, club speed/AoA and the calm carry it should fly."""
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
        near = BAG[nearest_club(nums[0])]
        ratio = nums[0] / near["speed"]
        return {"club": "raw", "label": "raw ball data", "speed": nums[0], "vla": nums[1],
                "spin": nums[2], "hla": nums[3], "axis": nums[4],
                "clubSpeed": round(near["club"] * ratio, 1), "aoa": near["aoa"],
                "carry": round(near["carry"] * ratio ** CARRY_POWER, 1)}
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
            "spin": round(stock["spin"]), "hla": hla, "axis": axis,
            "clubSpeed": round(stock["club"] * mul, 1), "aoa": stock["aoa"],
            "carry": round(stock["carry"] * mul ** CARRY_POWER, 1)}


def describe(shot: dict[str, Any]) -> str:
    return (f"{shot['speed']:.1f} mph, {shot['vla']:.1f}° up, {shot['spin']:.0f} rpm"
            + (f", start {shot['hla']:+.0f}°" if shot["hla"] else "")
            + (f", axis {shot['axis']:+.0f}°" if shot["axis"] else ""))


def print_bag() -> None:
    print("Club    mph  launch   spin  carry  total  club mph  (calm, flat)")
    for club, s in BAG.items():
        print(f"{club:<6} {s['speed']:5.1f}  {s['vla']:5.1f}  {s['spin']:5.0f}  {s['carry']:5.0f}  {s['total']:5.0f}"
              f"   {s['club']:5.1f}")


# -- Uneekor path: GSPconnect on 59002 -------------------------------------------

def uneekor_packet(shot: dict[str, Any], shot_number: int) -> dict[str, Any]:
    """The EYE MINI LITE API v2 shot GSPconnect receives from the Uneekor launcher.

    Same shape as tools/uneekor_gspconnect_smoke.py (from GSPconnect's
    ConnectDebug.txt): TotalSpin 0 with back/side spin filled in, CarryDistance
    present, club data present, LaunchMonitorIsReady false.
    """
    radians = math.radians(shot["axis"])
    return {
        "DeviceID": UNEEKOR_DEVICE,
        "Units": "Yards",
        "ShotNumber": shot_number,
        "APIversion": "2",
        "BallData": {
            "Speed": shot["speed"],
            "SpinAxis": shot["axis"],
            "TotalSpin": 0.0,
            "BackSpin": round(shot["spin"] * math.cos(radians), 1),
            "SideSpin": round(shot["spin"] * math.sin(radians), 1),
            "HLA": shot["hla"],
            "VLA": shot["vla"],
            "CarryDistance": shot["carry"],
        },
        "ClubData": {
            "Speed": shot["clubSpeed"],
            "AngleOfAttack": shot["aoa"],
            "FaceToTarget": 0.0,
            "Lie": 0.0,
            "Loft": 0.0,
            "Path": 0.0,
            "SpeedAtImpact": shot["clubSpeed"],
            "VerticalFaceImpact": 0.0,
            "HorizontalFaceImpact": 0.0,
        },
        "ShotDataOptions": {
            "ContainsBallData": True,
            "ContainsClubData": True,
            "LaunchMonitorIsReady": False,
            "LaunchMonitorBallDetected": True,
            "IsHeartBeat": False,
            "SendPlayerInformationToDevice": False,
            "DisconnectLaunchMonitor": False,
            "ShotMediaPath": "",
            "DoesShowIncludeLiePenalty": True,
            "IsSpinEstimated": False,
        },
    }


class UneekorPath:
    """One short connection per shot to GSPconnect's Uneekor port, like the smoke injector."""

    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port
        self._last_number = 0

    def describe(self) -> str:
        return f"GSPconnect at {self.host}:{self.port} (the Uneekor path)"

    def start(self) -> None:
        pass  # Nothing to hold open; each shot connects on its own.

    def fire(self, shot: dict[str, Any]) -> str:
        number = max(self._last_number + 1, int(time.time() * 1000) % 1_000_000_000)
        self._last_number = number
        wire = (json.dumps(uneekor_packet(shot, number), separators=(",", ":")) + "\n").encode("utf-8")
        try:
            sock = socket.create_connection((self.host, self.port), timeout=2.0)
        except OSError as exc:
            raise ConnectionError(
                f"Couldn't reach GSPconnect at {self.host}:{self.port} ({exc}). "
                "Is the Uneekor launcher running and connected to GSPro?") from exc
        try:
            sock.sendall(wire)
            sock.settimeout(0.6)
            reply = b""
            try:
                reply = sock.recv(4096)
            except OSError:
                pass  # No reply is normal on this path.
        finally:
            sock.close()
        text = reply.decode("utf-8", "replace").strip()
        return f"sent (GSPconnect said: {text[:160]})" if text else "sent"

    def close(self) -> None:
        pass


# -- Open Connect path: GSPro's documented API on 921 ---------------------------

class OpenConnectPath:
    def __init__(self, host: str, port: int, api_version: str, timeout: float) -> None:
        from open_connect import OpenConnectClient  # only needed on this path

        self.client = OpenConnectClient(host, port, api_version=api_version)
        self.host, self.port, self.timeout = host, port, timeout

    def describe(self) -> str:
        return f"GSPro Open Connect at {self.host}:{self.port}"

    def start(self) -> None:
        from open_connect import OpenConnectError

        try:
            self.client.connect()
        except OpenConnectError as exc:
            raise ConnectionError(str(exc)) from exc

    def fire(self, shot: dict[str, Any]) -> str:
        from open_connect import Launch

        launch = Launch(ballSpeedMph=shot["speed"], vlaDeg=shot["vla"], hlaDeg=shot["hla"],
                        spinRpm=shot["spin"], spinAxisDeg=shot["axis"])
        result = self.client.fire(launch, wait_for_stop_s=self.timeout, is_done=lambda: True)
        errors = [r for r in result["replies"] if isinstance(r.get("Code"), int) and r["Code"] >= 500]
        if errors:
            return f"refused: {errors[0].get('Message') or errors[0]}"
        if result["gotReceived"]:
            return "GSPro took it"
        codes = [r.get("Code") for r in result["replies"]]
        return f"no confirmation from GSPro (replies: {codes or 'none'})"

    def close(self) -> None:
        self.client.close()


def run(args: argparse.Namespace, read_line=input) -> int:
    print(__doc__.split("At the prompt:")[1].split("How shots get to GSPro")[0].rstrip())
    if args.via == "openconnect":
        path: Any = OpenConnectPath(args.host, args.port or OPEN_CONNECT_PORT, args.api_version, args.timeout)
    else:
        path = UneekorPath(args.host, args.port or UNEEKOR_PORT)
    print(f"\nShots go to {path.describe()}. Watch GSPro for the ball.\n")
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3
    try:
        while True:
            try:
                line = read_line("shot> ")
            except EOFError:
                break
            command = line.strip().lower()
            if command in ("q", "quit", "exit"):
                break
            if command == "bag":
                print_bag()
                continue
            if not command:
                continue
            try:
                shot = parse(line)
            except ShotError as exc:
                print(exc)
                continue
            try:
                status = path.fire(shot)
            except (ConnectionError, OSError) as exc:
                print(exc)
                continue
            print(f"{shot['label']} ({describe(shot)}): {status}")
            time.sleep(0.2)
    except KeyboardInterrupt:
        print()
    finally:
        path.close()
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
    p.add_argument("--via", choices=("uneekor", "openconnect"), default="uneekor",
                   help="uneekor: GSPconnect's Uneekor port 59002 (default); openconnect: GSPro Open Connect 921")
    p.add_argument("--host", default=UNEEKOR_HOST)
    p.add_argument("--port", type=int, default=0, help="Override the port (default 59002, or 921 with --via openconnect)")
    p.add_argument("--api-version", default="1", help="Open Connect only: API version (1 or 2)")
    p.add_argument("--timeout", type=float, default=6.0, help="Open Connect only: seconds to wait for GSPro")
    return run(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
