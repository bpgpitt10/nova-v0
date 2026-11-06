"""Minimal GSPro Open Connect client for the lie lab.

GSPro listens on 127.0.0.1:921 (GSPconnect). One launch-monitor client at a
time, so close the Uneekor launcher before connecting.

Protocol notes (GSPro Open Connect v1 doc, plus what other developers report):
- Send one JSON object per shot. We end each with CRLF.
- GSPro replies with JSON objects run together with nothing between them.
  Codes: 200 shot received, 201 player info (club, distance to target),
  202 ball stopped / ready for the next shot (reported for API v2; not
  guaranteed under v1, so the runner has a fallback).
- Send a heartbeat about once a second or the connection goes stale.
- Send DisconnectLaunchMonitor before closing, or GSPconnect keeps the dead
  socket and refuses the next client.

Standard library only so it runs on the sim PC with a plain Python install.
"""

from __future__ import annotations

import json
import queue
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 921
DEVICE_ID = "Looper Lie Lab v1"


@dataclass(frozen=True)
class Launch:
    ballSpeedMph: float
    vlaDeg: float
    hlaDeg: float
    spinRpm: float
    spinAxisDeg: float


def _header(shot_number: int, api_version: str) -> dict[str, Any]:
    return {
        "DeviceID": DEVICE_ID,
        "Units": "Yards",
        "ShotNumber": shot_number,
        "APIversion": api_version,
    }


def shot_message(shot_number: int, launch: Launch, api_version: str = "1") -> dict[str, Any]:
    """A ball-data-only shot. CarryDistance is omitted so GSPro solves the flight."""
    import math

    axis = math.radians(launch.spinAxisDeg)
    message = _header(shot_number, api_version)
    message["BallData"] = {
        "Speed": round(launch.ballSpeedMph, 2),
        "SpinAxis": round(launch.spinAxisDeg, 2),
        "TotalSpin": round(launch.spinRpm, 1),
        # Consistent back/side spin too, for builds that read those instead.
        "BackSpin": round(launch.spinRpm * math.cos(axis), 1),
        "SideSpin": round(launch.spinRpm * math.sin(axis), 1),
        "HLA": round(launch.hlaDeg, 2),
        "VLA": round(launch.vlaDeg, 2),
    }
    message["ShotDataOptions"] = {
        "ContainsBallData": True,
        "ContainsClubData": False,
        "LaunchMonitorIsReady": True,
        "LaunchMonitorBallDetected": True,
        "IsHeartBeat": False,
    }
    return message


def player_info_message(shot_number: int, api_version: str = "1") -> dict[str, Any]:
    """Ask GSPro to say who is up: it answers 201 with the club and distance to target."""
    message = heartbeat_message(shot_number, api_version)
    message["ShotDataOptions"]["IsHeartBeat"] = False
    message["ShotDataOptions"]["LaunchMonitorBallDetected"] = False
    message["ShotDataOptions"]["SendPlayerInformationToDevice"] = True
    return message


def heartbeat_message(shot_number: int, api_version: str = "1") -> dict[str, Any]:
    message = _header(shot_number, api_version)
    message["ShotDataOptions"] = {
        "ContainsBallData": False,
        "ContainsClubData": False,
        "LaunchMonitorIsReady": True,
        "LaunchMonitorBallDetected": True,
        "IsHeartBeat": True,
    }
    return message


def disconnect_message(shot_number: int, api_version: str = "1") -> dict[str, Any]:
    message = heartbeat_message(shot_number, api_version)
    message["ShotDataOptions"]["IsHeartBeat"] = False
    message["ShotDataOptions"]["LaunchMonitorIsReady"] = False
    # Placement of this flag isn't documented; set it in both places.
    message["ShotDataOptions"]["DisconnectLaunchMonitor"] = True
    message["DisconnectLaunchMonitor"] = True
    return message


class StreamParser:
    """Splits run-together JSON objects from a TCP byte stream."""

    def __init__(self) -> None:
        self._buffer = ""
        self._decoder = json.JSONDecoder()

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        self._buffer += data.decode("utf-8", errors="replace")
        out: list[dict[str, Any]] = []
        while True:
            stripped = self._buffer.lstrip()
            if not stripped:
                self._buffer = ""
                break
            start = stripped.find("{")
            if start < 0:
                self._buffer = ""
                break
            stripped = stripped[start:]
            try:
                value, end = self._decoder.raw_decode(stripped)
            except json.JSONDecodeError:
                # Incomplete object: keep it for the next chunk.
                self._buffer = stripped
                break
            self._buffer = stripped[end:]
            if isinstance(value, dict):
                out.append(value)
        return out


class OpenConnectError(RuntimeError):
    pass


class OpenConnectClient:
    """Persistent connection with a reader thread and a heartbeat thread."""

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        api_version: str = "1",
        heartbeat_s: float = 1.0,
        connect_timeout_s: float = 5.0,
    ) -> None:
        self.host = host
        self.port = port
        self.api_version = api_version
        self.heartbeat_s = heartbeat_s
        self.connect_timeout_s = connect_timeout_s
        self.replies: "queue.Queue[tuple[float, dict[str, Any]]]" = queue.Queue()
        self.all_replies: list[tuple[float, dict[str, Any]]] = []
        self._sock: socket.socket | None = None
        self._send_lock = threading.Lock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._shot_number = 0
        self.last_player: dict[str, Any] | None = None

    # -- lifecycle ---------------------------------------------------------
    def connect(self) -> None:
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout_s)
        except OSError as exc:
            raise OpenConnectError(
                f"Could not connect to GSPro Open Connect at {self.host}:{self.port} ({exc}). "
                "Is GSPro running with GSPconnect open, and is the Uneekor launcher closed?"
            ) from exc
        sock.settimeout(0.25)
        self._sock = sock
        self._stop.clear()
        for target in (self._reader, self._heartbeat):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self._threads.append(thread)

    def close(self) -> None:
        if self._sock is None:
            return
        try:
            self._send(disconnect_message(self._shot_number, self.api_version))
            time.sleep(0.3)
        except OSError:
            pass
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=2.0)
        try:
            self._sock.close()
        finally:
            self._sock = None
            self._threads = []

    def __enter__(self) -> "OpenConnectClient":
        self.connect()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- io ----------------------------------------------------------------
    def _send(self, message: dict[str, Any]) -> None:
        if self._sock is None:
            raise OpenConnectError("Not connected.")
        wire = (json.dumps(message, separators=(",", ":")) + "\r\n").encode("utf-8")
        with self._send_lock:
            self._sock.sendall(wire)

    def _reader(self) -> None:
        parser = StreamParser()
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                chunk = self._sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            now = time.monotonic()
            for reply in parser.feed(chunk):
                if reply.get("Code") == 201 and isinstance(reply.get("Player"), dict):
                    self.last_player = reply["Player"]
                self.all_replies.append((now, reply))
                self.replies.put((now, reply))

    def _heartbeat(self) -> None:
        while not self._stop.wait(self.heartbeat_s):
            try:
                self._send(heartbeat_message(self._shot_number, self.api_version))
            except OSError:
                break

    def request_player_info(self, wait_s: float = 1.0) -> dict[str, Any] | None:
        """Ask GSPro who is up; returns the Player block of its 201 reply, if it sends one."""
        self.drain()
        self._send(player_info_message(self._shot_number, self.api_version))
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            try:
                _, reply = self.replies.get(timeout=0.2)
            except queue.Empty:
                continue
            if reply.get("Code") == 201 and isinstance(reply.get("Player"), dict):
                return reply["Player"]
        return None

    def drain(self) -> list[dict[str, Any]]:
        out = []
        while True:
            try:
                out.append(self.replies.get_nowait()[1])
            except queue.Empty:
                return out

    def fire(
        self,
        launch: Launch,
        wait_for_stop_s: float = 30.0,
        is_done: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Send one shot and wait until the ball has stopped.

        "Stopped" is GSPro's 202 reply when it sends one, otherwise is_done()
        (the caller watches GSPro's files), otherwise the timeout.
        """
        self.drain()
        self._shot_number += 1
        message = shot_message(self._shot_number, launch, self.api_version)
        sent = time.monotonic()
        self._send(message)
        replies: list[dict[str, Any]] = []
        got_received = False
        stop_source = "timeout"
        stopped_after: float | None = None
        deadline = sent + wait_for_stop_s
        while time.monotonic() < deadline:
            try:
                at, reply = self.replies.get(timeout=0.2)
            except queue.Empty:
                at, reply = None, None
            if reply is not None:
                replies.append(reply)
                code = reply.get("Code")
                if code == 200:
                    got_received = True
                elif isinstance(code, int) and code >= 500:
                    stop_source = "error"
                    break
                if code == 202:
                    stop_source = "202"
                    stopped_after = at - sent
                    break
            if not got_received and time.monotonic() > sent + 5.0:
                stop_source = "no-ack"
                break
            if got_received and is_done is not None and is_done():
                stop_source = "files"
                stopped_after = time.monotonic() - sent
                break
        return {
            "shotNumber": self._shot_number,
            "message": message,
            "replies": replies,
            "gotReceived": got_received,
            "stopSource": stop_source,
            "stoppedAfterS": stopped_after,
        }
