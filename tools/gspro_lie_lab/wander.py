#!/usr/bin/env python3
"""Looper wander: walk the ball around a hole on its own and hit shots from every spot.

In GSPro's On Course practice you move the ball by clicking the golf-ball button
at the top left, then clicking the minimap where it should go. This does that
for you: it moves the ball to a new spot on the minimap, reads the slope under
the ball (from the Looper Companion), hits three shots (soft, medium, hard)
exactly like the "Shots from a lie" test, then moves on. Left alone it keeps
going until it has done the number of spots you asked for.

Run it from the shot tool's menu ("Wander"), or on its own:

  python wander.py              asks how many spots, then goes
  python wander.py --test       three spots, one shot each: checks the clicks move the ball

Before you start:
  1. CLOSE THE UNEEKOR LAUNCHER (the shot tool takes its place).
  2. GSPro in On Course practice, any hole, the minimap showing (right side
     unless you say --side left).
  3. The Looper Companion running (for the slope under the ball). Without it
     the shots are still hit and recorded, just without the slope.
  4. No Looper practice session open: these shots are not swings.

To stop: move the mouse. Before every click it checks the mouse is where it
left it; if you have moved it, it stops and saves. Ctrl+C also stops it.

Everything goes into looper_lab_<time>.csv next to this file, the same columns
as the lie test plus where it clicked and the slope. Send that file to Claude.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The shot tool's own recording. When the shot tool itself started this (its menu's
# Wander), use that copy: a browser saves a second download as "roll_replay (2).py",
# and importing "roll_replay" by name would find an older roll_replay.py instead.
import __main__  # noqa: E402

if hasattr(__main__, "hit_spot") and hasattr(__main__, "gspro_log"):
    _tool = __main__
else:
    import roll_replay as _tool  # noqa: E402
LAB_FIELDS, M_TO_YD, _xyz = _tool.LAB_FIELDS, _tool.M_TO_YD, _tool._xyz
gspro_db, gspro_log, gspro_round_file = _tool.gspro_db, _tool.gspro_log, _tool.gspro_round_file
hit_spot, lie_shots_for_spot, newest_round_record = _tool.hit_spot, _tool.lie_shots_for_spot, _tool.newest_round_record
BAG = _tool.BAG

#: Where GSPro draws the minimap, as shares of its window (the same boxes Auto Aim uses).
MINIMAP_BOX = {"right": (0.848, 0.520, 0.995, 0.960), "left": (0.005, 0.520, 0.152, 0.960)}
#: Practice mode's "move ball" button (the golf ball, second in the toolbar at the top
#: left), as shares of GSPro's window. Moving the ball is: click this, carry the
#: pointer over to the minimap, click where the ball should go (Brian, 20 Nov).
BALL_BUTTON = (0.063, 0.052)  # measured on two of Brian's screenshots: (0.060, 0.049) and (0.066, 0.056)
#: The part of that box that is map: under its title bar ("Tee ▾"), above the slope
#: footer, and in from the edges.
MAP_AREA = (0.10, 0.17, 0.90, 0.88)
#: Closer to the pin than this, click near the bottom of the map to walk back.
WALK_BACK_INSIDE_YD = 60.0
#: Moving the mouse more than this (screen pixels) between clicks stops the run.
STOP_IF_MOUSE_MOVED_PX = 25
#: Seconds for GSPro to move the ball and redraw after a click.
SETTLE_S = 3.0
COMPANION_LIE_URL = "http://127.0.0.1:8787/lie"


# ---- Windows: find GSPro, click, watch the mouse -------------------------------------------

class Desktop:
    """The few Windows calls the walk needs. Swapped for a fake in tests."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise OSError("The wander tool runs on the Windows PC that runs GSPro.")
        import ctypes
        from ctypes import wintypes
        self.ctypes, self.wintypes = ctypes, wintypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # real pixels, the same as GSPro's
        except (AttributeError, OSError):
            ctypes.windll.user32.SetProcessDPIAware()
        self.user32 = ctypes.windll.user32

    def gspro_window(self) -> tuple[int, tuple[int, int, int, int]] | None:
        """(handle, (left, top, right, bottom)) of GSPro's main window, or None."""
        ctypes, wintypes, user32 = self.ctypes, self.wintypes, self.user32
        kernel32 = ctypes.windll.kernel32
        found: list[tuple[int, tuple[int, int, int, int], int]] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def on_window(hwnd, _):
            if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return True
            try:
                size = wintypes.DWORD(1024)
                name = ctypes.create_unicode_buffer(1024)
                if not kernel32.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
                    return True
            finally:
                kernel32.CloseHandle(handle)
            if Path(name.value).name.lower() != "gspro.exe":
                return True
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            area = (rect.right - rect.left) * (rect.bottom - rect.top)
            found.append((int(hwnd), (rect.left, rect.top, rect.right, rect.bottom), area))
            return True

        user32.EnumWindows(on_window, 0)
        if not found:
            return None
        hwnd, rect, _ = max(found, key=lambda item: item[2])  # the main window, not a splash or a tooltip
        return hwnd, rect

    def mouse(self) -> tuple[int, int]:
        point = self.wintypes.POINT()
        self.user32.GetCursorPos(self.ctypes.byref(point))
        return point.x, point.y

    def _press(self) -> None:
        self.user32.mouse_event(0x0002, 0, 0, 0, 0)  # left down
        time.sleep(0.06)
        self.user32.mouse_event(0x0004, 0, 0, 0, 0)  # left up

    def move_ball(self, hwnd: int, button: tuple[int, int], x: int, y: int) -> None:
        """Click the move-ball button, glide the pointer to (x, y) on the minimap, click there."""
        self.user32.SetForegroundWindow(hwnd)
        time.sleep(0.25)
        self.user32.SetCursorPos(*button)
        time.sleep(0.15)
        self._press()
        time.sleep(0.5)
        # Glide rather than jump, so GSPro sees the pointer travel onto the map.
        steps = 15
        for i in range(1, steps + 1):
            self.user32.SetCursorPos(round(button[0] + (x - button[0]) * i / steps),
                                     round(button[1] + (y - button[1]) * i / steps))
            time.sleep(0.03)
        time.sleep(0.3)
        self._press()


# ---- Where to click ---------------------------------------------------------------------------

def map_rect(window: tuple[int, int, int, int], side: str) -> tuple[float, float, float, float]:
    """The clickable map, in screen pixels: (left, top, right, bottom)."""
    left, top, right, bottom = window
    width, height = right - left, bottom - top
    bx1, by1, bx2, by2 = MINIMAP_BOX[side]
    box = (left + bx1 * width, top + by1 * height, left + bx2 * width, top + by2 * height)
    ax1, ay1, ax2, ay2 = MAP_AREA
    bw, bh = box[2] - box[0], box[3] - box[1]
    return (box[0] + ax1 * bw, box[1] + ay1 * bh, box[0] + ax2 * bw, box[1] + ay2 * bh)


def pick_spot(rect: tuple[float, float, float, float], pin_yd: float | None, rng: random.Random) -> tuple[int, int, str]:
    """A point on the map to move the ball to, and why.

    GSPro draws the map with the ball at the bottom and the pin straight above
    it, both on the middle line, so the hole runs up the middle of the map.
    Clicks stay near that line (a spread either side reaches the rough, trees
    and bunkers beside the hole, not the next fairway over), and move the ball
    15 to 45% of the way to the pin. Near the pin: near the bottom, which walks
    the ball back down the hole.
    """
    left, top, right, bottom = rect
    across = min(0.85, max(0.15, rng.gauss(0.5, 0.16)))
    if pin_yd is not None and pin_yd < WALK_BACK_INSIDE_YD:
        down, why = rng.uniform(0.90, 1.0), "walk back"
    else:
        down, why = rng.uniform(0.55, 0.85), "ahead"
    return round(left + across * (right - left)), round(top + down * (bottom - top)), why


def read_slope(url: str = COMPANION_LIE_URL, timeout: float = 4.0) -> dict[str, Any]:
    """The slope under the ball from the Looper Companion's lie reader, or why not."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as reply:  # noqa: S310 (local companion only)
            data = json.loads(reply.read().decode("utf-8"))
    except (OSError, ValueError) as exc:
        return {"slope_read": f"no companion ({type(exc).__name__})"}
    up, right = data.get("upDownDegrees"), data.get("leftRightDegrees")
    if not isinstance(up, (int, float)) or not isinstance(right, (int, float)):
        return {"slope_read": str(data.get("status") or "unread")[:40]}
    return {"slope_up_deg": float(up), "slope_right_deg": float(right), "slope_read": "companion"}


def slope_note(slope: dict[str, Any]) -> str:
    if "slope_up_deg" not in slope:
        return ""
    up, right = slope["slope_up_deg"], slope["slope_right_deg"]
    return f"{abs(up):.1f} {'up' if up >= 0 else 'down'} {abs(right):.1f} {'right' if right >= 0 else 'left'}"


#: GSPro's flat carry for each of the lie test's shots (yards; its own "raw" carry, Farmlinks, 20 Nov).
LIE_FLAT_CARRY_YD = {
    "soft 40": 29.9, "soft 50": 45.3, "soft 60": 60.6, "soft 70": 81.1, "SW": 93.6,
    "PW": 121.2, "mid 95 low spin": 122.5, "mid 100 high": 128.7, "mid 105": 141.9, "7i": 157.9,
    "hard 120": 169.2, "5i": 177.7, "3H": 196.9, "Driver": 231.2, "hard 145": 234.7,
}
#: No shot is meant to carry more than this past the pin: further is trees and out of play (Brian, 20 Nov).
PAST_PIN_OK_YD = 15.0
#: Where GSPro draws the ball and the pin on its minimap (shares of the minimap box, from Auto Aim).
MAP_BALL_DOWN, MAP_PIN_DOWN = 0.90, 0.19


def distance_after_click(previous_yd: float | None, down: float) -> float | None:
    """About how far the pin is after moving the ball to `down` (share of the clickable map) on a
    map drawn from the ball at the bottom to the pin at the top."""
    if previous_yd is None:
        return None
    box_down = MAP_AREA[1] + down * (MAP_AREA[3] - MAP_AREA[1])
    share = (box_down - MAP_PIN_DOWN) / (MAP_BALL_DOWN - MAP_PIN_DOWN)
    return previous_yd * min(1.0, max(0.0, share))


def within_reach(shots: list[tuple[str, dict[str, float]]], distance_yd: float | None) -> list[tuple[str, dict[str, float]]]:
    """Only the shots that won't fly far past the pin (all of them if the distance is unknown)."""
    if distance_yd is None:
        return shots
    return [shot for shot in shots if LIE_FLAT_CARRY_YD.get(shot[0], 0.0) <= distance_yd + PAST_PIN_OK_YD]


#: From this far to this far from the pin (yards), two of a spot's three shots go at the green.
GREEN_RANGE_YD = (40.0, 240.0)
#: Aim to land this much short of the pin, so the release finishes near it.
GREEN_SHORT_YD = 2.0


#: GSPro's reply to each shot names the next club and how far the pin is from where the next
#: shot is hit; practice puts the ball back on the spot, so that is the spot's distance. In metres
#: (it matches the course coordinates, 20 Nov), whatever the label says.
NEXT_FROM_RE = re.compile(r"next:\s*\S+\s+from\s+(\d+(?:\.\d+)?)")


def pin_from_spot_yd(row: dict[str, Any]) -> float | None:
    """How far the pin was from where this shot was hit, in yards.

    From the pin GSPro writes to its log if it did; else from GSPro's reply to
    the shot (its distance to the pin from the spot). Not from the shot's own
    distance plus what was left: that is wrong whenever the shot went past the pin.
    """
    sx, sz, px, pz = (row.get(key) for key in ("start_x", "start_z", "pin_x", "pin_z"))
    if all(isinstance(v, (int, float)) for v in (sx, sz, px, pz)):
        return (((px - sx) ** 2 + (pz - sz) ** 2) ** 0.5) * M_TO_YD
    found = NEXT_FROM_RE.search(str(row.get("status") or ""))
    if found:
        return float(found[1]) * M_TO_YD
    return None


def plays_here(row: dict[str, Any]) -> float | None:
    """What a shot from this spot carried, as a share of the same launch on flat ground: lie, slope and altitude together."""
    carry, flat = row.get("carry_yd"), row.get("db_raw_carry_game_yd")
    if isinstance(carry, (int, float)) and isinstance(flat, (int, float)) and flat > 5 and 0.3 < carry / flat < 1.6:
        return carry / flat
    return None


def green_shots(distance_yd: float, plays: float | None, count: int = 2) -> list[tuple[str, dict[str, float]]]:
    """Shots meant to land on the green from here: the stock clubs nearest the distance the lie
    makes it play, each sped up or slowed down a little to carry the number."""
    needed = max(10.0, distance_yd - GREEN_SHORT_YD) / (plays or 1.0)
    clubs = sorted((club for club in BAG if BAG[club].get("carry")), key=lambda club: abs(BAG[club]["carry"] - needed))[:count]
    shots = []
    for club in clubs:
        stock = BAG[club]
        scale = min(1.25, max(0.75, (needed / stock["carry"]) ** (1.0 / 1.5)))  # carry grows about as speed^1.5
        shots.append((f"{club} to green", {"speed": round(stock["speed"] * scale, 1), "vla": stock["vla"], "hla": 0.0,
                                           "spin": stock["spin"], "axis": 0.0}))
    return shots


def ball_position(round_file: Path) -> tuple[float, float, float] | None:
    """Where the last shot was hit from: GSPro's newest round record."""
    record = newest_round_record(round_file) or {}
    return _xyz(record.get("StartingPOS"))


# ---- The walk ---------------------------------------------------------------------------------

def wander(path: Any, writer: Any, flush: Callable[[], None], *, desktop: Any, spots: int, shots_per_spot: int,
           side: str, labels: dict[str, Any], round_file: Path, log_file: Path, db_path: Path, notes_file: Path,
           first_spot: int = 1, gap: float = 1.0, record_wait: float = 8.0, settle: float = SETTLE_S,
           read_lie: Callable[[], dict[str, Any]] = read_slope, rng: random.Random | None = None,
           sleep=time.sleep, say: Callable[[str], None] = print) -> list[dict[str, Any]]:
    """Click, read the slope, hit, record; `spots` times or until the mouse moves."""
    rng = rng or random.Random()
    rows: list[dict[str, Any]] = []
    left_at: tuple[int, int] | None = None
    pin_yd: float | None = None
    last_start: tuple[float, float, float] | None = None
    stuck = 0
    for spot in range(first_spot, first_spot + spots):
        if left_at is not None:
            now = desktop.mouse()
            if abs(now[0] - left_at[0]) > STOP_IF_MOUSE_MOVED_PX or abs(now[1] - left_at[1]) > STOP_IF_MOUSE_MOVED_PX:
                say("\nThe mouse moved: stopping. Everything so far is saved.")
                break
        found = desktop.gspro_window()
        if not found:
            say("\nGSPro's window is not open (or is minimised): stopping.")
            break
        hwnd, window = found
        if spot == first_spot:
            # The first spot is wherever the player left the ball: no click.
            x, y, why, estimated = None, None, "start", None
            left_at = desktop.mouse()
        else:
            rect = map_rect(window, side)
            x, y, why = pick_spot(rect, pin_yd, rng)
            estimated = distance_after_click(pin_yd, (y - rect[1]) / max(1.0, rect[3] - rect[1]))
            left, top, right, bottom = window
            button = (round(left + BALL_BUTTON[0] * (right - left)), round(top + BALL_BUTTON[1] * (bottom - top)))
            desktop.move_ball(hwnd, button, x, y)
            left_at = (x, y)
            sleep(settle)
        slope = read_lie()
        typed = (f"wander {why}" + (f" click {x},{y}" if x is not None else "")
                 + (f" slope {slope_note(slope)}" if slope_note(slope) else ""))
        spot_labels = {**labels, "click_x": x, "click_y": y, **slope}
        say(f"\nSpot {spot} ({why}){'; slope ' + slope_note(slope) if slope_note(slope) else ''}")
        lie_shots = lie_shots_for_spot(spot)
        # First, the lie test's soft shot (a different one each spot): it measures the lie and shows
        # where the pin is, and it is short enough not to fly far past the green. Then, if the green
        # is in reach, two at the green allowing for how this spot plays; if it is out of reach, the
        # medium and hard lie shots; inside 40 yd, nothing more (chips are their own test).
        soft_shots = [(name, {"speed": speed, "vla": vla, "hla": 0.0, "spin": spin, "axis": 0.0})
                      for name, speed, vla, spin in _tool.LIE_SHOTS[0]]
        rotated = soft_shots[(spot - 1) % len(soft_shots):] + soft_shots[:(spot - 1) % len(soft_shots)]
        first = (within_reach(rotated, estimated) or [min(soft_shots, key=lambda shot: LIE_FLAT_CARRY_YD.get(shot[0], 0.0))])[:1]

        def fire(shots, aim, extra=None):
            return hit_spot(path, writer, flush, labels={**spot_labels, "aim": aim, **(extra or {})}, spot=spot, typed=typed,
                            spot_shots=shots, round_file=round_file, log_file=log_file, db_path=db_path,
                            notes_file=notes_file, gap=gap, record_wait=record_wait, sleep=sleep)

        spot_rows, connected = fire(first, "lie")
        if connected and spot_rows and shots_per_spot > 1:
            distance = pin_from_spot_yd(spot_rows[0])
            plays = plays_here(spot_rows[0])
            extra = {"pin_from_spot_yd": round(distance, 1)} if distance is not None else {}
            if distance is not None and distance < GREEN_RANGE_YD[0]:
                say(f"  {distance:.0f} yd from the pin: chip range, moving on")
                more = []
            elif distance is not None and distance <= GREEN_RANGE_YD[1]:
                say(f"  green {distance:.0f} yd away{f', plays {plays:.0%} of flat' if plays else ''}: two at the green")
                more, connected = fire(green_shots(distance, plays, shots_per_spot - 1), "green", extra)
            else:
                longer = within_reach([shot for shot in lie_shots if shot not in first and shot not in soft_shots], distance)
                more, connected = fire(longer[:shots_per_spot - 1], "lie", extra) if longer else ([], True)
            spot_rows += more
            if distance is not None:
                pin_yd = distance
        rows.extend(spot_rows)
        if not connected:
            say("Lost the connection to GSPro: stopping.")
            break
        start = ball_position(round_file)
        if start and last_start:
            moved = (((start[0] - last_start[0]) ** 2 + (start[2] - last_start[2]) ** 2) ** 0.5) * M_TO_YD
            stuck = stuck + 1 if moved < 1.0 else 0
            if stuck == 1:
                say("  (the ball did not move with that click)")
            if stuck >= 3:
                say("\nThree clicks in a row did not move the ball: stopping. Is GSPro in On Course practice,"
                    " with the minimap on the side you said?")
                break
        last_start = start or last_start
    return rows


def main(argv: list[str] | None = None, read_line=input) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--test", action="store_true", help="three spots, one shot each, to check the clicks")
    parser.add_argument("--spots", type=int, default=None, help="how many spots (default: asks)")
    parser.add_argument("--side", choices=sorted(MINIMAP_BOX), default="right", help="where the minimap is")
    args = parser.parse_args(argv)

    from test_shots import OPEN_CONNECT_PORT, UNEEKOR_HOST, UNEEKOR_PORT, OpenConnectPath, pause_before_close

    print("Looper wander: moves the ball around the hole and hits shots from each spot.\n")
    print("CLOSE THE UNEEKOR LAUNCHER first. GSPro in On Course practice, minimap showing,")
    print("the Looper Companion running. To stop at any time: move the mouse.\n")
    if args.test:
        spots, per_spot = 3, 1
    else:
        spots = args.spots
        if spots is None:
            typed = read_line("How many spots? About 45 seconds each: Enter for 150 (about 2 hours). ").strip()
            spots = int(typed) if typed.isdigit() and int(typed) > 0 else 150
        per_spot = 3
    try:
        desktop = Desktop()
    except OSError as exc:
        print(exc)
        return 2
    path = OpenConnectPath(UNEEKOR_HOST, [UNEEKOR_PORT, OPEN_CONNECT_PORT], "2", 60.0)
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3
    out = HERE / f"looper_lab_{time.strftime('%Y%m%d_%H%M%S')}_wander.csv"
    notes_file = out.with_name(out.stem + "_log.txt")
    print(f"Starting in 5 seconds. Hands off the mouse. {'Test: 3 spots, 1 shot each.' if args.test else f'{spots} spots.'}")
    time.sleep(5)
    with out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=LAB_FIELDS, extrasaction="ignore")
        writer.writeheader()
        rows = wander(path, writer, handle.flush, desktop=desktop, spots=spots, shots_per_spot=per_spot, side=args.side,
                      labels={"test": "wander"}, round_file=gspro_round_file(), log_file=gspro_log(), db_path=gspro_db(),
                      notes_file=notes_file)
    print(f"\n{len(rows)} shots from {len({row.get('spot') for row in rows})} spots saved in {out.name}.")
    print("Send that file (and the _log.txt beside it) to Claude.")
    pause_before_close(read_line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
