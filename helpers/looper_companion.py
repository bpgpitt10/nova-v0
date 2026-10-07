#!/usr/bin/env python3
"""Looper's existing Windows companion, extended with a read-only Auto Aim bridge.

Stage A only: report the connected companion and locate a visible GSPro process
window. No desktop input, no arbitrary file operation, and no aim commands.
The existing /health, /wind, /lie and /derive endpoints remain compatible.
"""

import ctypes
from ctypes import wintypes
import json
import os
import re
from urllib.parse import urlsplit

import open_golf_coach_helper_lie_footer as lie_footer

base = lie_footer.base
COMPANION_VERSION = "autoaim-stage-a.1"
COMPANION_STATUS_PATH = "/companion/v1/status"

EXACT_ALLOWED_ORIGINS = frozenset({
    "https://thelooper.golf",
    "https://www.thelooper.golf",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
})

# Only the Looper Vercel project in this connected team, not arbitrary
# *.vercel.app pages. Aim commands (later stages) will also require pairing.
LOOPER_PREVIEW_ORIGIN = re.compile(
    r"https://(?:looper|looper-web)[a-z0-9-]*-wqk25hkxcg-3591\.vercel\.app"
)


def is_allowed_origin(origin: str | None) -> bool:
    if origin is None:
        # Command-line health probes don't set Origin. Read-only status only.
        return True
    return origin in EXACT_ALLOWED_ORIGINS or bool(
        LOOPER_PREVIEW_ORIGIN.fullmatch(origin)
    )


def _process_image_name(pid: int) -> str | None:
    """Read executable basename from the actual PID, never just a window title."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    # PROCESS_QUERY_LIMITED_INFORMATION; no elevation required for same-user GSPro.
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        capacity = 32768
        image_path = ctypes.create_unicode_buffer(capacity)
        length = wintypes.DWORD(capacity)
        if not kernel32.QueryFullProcessImageNameW(
            handle, 0, image_path, ctypes.byref(length)
        ):
            return None
        return os.path.basename(image_path.value).lower()
    finally:
        kernel32.CloseHandle(handle)


def discover_gspro_window() -> dict:
    """Find an interactive GSPro window by verified executable identity + HWND."""
    if os.name != "nt":
        return {"status": "waiting", "reason": "windows_only"}

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND, ctypes.POINTER(wintypes.DWORD)
    ]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

    candidates = {}
    executable_cache = {}
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def on_window(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return True
        if pid.value not in executable_cache:
            executable_cache[pid.value] = _process_image_name(pid.value)
        executable_name = executable_cache[pid.value] or ""
        if not executable_name.startswith("gspro") or not executable_name.endswith(".exe"):
            return True

        title_length = user32.GetWindowTextLengthW(hwnd)
        title_buffer = ctypes.create_unicode_buffer(max(1, title_length + 1))
        user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
        # Prefer a named game window over a splash screen or hidden helper HWND.
        priority = (2 if "gspro" in title_buffer.value.lower() else 1) + (
            1 if executable_name == "gspro.exe" else 0
        )
        prior = candidates.get(pid.value)
        candidate = {
            "pid": pid.value,
            "processName": executable_name,
            "windowTitle": title_buffer.value[:100],
            "priority": priority,
        }
        if prior is None or candidate["priority"] > prior["priority"]:
            candidates[pid.value] = candidate
        return True

    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.EnumWindows(on_window, 0)

    if not candidates:
        return {"status": "waiting", "reason": "gspro_window_not_found"}
    if len(candidates) > 1:
        return {"status": "ambiguous", "processCount": len(candidates)}
    match = next(iter(candidates.values()))
    return {
        "status": "connected",
        "pid": match["pid"],
        "processName": match["processName"],
        "windowTitle": match["windowTitle"],
    }


class LooperCompanionHandler(base.OpenGolfCoachHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        """Preserve the existing helper protocol while new endpoints are isolated."""
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status_code != 204:
            self.wfile.write(body)

    def _is_loopback_host(self) -> bool:
        host = self.headers.get("Host", "").lower()
        port = self.server.server_port
        return host in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _send_companion(self, status_code: int, payload: dict) -> None:
        origin = self.headers.get("Origin")
        body = b"" if status_code == 204 else json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        if origin and is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _companion_authorized(self) -> bool:
        return self._is_loopback_host() and is_allowed_origin(
            self.headers.get("Origin")
        )

    def do_OPTIONS(self) -> None:
        if urlsplit(self.path).path == COMPANION_STATUS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            self._send_companion(204, {})
            return
        super().do_OPTIONS()

    def do_GET(self) -> None:
        if urlsplit(self.path).path == COMPANION_STATUS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            self._send_companion(200, {
                "service": "looper-companion",
                "version": COMPANION_VERSION,
                "status": "ready",
                "gspro": discover_gspro_window(),
                "capabilities": {
                    "windowDiscovery": True,
                    "folderDiscovery": False,
                    "nativeCapture": False,
                    "autoAim": False,
                },
            })
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlsplit(self.path).path.startswith("/companion/"):
            self._send_companion(405, {"error": "actuation_not_implemented"})
            return
        super().do_POST()


base.HELPER_HEALTH_VERSION = "6-looper-companion"


if __name__ == "__main__":
    # Force loopback even if OPEN_GOLF_COACH_HOST is overridden.
    server = base.ThreadingHTTPServer(("127.0.0.1", base.PORT), LooperCompanionHandler)
    server.serve_forever()
