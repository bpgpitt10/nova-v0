"""Bounded, read-only GSPro native window capture quality probe.

No screenshot pixels leave this module. PrintWindow is a *candidate* Windows
capture method, NOT assumed to work with GSPro's Unity/3D renderer; the output
says blank/unsupported rather than claiming success on an all-black frame.
Windows Graphics Capture (HWND) is a later fallback if required by the sim.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from threading import Lock


_CAPTURE_LOCK = Lock()
MAX_CAPTURE_PIXELS = 3840 * 2160


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def assess_bgra_frame(raw: bytes, width: int, height: int) -> dict:
    """Pure-Python GPU-black-frame heuristic that is portable in tests."""
    if width < 1 or height < 1 or len(raw) != width * height * 4:
        raise ValueError("Unexpected screenshot buffer geometry")
    grid_x = max(1, width // 64)
    grid_y = max(1, height // 48)
    distinct = set()
    dark = 0
    samples = 0
    minimum = 255
    maximum = 0
    for y in range(grid_y // 2, height, grid_y):
        for x in range(grid_x // 2, width, grid_x):
            offset = 4 * (y * width + x)
            blue, green, red = raw[offset:offset + 3]
            level = (red + green + blue) // 3
            dark += int(level < 9)
            minimum = min(minimum, level)
            maximum = max(maximum, level)
            distinct.add((red // 32, green // 32, blue // 32))
            samples += 1
    dark_fraction = dark / max(1, samples)
    return {
        "nonblank": len(distinct) >= 8 and maximum - minimum >= 20 and dark_fraction < 0.97,
        "darkFraction": round(dark_fraction, 3),
        "colorBuckets": len(distinct),
        "brightnessRange": maximum - minimum,
        "sampleCount": samples,
    }


def probe_gspro_capture(gspro: dict, *, keep_pixels: bool = False) -> dict:
    """Read a confirmed GSPro HWND without changing focus, cursor, or files."""
    if gspro.get("status") != "connected":
        return {"status": "not-connected", "method": "PrintWindow", "reason": "no_gspro_window"}
    if gspro.get("minimized"):
        return {"status": "unavailable", "method": "PrintWindow", "reason": "window_minimized"}
    if os.name != "nt":
        return {"status": "unavailable", "method": "PrintWindow", "reason": "windows_only"}
    bounds = gspro.get("bounds") or {}
    width, height = int(bounds.get("width", 0)), int(bounds.get("height", 0))
    if width < 300 or height < 200 or width * height > MAX_CAPTURE_PIXELS:
        return {"status": "unavailable", "method": "PrintWindow", "reason": "invalid_window_dimensions"}

    if not _CAPTURE_LOCK.acquire(blocking=False):
        return {"status": "busy", "method": "PrintWindow", "reason": "capture_in_progress"}
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        user32.GetWindowDC.argtypes = [wintypes.HWND]
        user32.GetWindowDC.restype = wintypes.HDC
        user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        user32.PrintWindow.restype = wintypes.BOOL
        gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
        gdi32.CreateCompatibleDC.restype = wintypes.HDC
        gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
        gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
        gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        gdi32.SelectObject.restype = wintypes.HGDIOBJ
        gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        gdi32.DeleteDC.argtypes = [wintypes.HDC]
        gdi32.GetDIBits.argtypes = [
            wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
            ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
        ]
        gdi32.GetDIBits.restype = ctypes.c_int

        hwnd = gspro["hwnd"]
        source_dc = user32.GetWindowDC(hwnd)
        if not source_dc:
            return {"status": "unavailable", "method": "PrintWindow", "reason": "no_window_dc"}
        dest_dc = None
        bitmap = None
        selected = None
        try:
            dest_dc = gdi32.CreateCompatibleDC(source_dc)
            if not dest_dc:
                raise OSError("CreateCompatibleDC failed")
            bitmap = gdi32.CreateCompatibleBitmap(source_dc, width, height)
            if not bitmap:
                raise OSError("CreateCompatibleBitmap failed")
            selected = gdi32.SelectObject(dest_dc, bitmap)
            if not selected:
                raise OSError("SelectObject failed")

            # 0x2 = PW_RENDERFULLCONTENT. This may return a black frame
            # for some GPU/Unity windows, even if the API itself succeeds.
            printed = bool(user32.PrintWindow(hwnd, dest_dc, 0x2))
            gdi32.SelectObject(dest_dc, selected)
            selected = None
            if not printed:
                return {"status": "unsupported", "method": "PrintWindow", "reason": "print_window_failed"}

            info = BITMAPINFO()
            info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height  # top-down
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            info.bmiHeader.biCompression = 0  # BI_RGB
            pixels = ctypes.create_string_buffer(width * height * 4)
            rows = gdi32.GetDIBits(
                dest_dc, bitmap, 0, height, pixels,
                ctypes.byref(info), 0,
            )
            if rows != height:
                return {"status": "unsupported", "method": "PrintWindow", "reason": "no_bitmap_pixels"}

            assessment = assess_bgra_frame(pixels.raw, width, height)
            return {
                "status": "captured" if assessment["nonblank"] else "unsupported",
                "method": "PrintWindow",
                "reason": None if assessment["nonblank"] else "blank_or_low_detail_frame",
                "windowWidth": width,
                "windowHeight": height,
                "foreground": bool(gspro.get("foreground")),
                "quality": assessment,
                # Only native, explicitly opted-in callers can access raw bytes.
                # The HTTP diagnostic invokes the default keep_pixels=False.
                **({"_private_bgra": pixels.raw} if keep_pixels and assessment["nonblank"] else {}),
            }
        finally:
            if selected and dest_dc:
                gdi32.SelectObject(dest_dc, selected)
            if bitmap:
                gdi32.DeleteObject(bitmap)
            if dest_dc:
                gdi32.DeleteDC(dest_dc)
            user32.ReleaseDC(hwnd, source_dc)
    except Exception as error:
        return {"status": "error", "method": "PrintWindow", "reason": type(error).__name__}
    finally:
        _CAPTURE_LOCK.release()
