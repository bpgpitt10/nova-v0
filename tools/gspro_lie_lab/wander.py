#!/usr/bin/env python3
"""Looper wander: walk the ball down the holes on its own and hit shots from every spot.

In GSPro's On Course practice you move the ball by clicking the golf-ball button at the
top left, then the minimap where it should go; the flag button next to it opens a grid of
holes, and picking one puts the ball on that tee. This does both for you, hole after hole:

  - From a tee: the tee shots, then a step down the hole (a par 3: the tee shots, then the
    next hole).
  - Down the hole: three spots across the hole (rough, bunkers, the tree line) at each
    distance, then a step toward the pin that leaves about 80% of the distance.
  - Inside 50 yd: on to the next hole (after 18, hole 1).
  - Every spot: one soft lie-test shot, then two at the green when it is 40-240 yd away
    (the second corrected by how far the first carried, which catches the hill), or the
    medium and hard lie shots when it is further. Nothing is sent far past the pin.
  - Before each click it checks the colour there and steers clear of water and hazard
    lines; a ball that still ends up in water is not hit again.

Run it from the shot tool's menu ("Wander"), or on its own:

  python wander.py --hole 1     asks how many spots, then goes
  python wander.py --test       three spots, one shot each

Before you start:
  1. CLOSE THE UNEEKOR LAUNCHER (the shot tool takes its place).
  2. GSPro full screen, in On Course practice, the minimap showing (right side unless
     --side left). The buttons are found by where they sit on the screen.
  3. The Looper Companion running (for the slope under the ball).
  4. No Looper practice session open: these shots are not swings.
  5. Wind off.

To stop: move the mouse. Ctrl+C also stops it.

Everything goes into looper_lab_<time>.csv next to this file. Send it to Claude.
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
BALL_BUTTON = (0.0687, 0.0568)  # Brian's full-screen screenshot, 20 Nov
#: Practice mode's hole button (the flag, third in the toolbar). It opens a grid of the
#: course's holes; clicking one puts the ball on that hole's tee (Brian, 20 Nov).
FLAG_BUTTON = (0.1056, 0.0568)
#: Middle of each hole's square in that grid, shares of the window: holes 1-9 on the left
#: (three rows of three), 10-18 on the right (Brian's full-screen screenshot, 20 Nov).
HOLE_GRID_X = (0.1009, 0.1467, 0.1922, 0.2395, 0.2849, 0.3307)
HOLE_GRID_Y = (0.1419, 0.2229, 0.3046)
#: Seconds for GSPro to load a hole after it is picked.
HOLE_LOAD_S = 8.0
#: The part of that box that is map: under its title bar ("Tee ▾"), above the slope
#: footer, and in from the edges.
MAP_AREA = (0.10, 0.17, 0.90, 0.88)
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

    def colours(self, hwnd: int, points: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
        """Screen colours at these points, GSPro brought to the front first."""
        self.user32.SetForegroundWindow(hwnd)
        time.sleep(0.2)
        screen = self.user32.GetDC(0)
        try:
            gdi32 = self.ctypes.windll.gdi32
            gdi32.GetPixel.restype = self.wintypes.DWORD
            out = []
            for x, y in points:
                value = gdi32.GetPixel(screen, x, y)
                if value != 0xFFFFFFFF:  # CLR_INVALID: off the screen
                    out.append((value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF))
            return out
        finally:
            self.user32.ReleaseDC(0, screen)

    def click_at(self, hwnd: int, x: int, y: int) -> None:
        self.user32.SetForegroundWindow(hwnd)
        time.sleep(0.2)
        self.user32.SetCursorPos(x, y)
        time.sleep(0.15)
        self._press()

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


#: Spots taken across the hole at one distance before stepping on toward the pin.
ACROSS_PER_BAND = 3
#: Each step toward the pin leaves about this share of the distance.
STEP_LEAVES = 0.80
#: Moving on to the next hole: closer to the pin than this, or a par 3 (tee closer than PAR3_UNDER_YD).
NEXT_HOLE_INSIDE_YD = 50.0
PAR3_UNDER_YD = 250.0
#: Off a par 4 or 5 tee (the shot tool's bag has no 3 wood yet).
TEE_CLUBS = ("Driver", "3W", "3H")
#: Tee-only clubs the shot tool's bag doesn't have. 3W: Brian's stock from his bag page, 20 Nov (11 swings).
TEE_EXTRA = {"3W": {"speed": 142.4, "vla": 15.2, "spin": 3622, "carry": 224.8, "total": 237.3}}
#: GSPro's StartingSurface for a tee box (320 of the 360 first shots of a hole in live rounds are 18).
TEE_SURFACE = 18
#: Clubs only hit off a tee. Nobody hits driver at a green out of deep rough (Farmlinks 2, 20 Nov).
TEE_ONLY = ("Driver",)


def move_point(rect: tuple[float, float, float, float], kind: str, rng: random.Random) -> tuple[int, int]:
    """Where to click on the map for this kind of move.

    GSPro draws the map with the ball at the bottom and the pin straight above it on the middle
    line. "across": level with the ball, out to one side (rough, bunkers, the tree line).
    "forward": up the middle line to leave about STEP_LEAVES of the distance.
    """
    left, top, right, bottom = rect
    if kind == "across":
        side = rng.choice((-1.0, 1.0))
        across, down = 0.5 + side * rng.uniform(0.15, 0.33), rng.uniform(0.96, 1.0)
    else:
        box_down = MAP_PIN_DOWN + STEP_LEAVES * (MAP_BALL_DOWN - MAP_PIN_DOWN)
        aim = (box_down - MAP_AREA[1]) / (MAP_AREA[3] - MAP_AREA[1])
        across, down = min(0.8, max(0.2, rng.gauss(0.5, 0.07))), min(1.0, max(0.0, aim + rng.uniform(-0.03, 0.03)))
    return round(left + across * (right - left)), round(top + down * (bottom - top))


def looks_like_water(colours: list[tuple[int, int, int]]) -> bool:
    """Most of the patch is the minimap's water (dark blue) or a red hazard line.

    Measured on Farmlinks hole 1: water (14, 24, 38), (34, 39, 45), (14, 17, 33); fairway
    (64, 85, 41); rough and trees (38, 51, 28), (14, 30, 12); sand (171, 155, 120).
    """
    if not colours:
        return False
    bad = sum(1 for r, g, b in colours if (b > r + 10 and b >= g + 4) or (r > g + 50 and r > b + 50))
    return bad >= 0.4 * len(colours)


def hole_point(window: tuple[int, int, int, int], hole: int) -> tuple[int, int]:
    """The middle of hole `hole`'s square in the hole grid."""
    left, top, right, bottom = window
    index = (hole - 1) % 18
    half, cell = divmod(index, 9)
    row, col = divmod(cell, 3)
    return (round(left + HOLE_GRID_X[half * 3 + col] * (right - left)), round(top + HOLE_GRID_Y[row] * (bottom - top)))


def button_point(window: tuple[int, int, int, int], share: tuple[float, float]) -> tuple[int, int]:
    left, top, right, bottom = window
    return round(left + share[0] * (right - left)), round(top + share[1] * (bottom - top))


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
#: How much a green shot may be sped up or slowed down from the club's stock speed, both green
#: shots together: a player can swing a little harder or softer, not 50% harder (a 201 mph 3H, 20 Nov).
SPEED_SCALE = (0.85, 1.10)


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
    if found and float(found[1]) >= 1.0:
        return float(found[1]) * M_TO_YD
    if found and isinstance(row.get("total_yd"), (int, float)):
        # "from 0.0 yd": the shot finished on the green by the pin (Farmlinks 1, 20 Nov), and GSPro
        # answers for the putt. The shot's own length is then the distance, near enough.
        return float(row["total_yd"])
    return None


def plays_here(row: dict[str, Any]) -> float | None:
    """What a shot from this spot carried, as a share of the same launch on flat ground: lie, slope and altitude together."""
    carry, flat = row.get("carry_yd"), row.get("db_raw_carry_game_yd")
    if isinstance(carry, (int, float)) and isinstance(flat, (int, float)) and flat > 5 and 0.3 < carry / flat < 1.6:
        return carry / flat
    return None


def is_tee(row: dict[str, Any] | None) -> bool:
    """Whether GSPro says this shot was hit off a tee box."""
    try:
        return int(float((row or {}).get("start_surface"))) == TEE_SURFACE
    except (TypeError, ValueError):
        return False


def off_the_deck() -> list[str]:
    return [club for club in BAG if BAG[club].get("carry") and club not in TEE_ONLY]


def green_in_reach(distance_yd: float, plays: float | None) -> bool:
    """Whether the longest club hit off the ground, swung as hard as SPEED_SCALE allows, gets there."""
    needed = max(10.0, distance_yd - GREEN_SHORT_YD) / (plays or 1.0)
    longest = max(BAG[club]["carry"] for club in off_the_deck())
    return needed <= longest * SPEED_SCALE[1] ** 1.5


def clamp_speed(name: str, speed: float) -> float:
    """Keep a green shot's speed within SPEED_SCALE of its club's stock speed."""
    stock = BAG.get(name.split()[0], {}).get("speed")
    if not stock:
        return round(speed, 1)
    return round(min(stock * SPEED_SCALE[1], max(stock * SPEED_SCALE[0], speed)), 1)


def green_shots(distance_yd: float, plays: float | None, count: int = 2) -> list[tuple[str, dict[str, float]]]:
    """Shots meant to land on the green from here: the stock clubs nearest the distance the lie
    makes it play, each sped up or slowed down a little to carry the number. Never a tee-only club."""
    needed = max(10.0, distance_yd - GREEN_SHORT_YD) / (plays or 1.0)
    clubs = sorted(off_the_deck(), key=lambda club: abs(BAG[club]["carry"] - needed))[:count]
    shots = []
    for club in clubs:
        stock = BAG[club]
        scale = min(SPEED_SCALE[1], max(SPEED_SCALE[0], (needed / stock["carry"]) ** (1.0 / 1.5)))  # carry ~ speed^1.5
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
           sleep=time.sleep, say: Callable[[str], None] = print, hole: int = 1) -> list[dict[str, Any]]:
    """Click, read the slope, hit, record; `spots` times or until the mouse moves. `hole`: the hole it starts on."""
    rng = rng or random.Random()
    rows: list[dict[str, Any]] = []
    left_at: tuple[int, int] | None = None
    pin_yd: float | None = None
    last_start: tuple[float, float, float] | None = None
    stuck = 0
    across_done = 0
    next_move = "start"  # start, across, forward or next-hole
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
        why = next_move
        x = y = estimated = None
        if why == "start":
            # The first spot is wherever the player left the ball: no click.
            left_at = desktop.mouse()
        elif why == "next-hole":
            hole = hole + 1 if hole < 18 else 1
            desktop.click_at(hwnd, *button_point(window, FLAG_BUTTON))
            sleep(1.0)
            point = hole_point(window, hole)
            desktop.click_at(hwnd, *point)
            left_at = point
            say(f"\nOn to hole {hole}.")
            sleep(HOLE_LOAD_S)
            pin_yd, last_start = None, None
            why = "tee"
        else:
            rect = map_rect(window, side)
            # Look before clicking: try a few spots, keep the first that isn't water or a hazard line.
            for _ in range(8):
                x, y = move_point(rect, why, rng)
                patch = [(x + dx, y + dy) for dx in (-6, 0, 6) for dy in (-6, 0, 6)]
                colours = desktop.colours(hwnd, patch) if hasattr(desktop, "colours") else []
                if not looks_like_water(colours):
                    break
            estimated = distance_after_click(pin_yd, (y - rect[1]) / max(1.0, rect[3] - rect[1]))
            desktop.move_ball(hwnd, button_point(window, BALL_BUTTON), x, y)
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
        in_water = bool(spot_rows) and bool(re.search(r"water|hazard|lake|pond|creek|penalty",
                                                       str(spot_rows[0].get("lie_surface") or ""), re.I))
        if in_water:
            say("  in water: not a lie we want, moving on")
            for row in spot_rows:
                row["aim"] = "water"
        if connected and spot_rows and shots_per_spot > 1 and not in_water:
            distance = pin_from_spot_yd(spot_rows[0])
            plays = plays_here(spot_rows[0])
            extra = {"pin_from_spot_yd": round(distance, 1)} if distance is not None else {}
            if why == "start" and is_tee(spot_rows[0]):
                why = "tee"  # the player left the ball on a tee
            if why == "tee" and distance is not None and distance >= PAR3_UNDER_YD:
                # A par 4 or 5 tee: what players hit there, for real tee-shot roll.
                bag = {**TEE_EXTRA, **BAG}
                tee = [(f"{club} off the tee", {"speed": bag[club]["speed"], "vla": bag[club]["vla"], "hla": 0.0,
                                                "spin": bag[club]["spin"], "axis": 0.0})
                       for club in TEE_CLUBS if club in bag and bag[club]["carry"] <= distance + PAST_PIN_OK_YD]
                say(f"  tee, {distance:.0f} yd: {', '.join(name.split()[0] for name, _ in tee)}")
                more, connected = fire(tee[:shots_per_spot], "tee", extra) if tee else ([], True)
            elif distance is not None and distance < GREEN_RANGE_YD[0]:
                say(f"  {distance:.0f} yd from the pin: chip range, moving on")
                more = []
            elif distance is not None and distance <= GREEN_RANGE_YD[1] and green_in_reach(distance, plays):
                say(f"  green {distance:.0f} yd away{f', plays {plays:.0%} of flat' if plays else ''}: two at the green")
                # The first one at the green shows how the hill plays too (a green 36 yd below
                # carries a ball much further): the second is corrected by how far the first carried.
                planned = green_shots(distance, plays, shots_per_spot - 1)
                more, connected = fire(planned[:1], "green", extra)
                if connected and len(planned) > 1:
                    second = planned[1:]
                    flew = more[0].get("carry_yd") if more else None
                    wanted = distance - GREEN_SHORT_YD
                    if isinstance(flew, (int, float)) and flew > 10:
                        scale = (wanted / flew) ** (1.0 / 1.5)
                        second = [(name, {**shot, "speed": clamp_speed(name, shot["speed"] * scale)}) for name, shot in second]
                    again, connected = fire(second, "green", extra)
                    more += again
            else:
                if distance is not None and distance <= GREEN_RANGE_YD[1]:
                    say(f"  green {distance:.0f} yd away but out of reach from this lie: lie shots instead")
                longer = within_reach([shot for shot in lie_shots if shot not in first and shot not in soft_shots
                                       and shot[0] not in TEE_ONLY], distance)
                more, connected = fire(longer[:shots_per_spot - 1], "lie", extra) if longer else ([], True)
            spot_rows += more
        if spot_rows:
            measured = pin_from_spot_yd(spot_rows[0])
            pin_yd = measured if measured is not None else pin_yd
        # What next: from a tee, step forward (or, on a par 3, the next hole); inside 50 yd, the
        # next hole; otherwise a few spots across the hole, then a step toward the pin.
        if pin_yd is not None and (pin_yd < NEXT_HOLE_INSIDE_YD or (why == "tee" and pin_yd < PAR3_UNDER_YD)):
            next_move, across_done = "next-hole", 0
        elif why in ("tee", "start") or across_done >= ACROSS_PER_BAND:
            next_move, across_done = "forward", 0
        else:
            next_move, across_done = "across", across_done + 1
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
    parser.add_argument("--hole", type=int, default=1, help="the hole the ball is on (it moves on by itself)")
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
                      notes_file=notes_file, hole=args.hole)
    print(f"\n{len(rows)} shots from {len({row.get('spot') for row in rows})} spots saved in {out.name}.")
    print("Send that file (and the _log.txt beside it) to Claude.")
    pause_before_close(read_line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
