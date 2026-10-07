"""Read-only GSPro native process/window/data-folder discovery for Looper.

No filesystem writes. The loopback status endpoint only exposes diagnostic
labels and file presence, never full usernames, paths, or GSPro contents.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
from typing import Mapping


REQUIRED_GSPRO_FILES = ("currentRound.dat", "output_log.txt", "GSPro.db")


def gspro_candidate_directories(
    *,
    image_path: str | None = None,
    local_app_data: str | None = None,
    home: Path | None = None,
) -> list[tuple[str, Path]]:
    """Probe the actual GSPro user data root, NOT only the binary install dir."""
    user_home = Path(home) if home is not None else Path.home()
    appdata = local_app_data if local_app_data is not None else os.environ.get("LOCALAPPDATA")
    appdata_path = Path(appdata) if appdata else user_home / "AppData" / "Local"
    local_low = appdata_path.parent / "LocalLow"
    paths: list[tuple[str, Path]] = [
        ("user-locallow", local_low / "GSPro" / "GSPro"),
        ("user-locallow-parent", local_low / "GSPro"),
    ]
    if image_path:
        image_dir = Path(image_path).parent
        paths.extend([
            ("process-dir", image_dir),
            ("process-data", image_dir / "GSPro_Data"),
            ("process-parent", image_dir.parent / "GSPro"),
            ("process-parent-data", image_dir.parent / "GSPro_Data"),
        ])

    results: list[tuple[str, Path]] = []
    seen = set()
    for label, path in paths:
        key = os.path.normcase(os.path.abspath(str(path)))
        if key not in seen:
            seen.add(key)
            results.append((label, path))
    return results


def _probe_directory(label: str, path: Path) -> dict:
    try:
        exists = path.is_dir()
        found = {
            filename: exists and (path / filename).is_file()
            for filename in REQUIRED_GSPRO_FILES
        }
    except OSError:
        exists = False
        found = {filename: False for filename in REQUIRED_GSPRO_FILES}
    return {
        "source": label,
        "directory": path,
        "exists": exists,
        "files": found,
        "fileCount": sum(found.values()),
    }


def choose_best_gspro_directory(
    candidates: list[tuple[str, Path]],
) -> dict:
    """Deterministic, fail-closed selection; an empty install dir is not data."""
    matches = [_probe_directory(label, path) for label, path in candidates]
    weighted = lambda item: (
        int(item["files"]["currentRound.dat"]) * 5
        + int(item["files"]["GSPro.db"]) * 4
        + int(item["files"]["output_log.txt"]) * 2
    )
    valid = [item for item in matches if item["fileCount"] > 0]
    if not valid:
        return {
            "status": "not-found",
            "source": None,
            "files": {file: False for file in REQUIRED_GSPRO_FILES},
            "directory": None,
            "reason": "no_gspro_data_files",
        }
    best = sorted(valid, key=lambda entry: -weighted(entry))[0]
    return {
        "status": "ready" if best["files"]["currentRound.dat"] and best["files"]["output_log.txt"] else "partial",
        "source": best["source"],
        "files": best["files"],
        "directory": best["directory"],
        "reason": None if best["fileCount"] == len(REQUIRED_GSPRO_FILES) else "some_files_missing",
    }


def discover_gspro_data_directory(
    *,
    image_path: str | None = None,
    local_app_data: str | None = None,
    home: Path | None = None,
) -> dict:
    return choose_best_gspro_directory(gspro_candidate_directories(
        image_path=image_path, local_app_data=local_app_data, home=home
    ))


def public_data_folder_status(discovered: dict) -> dict:
    """Avoid disclosing absolute local paths to the hosted application."""
    return {
        "status": discovered["status"],
        "source": discovered["source"],
        "files": discovered["files"],
        "reason": discovered["reason"],
    }


def process_image_path(pid: int) -> str | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        capacity = 32768
        buffer = ctypes.create_unicode_buffer(capacity)
        length = wintypes.DWORD(capacity)
        if kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(length)
        ):
            return buffer.value
    finally:
        kernel32.CloseHandle(handle)
    return None


def find_gspro_window() -> dict:
    """Query top-level HWNDs, tie each to an actual process executable."""
    if os.name != "nt":
        return {"status": "waiting", "reason": "windows_only"}

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND, ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND

    process_paths: dict[int, str | None] = {}
    candidates: dict[int, dict] = {}
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def on_window(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return True
        if pid.value not in process_paths:
            process_paths[pid.value] = process_image_path(pid.value)
        image_path = process_paths[pid.value]
        if not image_path:
            return True

        name = Path(image_path).name.lower()
        # The Unity executable can have GSPro variants; reject unrelated apps.
        if not name.startswith("gspro") or not name.endswith(".exe"):
            return True

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if width < 300 or height < 200:
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(max(1, length + 1))
        user32.GetWindowTextW(hwnd, title, len(title))
        minimized = bool(user32.IsIconic(hwnd))
        current = {
            "pid": pid.value,
            "hwnd": int(hwnd),
            "imagePath": image_path,
            "processName": name,
            "title": title.value[:100],
            "foreground": int(user32.GetForegroundWindow()) == int(hwnd),
            "minimized": minimized,
            "bounds": {
                "left": rect.left, "top": rect.top,
                "width": width, "height": height,
            },
        }
        prior = candidates.get(pid.value)
        priority = (
            (2 if "gspro" in title.value.lower() else 0)
            + (1 if name == "gspro.exe" else 0)
            + (1 if not minimized else 0)
            + min(2, (width * height) // 1500000)
        )
        if prior is None or priority > prior["priority"]:
            current["priority"] = priority
            candidates[pid.value] = current
        return True

    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.EnumWindows(on_window, 0)

    if not candidates:
        return {"status": "waiting", "reason": "gspro_window_not_found"}
    if len(candidates) != 1:
        return {"status": "ambiguous", "reason": "multiple_gspro_processes", "processCount": len(candidates)}
    winner = next(iter(candidates.values()))
    del winner["priority"]
    winner["status"] = "connected"
    return winner


def public_gspro_window_status(private: dict) -> dict:
    if private["status"] != "connected":
        return private
    return {
        "status": "connected",
        "pid": private["pid"],
        "processName": private["processName"],
        "windowTitle": private["title"],
        "window": {
            "foreground": private["foreground"],
            "minimized": private["minimized"],
            "bounds": private["bounds"],
        },
    }
