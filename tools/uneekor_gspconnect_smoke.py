#!/usr/bin/env python3
"""Smoke-test controlled shot injection through the live Uneekor GSPconnect adapter.

This intentionally mirrors the EYE MINI LITE API v2 JSON observed in
GSPconnect's ConnectDebug.txt. It is a narrow transport proof before folding
this protocol into gspro_calibration_harness.py.

Expected live path on the user's Uneekor install:
    UneekorLauncher -> GSPconnect:59002 -> GSPro:9050

Unlike GSPro OpenConnect, this adapter path does not return the documented
Code=200 acknowledgement. Success is therefore defined as a new
GSPro.db:DrivingRangeShot row after the packet is sent.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import socket
import sys
import time
from pathlib import Path

import gspro_physics_lab as lab

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 59002
DEVICE_ID = "UNEEKOR EYEMINILITE"


def default_db_candidates() -> list[Path]:
    candidates: list[Path] = []
    local = os.environ.get("LOCALAPPDATA")
    profile = os.environ.get("USERPROFILE")
    if local:
        candidates += [
            Path(local) / "GSPro" / "GSPro.db",
            Path(local).parent / "LocalLow" / "GSPro" / "GSPro" / "GSPro.db",
        ]
    if profile:
        candidates += [
            Path(profile) / "AppData" / "LocalLow" / "GSPro" / "GSPro" / "GSPro.db",
            Path(profile) / "AppData" / "Local" / "GSPro" / "GSPro.db",
        ]
    seen: set[str] = set()
    deduped: list[Path] = []
    for path in candidates:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            deduped.append(path)
    return deduped


def resolve_db(explicit: str | None) -> Path | None:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        return path if path.exists() else None
    return next((p.resolve() for p in default_db_candidates() if p.exists()), None)


def spin_components(total_spin: float, axis_deg: float) -> tuple[float, float]:
    """Convert total spin + axis to back/side components for the Uneekor schema."""
    radians = math.radians(axis_deg)
    back_spin = total_spin * math.cos(radians)
    side_spin = total_spin * math.sin(radians)
    return back_spin, side_spin


def build_packet(args: argparse.Namespace, shot_number: int) -> dict:
    back_spin, side_spin = spin_components(args.spin, args.axis)
    return {
        "DeviceID": DEVICE_ID,
        "Units": "Yards",
        "ShotNumber": shot_number,
        "APIversion": "2",
        "BallData": {
            "Speed": args.speed,
            "SpinAxis": args.axis,
            # The live EML packet populated BackSpin/SideSpin while TotalSpin was 0.
            # Mirror that behavior so GSPconnect sees the same source shape.
            "TotalSpin": 0.0,
            "BackSpin": back_spin,
            "SideSpin": side_spin,
            "HLA": args.hla,
            "VLA": args.vla,
            "CarryDistance": args.carry,
        },
        "ClubData": {
            "Speed": args.club_speed,
            "AngleOfAttack": args.aoa,
            "FaceToTarget": 0.0,
            "Lie": 0.0,
            "Loft": 0.0,
            "Path": args.club_path,
            "SpeedAtImpact": args.club_speed,
            "VerticalFaceImpact": 0.0,
            "HorizontalFaceImpact": 0.0,
        },
        "ShotDataOptions": {
            "ContainsBallData": True,
            "ContainsClubData": True,
            "LaunchMonitorIsReady": False,
            "LaunchMonitorBallDetected": True,
            "IsHeartBeat": False,
            "SendPlayerInformationToDevice": False,
            "DisconnectLaunchMonitor": False,
            "ShotMediaPath": "",
            "DoesShowIncludeLiePenalty": True,
            "IsSpinEstimated": False,
        },
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Inject one synthetic EML shot into GSPconnect.")
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--db")
    p.add_argument("--timeout", type=float, default=12.0)
    p.add_argument("--speed", type=float, default=118.0, help="Ball speed mph")
    p.add_argument("--vla", type=float, default=18.0)
    p.add_argument("--hla", type=float, default=0.0)
    p.add_argument("--spin", type=float, default=5800.0)
    p.add_argument("--axis", type=float, default=0.0)
    p.add_argument(
        "--carry",
        type=float,
        default=160.0,
        help="CarryDistance field required by observed EML packet; smoke-test value only",
    )
    p.add_argument("--club-speed", type=float, default=85.0)
    p.add_argument("--aoa", type=float, default=-4.0)
    p.add_argument("--club-path", type=float, default=0.0)
    p.add_argument("--shot-number", type=int)
    p.add_argument("--print-only", action="store_true", help="Print packet without connecting")
    args = p.parse_args()

    shot_number = args.shot_number or (int(time.time() * 1000) % 1_000_000_000)
    packet = build_packet(args, shot_number)
    wire = (json.dumps(packet, separators=(",", ":")) + "\n").encode("utf-8")

    print("Looper Uneekor/GSPconnect smoke injector")
    print(f"Target:   {args.host}:{args.port}")
    print(f"Shot #:   {shot_number}")
    print(
        f"Launch:   {args.speed:.1f} mph | VLA {args.vla:+.1f}° | HLA {args.hla:+.1f}° | "
        f"spin {args.spin:.0f} rpm | axis {args.axis:+.1f}°"
    )
    print(f"Carry field: {args.carry:.1f} yd (transport smoke-test field)")

    if args.print_only:
        print(json.dumps(packet, indent=2))
        return 0

    db_path = resolve_db(args.db)
    if db_path is None:
        print("ERROR: GSPro.db not found. Pass --db with its full path.", file=sys.stderr)
        return 2

    previous_id = lab.latest_row_id(db_path)
    print(f"DB:       {db_path}")
    print(f"Prior row: {previous_id}")

    try:
        sock = socket.create_connection((args.host, args.port), timeout=2.0)
    except OSError as exc:
        print(f"ERROR: could not connect to GSPconnect: {exc}", file=sys.stderr)
        return 3

    try:
        started = time.perf_counter()
        sock.sendall(wire)
        print(f"Sent {len(wire)} bytes; waiting for GSPro result...")
        row = lab.wait_for_new_row(db_path, previous_id, args.timeout)
        elapsed = time.perf_counter() - started
    except Exception as exc:
        print(f"ERROR: packet sent but no captured result: {exc}", file=sys.stderr)
        return 4
    finally:
        sock.close()

    try:
        shot_data = json.loads(row["ShotData"])
    except Exception:
        shot_data = row["ShotData"]

    print("SUCCESS: GSPro created a new DrivingRangeShot row.")
    print(f"Row ID:   {row['ID']}")
    print(f"Created:  {row['DateCreated']}")
    print(f"Latency:  {elapsed:.2f}s")
    print("ShotData:")
    print(json.dumps(shot_data, indent=2) if isinstance(shot_data, dict) else shot_data)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        raise SystemExit(130)
