#!/usr/bin/env python3
"""Looper's existing Windows companion, extended with a read-only Auto Aim bridge.

Stage C: keep read-only GSPro discovery plus on-demand capture diagnostics,
and package the proven offline minimap registration/preflight library.
No desktop input and no HTTP aim commands. GSPro's folder is never written;
the only file writes are the round recorder's own records under
%LOCALAPPDATA%\\Looper\\Companion\\rounds.
The existing /health, /wind, /lie and /derive endpoints remain compatible.
/companion/v1/course-layouts serves the course's GKD/GKDalt text (read-only, no paths)
so the web app can place native positions without a browser folder grant.
/companion/v1/gspro-file serves GSPro's currentRound.dat, output_log.txt and GSPro.db
(read-only, allowlisted names, no paths) so the web app needs no GSPro folder grant.
/companion/v1/round-records serves every round the recorder has kept.
"""

import json
import math
import re
import threading
import time
from urllib.parse import parse_qs, urlsplit

import open_golf_coach_helper_lie_footer as lie_footer
import gspro_native_discovery as native
import gspro_course_library as course_library  # read-only GKD/GKDalt access
import gspro_native_aim as native_aim  # Auto Aim step 1: where Looper would click; no input
import gspro_window_capture as capture
import gspro_direct_click as native_click  # one-click actuator, used only by aim-click
import gspro_aim_click as aim_click
import gspro_minimap_pipeline as minimap_pipeline  # CV core; only capture_native_bgr is used by HTTP (aim preview)
import gspro_live_observations as observations  # read-only diagnostic; no desktop input
import gspro_native_lie_ocr as native_lie
import gspro_native_wind_ocr as native_wind  # HWND-only wind OCR; no desktop screenshot
import gspro_file_bridge as file_bridge  # read-only GSPro files + round recorder

base = lie_footer.base
COMPANION_VERSION = "courses.10"
# The player-facing release number. Bump it when a build goes out to players;
# the release workflow publishes v<COMPANION_RELEASE> to the public releases
# repo and writes latest.json, which the web app compares with the running
# companion's "release" to show "update available" / "needs update".
COMPANION_RELEASE = "1.0.0"
COMPANION_STATUS_PATH = "/companion/v1/status"
COMPANION_CAPTURE_PATH = "/companion/v1/capture-check"
COMPANION_OBSERVATIONS_PATH = "/companion/v1/observations"
COMPANION_COURSE_LAYOUTS_PATH = "/companion/v1/course-layouts"
COMPANION_AIM_PREVIEW_PATH = "/companion/v1/aim-preview"
# The one input endpoint: POST only, explicit intent header, allowlisted Origin.
COMPANION_AIM_CLICK_PATH = "/companion/v1/aim-click"
AIM_CLICK_INTENT = "aim-click"
AIM_CLICK_MIN_INTERVAL_S = 1.5
COMPANION_COURSE_LIBRARY_PATH = "/companion/v1/course-library"
COMPANION_GSPRO_FILE_PATH = "/companion/v1/gspro-file"
COMPANION_ROUND_RECORDS_PATH = "/companion/v1/round-records"
COMPANION_ROUND_PARS_PATH = "/companion/v1/round-pars"
COMPANION_READ_PATHS = (
    COMPANION_GSPRO_FILE_PATH,
    COMPANION_ROUND_RECORDS_PATH,
    COMPANION_ROUND_PARS_PATH,
    COMPANION_COURSE_LIBRARY_PATH,
    COMPANION_AIM_PREVIEW_PATH,
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


def _gspro_image_path() -> str | None:
    try:
        window = native.find_gspro_window()
    except Exception:
        return None
    return window.get("imagePath") if isinstance(window, dict) else None


GSPRO_DATA_FOLDER = file_bridge.DataFolder(
    lambda: native.discover_gspro_data_directory(image_path=_gspro_image_path())
)
ROUND_RECORDER: "file_bridge.RoundRecorder | None" = None
AIM_CLICK_LOCK = threading.Lock()
LAST_AIM_CLICK_AT = float("-inf")


def _query_int(query: dict, key: str) -> int | None:
    raw = (query.get(key) or [None])[0]
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


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

    def _send_companion(self, status_code: int, payload: dict, *,
                        methods: str = "GET, OPTIONS", headers: str = "Content-Type") -> None:
        origin = self.headers.get("Origin")
        body = b"" if status_code == 204 else json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        if origin and is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", methods)
            self.send_header("Access-Control-Allow-Headers", headers)
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_companion_bytes(self, info: dict, data: bytes) -> None:
        """Raw bytes for an allowlisted GSPro file, with size/time headers."""
        origin = self.headers.get("Origin")
        self.send_response(200)
        if origin and is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header(
                "Access-Control-Expose-Headers",
                "X-Looper-File-Size, X-Looper-Last-Modified, X-Looper-Range-Start",
            )
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Looper-File-Size", str(info["size"]))
        self.send_header("X-Looper-Last-Modified", str(info["lastModified"]))
        self.send_header("X-Looper-Range-Start", str(info.get("start", 0)))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _companion_authorized(self) -> bool:
        return self._is_loopback_host() and is_allowed_origin(
            self.headers.get("Origin")
        )

    def _aim_click_authorized(self) -> bool:
        """Stricter than reads: a real allowlisted Origin (no header-less
        callers), JSON body, and the explicit intent header, which also forces
        a CORS preflight so no other site can trigger a click."""
        origin = self.headers.get("Origin")
        return (
            self._is_loopback_host()
            and origin is not None
            and is_allowed_origin(origin)
            and (self.headers.get("Content-Type") or "").split(";")[0].strip() == "application/json"
            and self.headers.get("X-Looper-Intent") == AIM_CLICK_INTENT
        )

    def _handle_aim_click(self) -> None:
        if not self._aim_click_authorized():
            self._send_companion(403, {"error": "origin_or_intent_forbidden"}, methods="POST, OPTIONS",
                                 headers="Content-Type, X-Looper-Intent")
            return
        base_payload = {"service": "looper-companion", "version": COMPANION_VERSION,
                        "schemaVersion": aim_click.SCHEMA_VERSION}

        def reply(payload: dict) -> None:
            self._send_companion(200, {**base_payload, **payload}, methods="POST, OPTIONS",
                                 headers="Content-Type, X-Looper-Intent")

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= 4096:
            reply({"status": "blocked", "reason": "invalid-request"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            ball = (float(body["ballX"]), float(body["ballZ"]))
            pin = (float(body["pinX"]), float(body["pinZ"]))
            target = (float(body["targetX"]), float(body["targetZ"]))
            shot_key = str(body["shotKey"])
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            reply({"status": "blocked", "reason": "invalid-request"})
            return
        global LAST_AIM_CLICK_AT
        with AIM_CLICK_LOCK:
            if time.monotonic() - LAST_AIM_CLICK_AT < AIM_CLICK_MIN_INTERVAL_S:
                reply({"status": "blocked", "reason": "too-soon"})
                return
            try:
                result = aim_click.aim_click(
                    ball_world=ball, pin_world=pin, target_world=target, shot_key=shot_key,
                    find_window=native.find_gspro_window,
                    capture=minimap_pipeline.capture_native_bgr,
                    click=native_click.execute_prepared_click,
                )
            except Exception as error:  # never let an input request crash the server
                result = {"status": "blocked", "reason": "unavailable", "detail": type(error).__name__}
            if result.get("status") == "clicked":
                LAST_AIM_CLICK_AT = time.monotonic()
        reply(result)

    def do_OPTIONS(self) -> None:
        if urlsplit(self.path).path == COMPANION_AIM_CLICK_PATH:
            if not (self._is_loopback_host() and self.headers.get("Origin")
                    and is_allowed_origin(self.headers.get("Origin"))):
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            self._send_companion(204, {}, methods="POST, OPTIONS", headers="Content-Type, X-Looper-Intent")
            return
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
                "release": COMPANION_RELEASE,
                "status": "ready",
                "gspro": context["gspro"],
                "dataFolder": context["dataFolder"],
                "capabilities": {
                    "windowDiscovery": True,
                    "folderDiscovery": True,
                    "captureDiagnostic": True,
                    "liveObservations": True,
                    "courseLayouts": True,
                    "aimPreview": True,
                    "courseLibrary": True,
                    "gsproFiles": True,
                    "roundRecorder": ROUND_RECORDER is not None,
                    "roundPars": ROUND_RECORDER is not None,
                    "nativeCapture": False,
                    # Auto Aim as a background feature stays off; the only input
                    # is one minimap click per explicit Arm (aim-click).
                    "autoAim": False,
                    "aimClick": True,
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
        if urlsplit(self.path).path == COMPANION_GSPRO_FILE_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            # Read-only, allowlisted names only; never a path from the browser.
            query = parse_qs(urlsplit(self.path).query)
            name = (query.get("name") or [""])[0]
            directory = GSPRO_DATA_FOLDER.directory()
            if (query.get("stat") or [""])[0] == "1":
                info = file_bridge.stat_gspro_file(directory, name)
                self._send_companion(200, {"service": "looper-companion",
                                           "version": COMPANION_VERSION, **info})
                return
            info, data = file_bridge.read_gspro_file(
                directory, name, _query_int(query, "start"), _query_int(query, "end"))
            if info["status"] != "ok":
                code = 403 if info["status"] == "forbidden" else 404
                self._send_companion(code, {"service": "looper-companion",
                                            "version": COMPANION_VERSION, **info})
                return
            self._send_companion_bytes(info, data)
            return
        if urlsplit(self.path).path == COMPANION_ROUND_PARS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            # GSPro's own par per hole, per round (the scorecard GSPro scores with).
            self._send_companion(200, {
                "service": "looper-companion", "version": COMPANION_VERSION,
                "schemaVersion": "looper-companion-round-pars-v1",
                "status": "ok" if ROUND_RECORDER is not None else "unavailable",
                "rounds": ROUND_RECORDER.round_pars() if ROUND_RECORDER is not None else [],
            })
            return
        if urlsplit(self.path).path == COMPANION_ROUND_RECORDS_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            base_payload = {"service": "looper-companion", "version": COMPANION_VERSION,
                            "schemaVersion": "looper-companion-round-records-v1"}
            if ROUND_RECORDER is None:
                self._send_companion(200, {**base_payload, "status": "unavailable",
                                           "records": [], "nextAfter": 0, "more": False})
                return
            query = parse_qs(urlsplit(self.path).query)
            page = ROUND_RECORDER.records_after(
                _query_int(query, "after") or 0, _query_int(query, "limit") or 500)
            self._send_companion(200, {**base_payload, "status": "ok", **page})
            return
        if urlsplit(self.path).path == COMPANION_COURSE_LIBRARY_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            # Read-only: names, locations and keys of installed GSPro courses
            # so Looper can offer them for loading. No paths or geometry.
            try:
                window = native.find_gspro_window()
                image_path = window.get("imagePath") if isinstance(window, dict) else None
            except Exception:
                image_path = None
            try:
                payload = course_library.list_installed_courses(image_path=image_path)
            except Exception as error:
                payload = {"service": "looper-companion", "schemaVersion": course_library.LIBRARY_SCHEMA_VERSION,
                           "status": "unavailable", "reason": type(error).__name__, "courses": []}
            payload["version"] = COMPANION_VERSION
            self._send_companion(200, payload)
            return
        if urlsplit(self.path).path == COMPANION_AIM_PREVIEW_PATH:
            if not self._companion_authorized():
                self._send_companion(403, {"error": "origin_or_host_forbidden"})
                return
            # Read-only: one capture of GSPro's window, minimap only. Returns
            # where Looper WOULD click and a small annotated minimap crop.
            # Never moves the mouse or sends input.
            query = parse_qs(urlsplit(self.path).query)
            try:
                values = {k: float((query.get(k) or ["nan"])[0])
                          for k in ("ballX", "ballZ", "pinX", "pinZ", "targetX", "targetZ")}
            except ValueError:
                values = {}
            base_payload = {"service": "looper-companion", "version": COMPANION_VERSION,
                            "schemaVersion": "looper-companion-aim-preview-v1", "input": "none"}
            if len(values) != 6 or not all(math.isfinite(v) and abs(v) < 1e6 for v in values.values()):
                self._send_companion(200, {**base_payload, "status": "invalid-request"})
                return
            try:
                window = native.find_gspro_window()
                if not isinstance(window, dict) or window.get("status") != "connected":
                    self._send_companion(200, {**base_payload, "status": "gspro-not-connected"})
                    return
                frame = minimap_pipeline.capture_native_bgr(window)
                result = native_aim.aim_preview(
                    frame,
                    ball_world=(values["ballX"], values["ballZ"]),
                    pin_world=(values["pinX"], values["pinZ"]),
                    target_world=(values["targetX"], values["targetZ"]),
                )
                self._send_companion(200, {**base_payload, **result})
            except Exception as error:
                self._send_companion(200, {**base_payload, "status": "unavailable",
                                           "reason": str(error)[:160]})
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
                waypoints = (parse_qs(urlsplit(self.path).query).get("waypoints") or ["1"])[0] != "0"
                payload = observations.collect_observations(include_waypoints=waypoints)
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
        if urlsplit(self.path).path == COMPANION_AIM_CLICK_PATH:
            self._handle_aim_click()
            return
        if urlsplit(self.path).path.startswith("/companion/"):
            self._send_companion(405, {"error": "actuation_not_implemented"})
            return
        super().do_POST()


base.HELPER_HEALTH_VERSION = "6-looper-companion"


def start_round_recorder() -> "threading.Event":
    """Keep every round from Windows start, whether or not a browser is open."""
    global ROUND_RECORDER
    stop = threading.Event()
    try:
        ROUND_RECORDER = file_bridge.RoundRecorder(
            file_bridge.default_store_dir(),
            file_bridge.current_round_reader(GSPRO_DATA_FOLDER),
            file_bridge.log_tail_reader(GSPRO_DATA_FOLDER),
        )
    except Exception:
        ROUND_RECORDER = None  # never stop the companion over the recorder
        return stop
    threading.Thread(target=ROUND_RECORDER.run_forever, args=(stop,),
                     name="looper-round-recorder", daemon=True).start()
    return stop


if __name__ == "__main__":
    start_round_recorder()
    # Force loopback even if OPEN_GOLF_COACH_HOST is overridden.
    server = base.ThreadingHTTPServer(("127.0.0.1", base.PORT), LooperCompanionHandler)
    server.serve_forever()
