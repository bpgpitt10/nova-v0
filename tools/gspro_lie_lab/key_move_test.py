"""How far does GSPro move the ball when an arrow key is held?

GSPro's On Course practice moves the ball while an arrow key is held down,
so the distance depends on how long it is held, not on how many presses.
This tester measures it, so the shot tool can later walk the ball around a
hole on its own.

How it works:
  1. It fires a tiny putt (2 mph) to record where the ball sits. In practice
     mode GSPro puts the ball back on its spot after every shot.
  2. It holds one arrow key for a set time, then fires another tiny putt to
     record where the ball is now.
  3. It does that for each arrow key at a few hold times, and prints how far
     the ball moved, toward the pin or sideways, and whether the aim turned.

Before you start: Uneekor Launcher closed, Uneekor Connect open, GSPro in On
Course practice with the ball on a fairway with room to move. No Looper
practice session running. When it counts down, CLICK INTO THE GSPRO WINDOW so
the key presses go to GSPro. It pauses if GSPro is not the active window.

It fires about 17 tiny putts and takes about three minutes. Results go to
key_moves_<time>.csv next to this file.
"""
from __future__ import annotations

import csv
import ctypes
import math
import sys
import time
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from roll_replay import (  # noqa: E402
    gspro_round_file,
    measure_putt,
    newest_round_record,
    record_fingerprint,
    wait_for_new_record,
)
from test_shots import OPEN_CONNECT_PORT, UNEEKOR_HOST, UNEEKOR_PORT, OpenConnectPath, pause_before_close  # noqa: E402

M_TO_YD = 1.0936133
PROBE = {"speed": 2.0, "vla": 0.0, "hla": 0.0, "spin": 0.0, "axis": 0.0}
KEYS = ("right", "left", "up", "down")
HOLD_MS = (100, 250, 500, 1000)

# ---- Sending a held arrow key to GSPro (Windows) ------------------------------

# Games often ignore virtual-key presses, so these are sent as hardware scan
# codes. Arrow keys are "extended" keys.
SCAN = {"up": 0x48, "down": 0x50, "left": 0x4B, "right": 0x4D}
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008


class _KeyInput(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _InputUnion(ctypes.Union):
    _fields_ = [("ki", _KeyInput), ("padding", ctypes.c_ubyte * 32)]


class _Input(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", _InputUnion)]


def _send_key(name: str, up: bool) -> None:
    flags = KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | (KEYEVENTF_KEYUP if up else 0)
    event = _Input(type=1, union=_InputUnion(ki=_KeyInput(0, SCAN[name], flags, 0, None)))
    ctypes.windll.user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(_Input))


def hold_key(name: str, ms: int, sleep: Callable[[float], None] = time.sleep) -> None:
    _send_key(name, up=False)
    try:
        sleep(ms / 1000.0)
    finally:
        _send_key(name, up=True)


def active_window_title() -> str:
    user32 = ctypes.windll.user32
    handle = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(handle)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(handle, buffer, length + 1)
    return buffer.value


def wait_for_gspro_in_front(title: Callable[[], str] = active_window_title, sleep: Callable[[float], None] = time.sleep) -> None:
    warned = False
    while "gspro" not in title().lower():
        if not warned:
            print("  Paused: click into the GSPro window so the arrow keys reach it.")
            warned = True
        sleep(0.5)


# ---- Where the ball is ------------------------------------------------------------

def ball_spot(record: dict[str, Any] | None) -> dict[str, float] | None:
    """Where the ball started this shot, in metres, and which way it was aimed (degrees, 0 = +z)."""
    row = measure_putt(record)
    if row.get("start_x") is None:
        return None
    aim = ((record or {}).get("GhostData") or {}).get("ballDirection")
    try:
        aim_deg = float(aim)
    except (TypeError, ValueError):
        aim_deg = None
    return {"x": float(row["start_x"]), "y": float(row["start_y"]), "z": float(row["start_z"]), "aim": aim_deg}


def movement(before: dict[str, float], after: dict[str, float]) -> dict[str, Any]:
    """How far the ball moved, split into along the aim line and across it, in yards."""
    dx, dz = after["x"] - before["x"], after["z"] - before["z"]
    out: dict[str, Any] = {"moved_yd": round(math.hypot(dx, dz) * M_TO_YD, 2), "height_change_ft": round((after["y"] - before["y"]) * 3.28084, 1)}
    aim = before.get("aim")
    if aim is not None:
        heading = math.radians(aim)
        forward = dx * math.sin(heading) + dz * math.cos(heading)
        right = dx * math.cos(heading) - dz * math.sin(heading)
        out.update({"toward_aim_yd": round(forward * M_TO_YD, 2), "right_of_aim_yd": round(right * M_TO_YD, 2)})
        if after.get("aim") is not None:
            turned = (after["aim"] - aim + 180.0) % 360.0 - 180.0
            out["aim_turned_deg"] = round(turned, 1)
    return out


def probe(path: Any, round_file: Path, sleep: Callable[[float], None] = time.sleep) -> dict[str, float] | None:
    before = record_fingerprint(newest_round_record(round_file))
    path.fire(dict(PROBE))
    return ball_spot(wait_for_new_record(round_file, before, 10.0, sleep=sleep))


def run(path: Any = None, round_file: Path | None = None, out_dir: Path | None = None, read_line=input,
        sleep: Callable[[float], None] = time.sleep, hold: Callable[[str, int], None] | None = None,
        title: Callable[[], str] | None = None) -> int:
    round_file = round_file or gspro_round_file()
    hold = hold or (lambda name, ms: hold_key(name, ms, sleep))
    title = title or active_window_title
    out = (out_dir or HERE) / f"key_moves_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    print(__doc__)
    if path is None:
        path = OpenConnectPath(UNEEKOR_HOST, [UNEEKOR_PORT, OPEN_CONNECT_PORT], "2", 60.0)
    try:
        path.start()
    except ConnectionError as exc:
        print(exc)
        pause_before_close(read_line)
        return 3
    read_line("Press Enter, then click into GSPro within 5 seconds. ")
    for left in (5, 4, 3, 2, 1):
        print(f"  {left}...")
        sleep(1.0)
    rows: list[dict[str, Any]] = []
    try:
        here = probe(path, round_file, sleep)
        if here is None:
            print("GSPro did not record the first putt. Is it in On Course practice? Nothing else was done.")
            return 4
        with out.open("w", newline="", encoding="utf-8") as handle:
            fields = ["key", "hold_ms", "moved_yd", "toward_aim_yd", "right_of_aim_yd", "height_change_ft", "aim_turned_deg"]
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for key in KEYS:
                for ms in HOLD_MS:
                    wait_for_gspro_in_front(title, sleep)
                    hold(key, ms)
                    sleep(0.8)
                    there = probe(path, round_file, sleep)
                    if there is None:
                        print(f"  {key:>5} {ms:>5} ms: GSPro did not record the putt; skipped")
                        continue
                    row = {"key": key, "hold_ms": ms, **movement(here, there)}
                    writer.writerow(row)
                    handle.flush()
                    rows.append(row)
                    turned = f", aim turned {row['aim_turned_deg']:+.1f} deg" if row.get("aim_turned_deg") else ""
                    along = f" ({row.get('toward_aim_yd', 0):+.1f} toward the aim, {row.get('right_of_aim_yd', 0):+.1f} right)" if "toward_aim_yd" in row else ""
                    print(f"  {key:>5} held {ms:>4} ms: moved {row['moved_yd']:.1f} yd{along}{turned}")
                    here = there
        print(f"\nSaved {len(rows)} moves to {out.name}. Send that file to Claude.")
        return 0
    finally:
        try:
            path.close()
        except Exception:  # noqa: BLE001
            pass
        pause_before_close(read_line)


if __name__ == "__main__":
    sys.exit(run())
