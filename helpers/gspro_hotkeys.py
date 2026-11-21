"""EXPERIMENTAL: press one of GSPro's own keyboard shortcuts.

Used by voice commands ("Looper, flyover"). Only the named shortcuts below can
be sent, one key press per request, and only into a GSPro window that is in
front; nothing here types text or sends arbitrary keys.

Keys are GSPro's default layout (published shortcut lists, Nov 2026):
https://thecoursecontrol.com/guides/gspro-keyboard-shortcuts/ and the
bblanton/gspro-control README agree on every key used here.
"""
from __future__ import annotations

import ctypes
import os
import time
from typing import Callable

SCHEMA_VERSION = "gspro-hotkey-v1"
KEY_HOLD_S = 0.06
MIN_INTERVAL_S = 0.6

VK_CONTROL = 0x11
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

# name -> (virtual key, needs Ctrl)
HOTKEYS: dict[str, tuple[int, bool]] = {
    "flyover": (0x4F, False),    # O
    "scorecard": (0x54, False),  # T
    "heatmap": (0x59, False),    # Y
    "greengrid": (0x47, False),  # G
    "shotcam": (0x4A, False),    # J
    "pin": (0x50, False),        # P  pin indicator
    "putt": (0x55, False),       # U  putt toggle
    "hideui": (0x48, False),     # H
    "mulligan": (0x4D, True),    # Ctrl+M (mulligans must be enabled in GSPro)
}


def _send_keys(vk: int, ctrl: bool) -> None:
    """One real key press (hardware-style scan codes, which Unity reads)."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    def press(key: int, up: bool) -> None:
        scan = user32.MapVirtualKeyW(key, 0)
        user32.keybd_event(key, scan, KEYEVENTF_KEYUP if up else 0, 0)

    if ctrl:
        press(VK_CONTROL, False)
        time.sleep(0.02)
    press(vk, False)
    time.sleep(KEY_HOLD_S)
    press(vk, True)
    if ctrl:
        time.sleep(0.02)
        press(VK_CONTROL, True)


def _front_gspro(hwnd: int) -> bool:
    """Bring GSPro to the front (it only reads shortcuts when active)."""
    import gspro_direct_click as native_click

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = ctypes.c_void_p
    user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
    native_click._bring_to_front(user32, hwnd)
    return int(user32.GetForegroundWindow() or 0) == hwnd


def press_hotkey(
    name: object,
    *,
    find_window: Callable[[], dict],
    front: Callable[[int], bool] | None = None,
    send: Callable[[int, bool], None] | None = None,
) -> dict:
    """Press the named GSPro shortcut. Returns {"status": "sent" | "blocked", ...}."""
    if not isinstance(name, str) or name not in HOTKEYS:
        return {"status": "blocked", "reason": "unknown-key"}
    vk, ctrl = HOTKEYS[name]
    window = find_window() or {}
    if window.get("status") != "connected":
        return {"status": "blocked", "reason": "gspro-not-connected", "key": name}
    if window.get("minimized"):
        return {"status": "blocked", "reason": "gspro-minimized", "key": name}
    hwnd = window.get("hwnd")
    if not isinstance(hwnd, int) or hwnd <= 0:
        return {"status": "blocked", "reason": "gspro-not-connected", "key": name}
    if front is None or send is None:
        if os.name != "nt":
            return {"status": "blocked", "reason": "windows-only", "key": name}
        front = front or _front_gspro
        send = send or _send_keys
    if not front(hwnd):
        return {"status": "blocked", "reason": "gspro-not-in-front", "key": name}
    send(vk, ctrl)
    return {"status": "sent", "key": name}
