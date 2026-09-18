#!/usr/bin/env python3
"""Controlled GSPro calibration harness for launch-profile and lie experiments.

This v1 intentionally reuses the proven packet/DrivingRangeShot primitives in
`gspro_physics_lab.py`, then adds: preflight diagnostics, multi-profile sweeps,
cycle timing, physical-lie experiment metadata, and a GSPro-free self-test.

Terrain Up/Down and Left/Right are metadata only. They are NOT Open Connect
`ClubData.Lie`, which is club data rather than the course's physical lie.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import gspro_physics_lab as lab

SCHEMA_VERSION = "looper-gspro-calibration-v1"


@dataclass(frozen=True)
class Profile:
    label: str
    ballSpeedMph: float
    vlaDeg: float
    hlaDeg: float
    spinRpm: float
    spinAxisDeg: float

    def launch(self) -> lab.LaunchPacket:
        return lab.LaunchPacket(
            ballSpeedMph=self.ballSpeedMph,
            vlaDeg=self.vlaDeg,
            hlaDeg=self.hlaDeg,
            spinRpm=self.spinRpm,
            spinAxisDeg=self.spinAxisDeg,
        )


@dataclass(frozen=True)
class Context:
    label: str
    lieUpDownDeg: float | None
    lieLeftRightDeg: float | None
    surface: str | None
    course: str | None
    hole: int | None
    positionLabel: str | None


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
    return [p for p in candidates if not (str(p).lower() in seen or seen.add(str(p).lower()))]


def resolve_db(explicit: str | None) -> Path | None:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        return path if path.exists() else None
    return next((p.resolve() for p in default_db_candidates() if p.exists()), None)


def validate_capture(db_path: Path) -> None:
    with lab.open_readonly_db(db_path) as db:
        row = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='DrivingRangeShot'"
        ).fetchone()
        if row is None:
            raise RuntimeError("GSPro.db does not contain DrivingRangeShot.")
        columns = {r[1] for r in db.execute("PRAGMA table_info(DrivingRangeShot)").fetchall()}
        missing = {"ID", "DateCreated", "ShotData"} - columns
        if missing:
            raise RuntimeError(f"DrivingRangeShot missing columns: {sorted(missing)}")


def preflight(host: str, port: int, timeout_s: float, db_path: Path | None) -> tuple[bool, list[str]]:
    ok = True
    messages: list[str] = []
    if db_path is None:
        ok = False
        messages.append("FAIL capture: GSPro.db not found. Pass --db if auto-discovery misses it.")
    else:
        try:
            validate_capture(db_path)
            messages.append(f"PASS capture: {db_path} has DrivingRangeShot.")
        except Exception as exc:
            ok = False
            messages.append(f"FAIL capture: {exc}")
    started = time.perf_counter()
    try:
        sock = lab.connect_gspro(host, port, min(timeout_s, 2.0))
        sock.close()
        messages.append(
            f"PASS transport: {host}:{port} accepted TCP connection "
            f"({(time.perf_counter() - started) * 1000:.0f} ms)."
        )
    except OSError as exc:
        ok = False
        messages.append(
            f"FAIL transport: {host}:{port} is not accepting Open Connect ({exc}). "
            "GSPro is not listening there; this does not prove the harness is broken."
        )
    return ok, messages


def load_profiles(path: Path) -> list[Profile]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("profiles") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        raise ValueError("Profile file needs a non-empty profiles array.")
    profiles: list[Profile] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Every profile must be an object.")
        profiles.append(Profile(
            label=str(item["label"]),
            ballSpeedMph=float(item["ballSpeedMph"]),
            vlaDeg=float(item["vlaDeg"]),
            hlaDeg=float(item.get("hlaDeg", 0.0)),
            spinRpm=float(item["spinRpm"]),
            spinAxisDeg=float(item.get("spinAxisDeg", 0.0)),
        ))
    return profiles


def selected_profiles(args: argparse.Namespace) -> list[Profile]:
    if args.profile_file:
        profiles = load_profiles(Path(args.profile_file).expanduser().resolve())
        if args.all_profiles:
            return profiles
        if not args.profile:
            raise ValueError("Use --profile LABEL or --all-profiles with --profile-file.")
        chosen = [p for p in profiles if p.label == args.profile]
        if not chosen:
            raise ValueError(f"Profile {args.profile!r} not found.")
        return chosen
    if args.speed is None or args.vla is None or args.spin is None:
        raise ValueError("Provide --speed, --vla and --spin, or use --profile-file.")
    return [Profile(
        args.profile or "manual",
        float(args.speed), float(args.vla), float(args.hla),
        float(args.spin), float(args.axis),
    )]


def context(args: argparse.Namespace) -> Context:
    return Context(
        label=args.condition_label or "calibration",
        lieUpDownDeg=args.lie_up_down,
        lieLeftRightDeg=args.lie_left_right,
        surface=args.surface,
        course=args.course,
        hole=args.hole,
        positionLabel=args.position_label,
    )


def load_output(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": lab.utc_now(),
            "updatedAt": lab.utc_now(),
            "observations": [],
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError(f"{path} is not a {SCHEMA_VERSION} file.")
    return data


def save(path: Path, item: dict[str, Any]) -> None:
    data = load_output(path)
    data.setdefault("observations", []).append(item)
    data["updatedAt"] = lab.utc_now()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def capture_to_item(capture: lab.CapturedShot, profile: Profile, ctx: Context,
                    connect_ms: float | None, ack_ms: float, result_ms: float,
                    cycle_ms: float) -> dict[str, Any]:
    raw = asdict(capture)
    raw.pop("condition", None)
    raw.pop("launch", None)
    return {
        **raw,
        "profile": asdict(profile),
        "context": asdict(ctx),
        "captureSource": "GSPro.db:DrivingRangeShot",
        "timings": {
            "connectMs": connect_ms,
            "ackMs": ack_ms,
            "resultMs": result_ms,
            "cycleMs": cycle_ms,
        },
    }


def execute(args: argparse.Namespace) -> int:
    db_path = resolve_db(args.db)
    if args.preflight:
        ok, messages = preflight(args.host, args.port, args.timeout, db_path)
        print("Looper GSPro calibration preflight")
        for message in messages:
            print(message)
        return 0 if ok else 3
    if db_path is None:
        print("ERROR: GSPro.db not found. Pass --db with its full path.", file=sys.stderr)
        return 2
    try:
        validate_capture(db_path)
        profiles = selected_profiles(args)
    except (RuntimeError, ValueError, KeyError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    ctx = context(args)
    output = Path(args.output).expanduser().resolve()
    print("\nLooper GSPro Calibration Harness")
    print("-------------------------------")
    print(f"DB:       {db_path}")
    print(f"Profiles: {len(profiles)}")
    print(f"Context:  {ctx.label}")
    if ctx.lieUpDownDeg is not None or ctx.lieLeftRightDeg is not None:
        print(
            f"Lie meta: up/down={ctx.lieUpDownDeg}° left/right={ctx.lieLeftRightDeg}° "
            "(metadata only)"
        )
    print(f"Output:   {output}")
    if not args.yes:
        input("Press Enter when GSPro is ready (Ctrl+C to cancel)... ")

    connect_start = time.perf_counter()
    try:
        sock = lab.connect_gspro(args.host, args.port, args.timeout)
    except OSError as exc:
        print(
            f"ERROR: {args.host}:{args.port} refused/unavailable: {exc}\n"
            "Run --preflight first. GSPro must expose Open Connect for injection.",
            file=sys.stderr,
        )
        return 3
    connect_ms: float | None = (time.perf_counter() - connect_start) * 1000.0
    previous_id = lab.latest_row_id(db_path)
    shot_number = int(time.time() * 1000) % 1_000_000_000
    saved = 0
    try:
        for profile_index, profile in enumerate(profiles):
            for rep in range(args.repetitions):
                shot_number += 1
                launch = profile.launch()
                packet = lab.build_open_connect_shot(shot_number, launch)
                cycle_start = time.perf_counter()
                print(
                    f"\n{profile.label} [{rep + 1}/{args.repetitions}] shot #{shot_number}...",
                    end="", flush=True,
                )
                ack_start = time.perf_counter()
                responses = lab.send_shot(sock, packet)
                ack_ms = (time.perf_counter() - ack_start) * 1000.0
                if not any(r.get("Code") == 200 for r in responses):
                    raise RuntimeError(f"No Code 200 acknowledgement: {responses!r}")
                result_start = time.perf_counter()
                row = lab.wait_for_new_row(db_path, previous_id, args.timeout)
                result_ms = (time.perf_counter() - result_start) * 1000.0
                previous_id = int(row["ID"])
                cycle_ms = (time.perf_counter() - cycle_start) * 1000.0
                legacy_condition = lab.Condition(0.0, 0.0, ctx.label)
                capture = lab.capture_row(row, shot_number, launch, legacy_condition)
                matches, mismatches = lab.launch_matches(capture)
                save(output, capture_to_item(
                    capture, profile, ctx, connect_ms, ack_ms, result_ms, cycle_ms
                ))
                connect_ms = None
                saved += 1
                carry = f"{capture.carryYds:.1f} yd" if capture.carryYds is not None else "—"
                offline = f"{capture.offlineYds:+.1f} yd" if capture.offlineYds is not None else "—"
                print(f" carry {carry} | offline {offline} | cycle {cycle_ms / 1000:.2f}s")
                if not matches:
                    print("  WARNING: persisted launch values differ from injection:")
                    for mismatch in mismatches:
                        print(f"    - {mismatch}")
                is_last = profile_index == len(profiles) - 1 and rep == args.repetitions - 1
                if args.pause and not is_last:
                    time.sleep(args.pause)
    finally:
        sock.close()
    print(f"\nSaved {saved} observation(s) to {output}")
    return 0


def _mock_server(server: socket.socket, db_path: Path, errors: list[Exception]) -> None:
    try:
        server.listen(1)
        conn, _ = server.accept()
        with conn:
            packet = json.loads(conn.recv(65536).decode("utf-8"))
            response_201 = json.dumps({"Code": 201, "Message": "Player Information"}).encode()
            response_200 = json.dumps({"Code": 200, "Message": "Shot Received"}).encode()
            conn.sendall(response_201[:8])
            time.sleep(0.01)
            conn.sendall(response_201[8:] + response_200[:6])
            time.sleep(0.01)
            conn.sendall(response_200[6:])
            ball = packet["BallData"]
            shot = {
                "Carry": 161.7, "Offline": -3.2, "TotalDistance": 166.4,
                "PeakHeight": 31.2, "Descent": 46.1,
                "BallSpeed": ball["Speed"], "VLA": ball["VLA"], "HLA": ball["HLA"],
                "TotalSpin": ball["TotalSpin"], "SpinAxis": ball["SpinAxis"],
            }
            with sqlite3.connect(db_path) as db:
                db.execute(
                    "INSERT INTO DrivingRangeShot(DateCreated, ShotData) VALUES(?, ?)",
                    (lab.utc_now(), json.dumps(shot)),
                )
                db.commit()
    except Exception as exc:
        errors.append(exc)
    finally:
        server.close()


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="looper-gspro-cal-") as temp:
        db_path = Path(temp) / "GSPro.db"
        with sqlite3.connect(db_path) as db:
            db.execute(
                "CREATE TABLE DrivingRangeShot "
                "(ID INTEGER PRIMARY KEY AUTOINCREMENT, DateCreated TEXT, ShotData TEXT)"
            )
            db.commit()
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind((lab.DEFAULT_HOST, 0))
        port = int(server.getsockname()[1])
        errors: list[Exception] = []
        thread = threading.Thread(target=_mock_server, args=(server, db_path, errors), daemon=True)
        thread.start()
        profile = Profile("mid-iron-test", 118.0, 18.0, 0.5, 5800.0, -4.0)
        previous_id = lab.latest_row_id(db_path)
        sock = lab.connect_gspro(lab.DEFAULT_HOST, port, 2.0)
        try:
            responses = lab.send_shot(sock, lab.build_open_connect_shot(1, profile.launch()))
            row = lab.wait_for_new_row(db_path, previous_id, 2.0)
        finally:
            sock.close()
        thread.join(2.0)
        if errors:
            raise errors[0]
        capture = lab.capture_row(
            row, 1, profile.launch(), lab.Condition(0, 0, "self-test")
        )
        matches, mismatches = lab.launch_matches(capture)
        checks = {
            "fragmented 201": any(r.get("Code") == 201 for r in responses),
            "fragmented 200": any(r.get("Code") == 200 for r in responses),
            "launch echo": matches,
            "captured result": capture.carryYds == 161.7,
        }
        failed = [name for name, passed in checks.items() if not passed]
        if failed:
            print(f"SELF-TEST FAIL: {failed}; launch mismatches={mismatches}", file=sys.stderr)
            return 1
        print("SELF-TEST PASS")
        for name in checks:
            print(f"  {name}: pass")
        print("  profile-file + lie metadata paths: covered by unit tests")
        return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Inject controlled launch profiles into GSPro for calibration experiments."
    )
    p.add_argument("--self-test", action="store_true", help="Local mock end-to-end test; no GSPro required")
    p.add_argument("--preflight", action="store_true", help="Check DB + port 921 without sending a shot")
    p.add_argument("--db", help="Path to GSPro.db; typical Windows installs are auto-discovered")
    p.add_argument("--profile-file", help="JSON launch-profile file")
    p.add_argument("--profile", help="Profile label to select, or label for direct arguments")
    p.add_argument("--all-profiles", action="store_true", help="Run all profiles in --profile-file")
    p.add_argument("--speed", type=float, help="Ball speed mph")
    p.add_argument("--vla", type=float, help="Vertical launch angle degrees")
    p.add_argument("--hla", type=float, default=0.0, help="Horizontal launch angle degrees")
    p.add_argument("--spin", type=float, help="Total spin rpm")
    p.add_argument("--axis", type=float, default=0.0, help="Spin axis degrees")
    p.add_argument("--condition-label")
    p.add_argument("--lie-up-down", type=float, help="Measured GSPro terrain Up/Down; metadata only")
    p.add_argument("--lie-left-right", type=float, help="Measured GSPro terrain Left/Right; metadata only")
    p.add_argument("--surface")
    p.add_argument("--course")
    p.add_argument("--hole", type=int)
    p.add_argument("--position-label")
    p.add_argument("--repetitions", type=int, default=1)
    p.add_argument("--pause", type=float, default=0.5)
    p.add_argument("--host", default=lab.DEFAULT_HOST)
    p.add_argument("--port", type=int, default=lab.DEFAULT_PORT)
    p.add_argument("--timeout", type=float, default=lab.DEFAULT_TIMEOUT_S)
    p.add_argument("--output", default="gspro-calibration.json")
    p.add_argument("-y", "--yes", action="store_true")
    return p


def main(argv: Iterable[str] | None = None) -> int:
    args = parser().parse_args(list(argv) if argv is not None else None)
    return self_test() if args.self_test else execute(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
