#!/usr/bin/env python3
"""Controlled GSPro Open Connect calibration runner for Looper.

This is deliberately a LOCAL dev tool, not part of the browser app. It:
1. sends a frozen launch packet to GSPro Open Connect on 127.0.0.1:921,
2. waits for GSPro to persist the resulting DrivingRangeShot row,
3. captures carry/offline and the echoed launch metrics from GSPro.db,
4. writes/updates a portable calibration JSON file for the web inspector.

The runner does NOT change GSPro wind. Set the requested wind condition manually
in GSPro before each batch. That keeps the experimental boundary explicit and
avoids UI automation.

Official protocol: https://gsprogolf.com/GSProConnectV1.html
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 921
DEFAULT_TIMEOUT_S = 20.0
POLL_S = 0.15
SCHEMA_VERSION = "looper-gspro-physics-lab-v1"
DEVICE_ID = "Looper Physics Lab v1"


@dataclass(frozen=True)
class LaunchPacket:
    ballSpeedMph: float
    vlaDeg: float
    hlaDeg: float
    spinRpm: float
    spinAxisDeg: float


@dataclass(frozen=True)
class Condition:
    windMph: float
    windRelativeDeg: float
    label: str


@dataclass
class CapturedShot:
    shotNumber: int
    condition: Condition
    launch: LaunchPacket
    gsproRowId: int
    gsproDateCreated: str | float | int | None
    carryYds: float | None
    offlineYds: float | None
    totalDistanceYds: float | None
    peakHeightYds: float | None
    descentAngleDeg: float | None
    echoedBallSpeedMph: float | None
    echoedVlaDeg: float | None
    echoedHlaDeg: float | None
    echoedSpinRpm: float | None
    echoedSpinAxisDeg: float | None
    capturedAt: str
    rawShotData: dict[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def first_float(payload: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        parsed = as_float(payload.get(key))
        if parsed is not None:
            return parsed
    return None


def derive_spin(payload: dict[str, Any]) -> float | None:
    direct = first_float(payload, "TotalSpin", "Spin")
    if direct is not None:
        return direct
    back = as_float(payload.get("BackSpin"))
    side = as_float(payload.get("SideSpin"))
    if back is None or side is None:
        return None
    return (back * back + side * side) ** 0.5


def build_open_connect_shot(shot_number: int, launch: LaunchPacket) -> dict[str, Any]:
    # CarryDistance is intentionally omitted. GSPro must solve the shot from raw launch data.
    return {
        "DeviceID": DEVICE_ID,
        "Units": "Yards",
        "ShotNumber": shot_number,
        "APIversion": "1",
        "BallData": {
            "Speed": launch.ballSpeedMph,
            "SpinAxis": launch.spinAxisDeg,
            "TotalSpin": launch.spinRpm,
            "HLA": launch.hlaDeg,
            "VLA": launch.vlaDeg,
        },
        "ClubData": {
            "Speed": 0.0,
            "AngleOfAttack": 0.0,
            "FaceToTarget": 0.0,
            "Lie": 0.0,
            "Loft": 0.0,
            "Path": 0.0,
            "SpeedAtImpact": 0.0,
            "VerticalFaceImpact": 0.0,
            "HorizontalFaceImpact": 0.0,
            "ClosureRate": 0.0,
        },
        "ShotDataOptions": {
            "ContainsBallData": True,
            "ContainsClubData": False,
            "LaunchMonitorIsReady": True,
            "LaunchMonitorBallDetected": True,
            "IsHeartBeat": False,
        },
    }


def open_readonly_db(db_path: Path) -> sqlite3.Connection:
    # URI read-only mode reduces the chance that this dev tool interferes with GSPro writes.
    uri = f"file:{db_path.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=1.0)
    connection.row_factory = sqlite3.Row
    return connection


def latest_range_row(db_path: Path) -> sqlite3.Row | None:
    with open_readonly_db(db_path) as connection:
        row = connection.execute(
            "SELECT ID, DateCreated, ShotData FROM DrivingRangeShot ORDER BY ID DESC LIMIT 1"
        ).fetchone()
        return row


def latest_row_id(db_path: Path) -> int | None:
    row = latest_range_row(db_path)
    return int(row["ID"]) if row is not None else None


def wait_for_new_row(db_path: Path, previous_id: int | None, timeout_s: float) -> sqlite3.Row:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            row = latest_range_row(db_path)
            if row is not None:
                row_id = int(row["ID"])
                if previous_id is None or row_id > previous_id:
                    return row
        except sqlite3.Error as exc:
            # GSPro can briefly hold the file while writing; retry rather than losing the shot.
            last_error = exc
        time.sleep(POLL_S)
    suffix = f" Last SQLite error: {last_error}" if last_error else ""
    raise TimeoutError(f"Timed out waiting for a new DrivingRangeShot row.{suffix}")


def parse_response(buffer: bytes) -> list[dict[str, Any]]:
    """Best-effort parser for GSPro's small JSON responses.

    Open Connect is a persistent raw TCP stream. In practice response objects are small;
    json.JSONDecoder.raw_decode lets us handle adjacent/whitespace-separated objects.
    """
    text = buffer.decode("utf-8", errors="replace").strip()
    if not text:
        return []
    decoder = json.JSONDecoder()
    results: list[dict[str, Any]] = []
    index = 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        try:
            value, next_index = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            break
        if isinstance(value, dict):
            results.append(value)
        index = next_index
    return results


def connect_gspro(host: str, port: int, timeout_s: float) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=timeout_s)
    sock.settimeout(1.0)
    return sock


def send_shot(sock: socket.socket, payload: dict[str, Any]) -> list[dict[str, Any]]:
    wire = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sock.sendall(wire)
    # GSPro's documented success response is code 200. Player info (201) may also arrive.
    chunks: list[bytes] = []
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            chunk = sock.recv(8192)
        except socket.timeout:
            break
        if not chunk:
            break
        chunks.append(chunk)
        parsed = parse_response(b"".join(chunks))
        if any(item.get("Code") == 200 for item in parsed):
            return parsed
    parsed = parse_response(b"".join(chunks))
    if parsed and any(item.get("Code") in (200, 201) for item in parsed):
        return parsed
    raise RuntimeError(
        "GSPro did not return a documented success response. "
        f"Raw response: {b''.join(chunks)!r}"
    )


def capture_row(
    row: sqlite3.Row,
    shot_number: int,
    launch: LaunchPacket,
    condition: Condition,
) -> CapturedShot:
    raw_text = row["ShotData"]
    try:
        payload = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("GSPro DrivingRangeShot.ShotData was not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("GSPro DrivingRangeShot.ShotData did not contain an object.")

    return CapturedShot(
        shotNumber=shot_number,
        condition=condition,
        launch=launch,
        gsproRowId=int(row["ID"]),
        gsproDateCreated=row["DateCreated"],
        carryYds=first_float(payload, "Carry", "rawCarryGame", "rawCarryLM"),
        offlineYds=as_float(payload.get("Offline")),
        totalDistanceYds=as_float(payload.get("TotalDistance")),
        peakHeightYds=as_float(payload.get("PeakHeight")),
        descentAngleDeg=first_float(payload, "Decent", "Descent"),
        echoedBallSpeedMph=as_float(payload.get("BallSpeed")),
        echoedVlaDeg=as_float(payload.get("VLA")),
        echoedHlaDeg=as_float(payload.get("HLA")),
        echoedSpinRpm=derive_spin(payload),
        echoedSpinAxisDeg=first_float(payload, "rawSpinAxis", "SpinAxis"),
        capturedAt=utc_now(),
        rawShotData=payload,
    )


def launch_matches(capture: CapturedShot, tolerance: float = 0.15) -> tuple[bool, list[str]]:
    comparisons = {
        "ball speed": (capture.launch.ballSpeedMph, capture.echoedBallSpeedMph),
        "VLA": (capture.launch.vlaDeg, capture.echoedVlaDeg),
        "HLA": (capture.launch.hlaDeg, capture.echoedHlaDeg),
        "spin": (capture.launch.spinRpm, capture.echoedSpinRpm),
        "spin axis": (capture.launch.spinAxisDeg, capture.echoedSpinAxisDeg),
    }
    mismatches: list[str] = []
    for label, (expected, observed) in comparisons.items():
        if observed is None:
            mismatches.append(f"{label}: missing echo")
            continue
        limit = max(tolerance, abs(expected) * 0.002) if label == "spin" else tolerance
        if abs(expected - observed) > limit:
            mismatches.append(f"{label}: sent {expected}, GSPro row {observed}")
    return not mismatches, mismatches


def load_output(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "observations": [],
        }
    with path.open("r", encoding="utf-8") as handle:
        existing = json.load(handle)
    if not isinstance(existing, dict) or existing.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError(f"{path} is not a {SCHEMA_VERSION} file.")
    if not isinstance(existing.get("observations"), list):
        existing["observations"] = []
    return existing


def save_capture(path: Path, capture: CapturedShot) -> None:
    data = load_output(path)
    data["updatedAt"] = utc_now()
    data["observations"].append(asdict(capture))
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    temp.replace(path)


def condition_label(wind_mph: float, relative_deg: float, supplied: str | None) -> str:
    if supplied:
        return supplied
    if wind_mph == 0:
        return "calm"
    return f"{wind_mph:g} mph @ {relative_deg:g}°"


def run(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        print(f"ERROR: GSPro database not found: {db_path}", file=sys.stderr)
        return 2

    launch = LaunchPacket(
        ballSpeedMph=args.speed,
        vlaDeg=args.vla,
        hlaDeg=args.hla,
        spinRpm=args.spin,
        spinAxisDeg=args.axis,
    )
    condition = Condition(
        windMph=args.wind,
        windRelativeDeg=args.wind_relative,
        label=condition_label(args.wind, args.wind_relative, args.label),
    )
    output = Path(args.output).expanduser().resolve()

    print("\nLooper GSPro Physics Lab")
    print("-----------------------")
    print(f"GSPro DB:   {db_path}")
    print(f"Condition:  {condition.label}")
    print(
        "Launch:     "
        f"{launch.ballSpeedMph:g} mph | {launch.vlaDeg:g}° VLA | {launch.hlaDeg:g}° HLA | "
        f"{launch.spinRpm:g} rpm | {launch.spinAxisDeg:g}° axis"
    )
    print(f"Repetitions:{args.repetitions}")
    print(f"Output:     {output}")
    print("\nIMPORTANT: this tool does not set GSPro wind.")
    print(f"Set GSPro to the condition above, stay on the Driving Range, then continue.")
    if not args.yes:
        input("Press Enter when GSPro is ready (Ctrl+C to cancel)... ")

    try:
        sock = connect_gspro(args.host, args.port, args.timeout)
    except OSError as exc:
        print(
            f"ERROR: Could not connect to GSPro Open Connect at {args.host}:{args.port}: {exc}\n"
            "Make sure GSPro Open Connect is running and another launch-monitor client is not occupying it.",
            file=sys.stderr,
        )
        return 3

    base_shot_number = int(time.time()) % 1_000_000
    previous_id = latest_row_id(db_path)

    try:
        for index in range(args.repetitions):
            shot_number = base_shot_number + index
            payload = build_open_connect_shot(shot_number, launch)
            print(f"\n[{index + 1}/{args.repetitions}] Sending shot #{shot_number}...", end="", flush=True)
            responses = send_shot(sock, payload)
            if not any(item.get("Code") == 200 for item in responses):
                print(" received non-standard acknowledgement", flush=True)
            row = wait_for_new_row(db_path, previous_id, args.timeout)
            previous_id = int(row["ID"])
            capture = capture_row(row, shot_number, launch, condition)
            matches, mismatches = launch_matches(capture)
            save_capture(output, capture)
            result_text = (
                f" carry {capture.carryYds:.1f} yd" if capture.carryYds is not None else " carry —"
            ) + (
                f" | offline {capture.offlineYds:+.1f} yd" if capture.offlineYds is not None else " | offline —"
            )
            print(result_text)
            if not matches:
                print("  WARNING: persisted launch packet did not exactly match injection:")
                for mismatch in mismatches:
                    print(f"    - {mismatch}")
            if index + 1 < args.repetitions:
                time.sleep(args.pause)
    finally:
        sock.close()

    print(f"\nSaved {args.repetitions} controlled observation(s) to {output}")
    print("Import this JSON into /caddie-inputs to compare GSPro Δ against the open-physics prior.")
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Inject a frozen launch packet into GSPro and capture the resulting DrivingRangeShot row."
    )
    p.add_argument("--db", required=True, help="Full path to GSPro.db")
    p.add_argument("--speed", type=float, required=True, help="Ball speed, mph")
    p.add_argument("--vla", type=float, required=True, help="Vertical launch angle, degrees")
    p.add_argument("--hla", type=float, default=0.0, help="Horizontal launch angle, degrees")
    p.add_argument("--spin", type=float, required=True, help="Total spin, rpm")
    p.add_argument("--axis", type=float, default=0.0, help="Spin axis, degrees")
    p.add_argument("--wind", type=float, default=0.0, help="GSPro wind speed metadata, mph")
    p.add_argument(
        "--wind-relative",
        type=float,
        default=0.0,
        help="Wind FROM direction relative to target line: 0=head, 90=right, 180=tail, 270=left",
    )
    p.add_argument("--label", help="Human-readable condition label")
    p.add_argument("--repetitions", type=int, default=1, help="Repeat identical launch packet N times")
    p.add_argument("--pause", type=float, default=0.75, help="Seconds between injected shots")
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--output", default="gspro-physics-lab.json")
    p.add_argument("-y", "--yes", action="store_true", help="Skip the ready prompt")
    return p


if __name__ == "__main__":
    try:
        sys.exit(run(parser().parse_args()))
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
