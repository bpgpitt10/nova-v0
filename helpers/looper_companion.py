#!/usr/bin/env python3
"""Looper's existing Windows companion, extended with a read-only Auto Aim bridge.

Stage C: keep read-only GSPro discovery plus on-demand capture diagnostics,
and package the proven offline minimap registration/preflight library.
No desktop input, no file writes, and no HTTP aim commands.
The existing /health, /wind, /lie and /derive endpoints remain compatible.
/companion/v1/course-layouts serves the course's GKD/GKDalt text (read-only, no paths)
so the web app can place native positions without a browser folder grant.
"""

import json
import re
from urllib.parse import parse_qs, urlsplit

import open_golf_coach_helper_lie_footer as lie_footer
import gspro_native_discovery as native
import gspro_course_library as course_library  # read-only GKD/GKDalt access
import gspro_window_capture as capture
import gspro_direct_click as native_click  # disabled native actuator; no HTTP callers
import gspro_minimap_pipeline as minimap_pipeline  # packaged offline CV core; never called by HTTP
import gspro_live_observations as observations  # read-only diagnostic; no desktop input
import gspro_native_lie_ocr as native_lie
import gspro_native_wind_ocr as native_wind  # HWND-only wind OCR; no desktop screenshot

base = lie_footer.base
COMPANION_VERSION = "autoaim-stage-c-preflight.1"
COMPANION_STATUS_PATH = "/companion/v1/status"
COMPANION_CAPTURE_PATH = "/companion/v1/capture-check"
COMPANION_OBSERVATIONS_PATH = "/companion/v1/observations"
COMPANION_COURSE_LAYOUTS_PATH = "/companion/v1/course-layouts"
COMPANION_READ_PATHS = (
    COMPANION_STATUS_PATH,
    COMPANION_CAPTURE_PATH,
    COMPANION_OBSERVATIONS_PATH,
    COMPANION_COURSE_LAYOUTS_PATH,
)

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


def discover_gspro_context() -> dict:
    """Internal result includes private paths; never serialize them to browser."""
    window = native.find_gspro_window()
    data = native.discover_gspro_data_directory(
        image_path=window.get("imagePath")
    )
    return {
        "gspro": native.public_gspro_window_status(window),
        "dataFolder": native.public_data_folder_status(data),
        "_window": window,
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
            self.send_header("Access-Control-Allow-Private-Network", "true")
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
        if urlsplit(self.path).path in COMPANION_READ_PATHS:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            self._send_companion(204, {})
            return
        super().do_OPTIONS()

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/lie":
            window = native.find_gspro_window()
            self._write_json(200, native_lie.read_gspro_native_lie(window))
            return
        if urlsplit(self.path).path == "/wind":
            # Retain the established /wind route and payload shape, but ensure
            # the packaged Companion uses its own GSPro HWND, not CopyFromScreen.
            # No new write endpoint or Live Caddie shot-state parser.
            window = native.find_gspro_window()
            self._write_json(200, native_wind.read_gspro_native_wind(window))
            return
        if urlsplit(self.path).path == COMPANION_STATUS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            context = discover_gspro_context()
            self._send_companion(200, {
                "service": "looper-companion",
                "version": COMPANION_VERSION,
                "status": "ready",
                "gspro": context["gspro"],
                "dataFolder": context["dataFolder"],
                "capabilities": {
                    "windowDiscovery": True,
                    "folderDiscovery": True,
                    "captureDiagnostic": True,
                    "liveObservations": True,
                    "courseLayouts": True,
                    "nativeCapture": False,
                    "autoAim": False,
                },
            })
            return
        if urlsplit(self.path).path == COMPANION_CAPTURE_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            context = discover_gspro_context()
            self._send_companion(200, {
                "service": "looper-companion",
                "version": COMPANION_VERSION,
                "windowCapture": capture.probe_gspro_capture(context["_window"]),
            })
            return
        if urlsplit(self.path).path == COMPANION_COURSE_LAYOUTS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            # Read-only: the course's GKD/GKDalt text for the web app on this
            # machine. No paths; GKD_BAK revisions and other files never read.
            key = (parse_qs(urlsplit(self.path).query).get("courseKey") or [None])[0]
            try:
                window = native.find_gspro_window()
                image_path = window.get("imagePath") if isinstance(window, dict) else None
            except Exception:
                image_path = None
            try:
                payload = course_library.course_layouts(key, image_path=image_path)
            except Exception as error:
                payload = {
                    "service": "looper-companion",
                    "schemaVersion": course_library.SCHEMA_VERSION,
                    "courseKey": key,
                    "status": "unavailable",
                    "reason": type(error).__name__,
                    "layouts": [],
                }
            payload["version"] = COMPANION_VERSION
            self._send_companion(200, payload)
            return
        if urlsplit(self.path).path == COMPANION_OBSERVATIONS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            try:
                payload = observations.collect_observations()
                # This is read-only evidence, NOT a second live shot-state
                # authority. The existing browser Live Caddie owns transitions.
                payload["version"] = COMPANION_VERSION
                payload["stateAuthority"] = "diagnostic-only"
                self._send_companion(200, payload)
            except Exception as error:
                self._send_companion(200, {
                    "service": "looper-companion",
                    "version": COMPANION_VERSION,
                    "stateAuthority": "diagnostic-only",
                    "schemaVersion": "native-observations-v1",
                    "status": "unavailable",
                    "reason": type(error).__name__,
                    "capabilities": {"autoAim": False},
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
