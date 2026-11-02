#!/usr/bin/env python3
"""Looper GSPro lie lab: fire controlled shots from real lies and record what GSPro does.

Commands (run from this folder on the sim PC):
  python lie_lab.py ping                 connect, fire 1 test shot per API version, show replies
  python lie_lab.py discover             find which GSPro files change when shots are hit
  python lie_lab.py plan                 write plan.json (spots x shots) to edit if you want
  python lie_lab.py run                  the session: you click spots, it fires the shots
  python lie_lab.py analyze SESSION...   tables of GSPro's lie penalties from one or more sessions

Read-only on GSPro's files. Close the Uneekor launcher first (one launch monitor at a time).
Set GSPro wind to calm. Use a practice mode, not a handicap round.
See README.md for the full test plan.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from evidence import (  # noqa: E402
    DB_FILE, LOG_FILE, ROUND_FILE, ShotWatcher, default_gspro_dir, diff_snapshots, read_from,
    snapshot_folder, sqlite_rows_after, sqlite_table_state, parse_log_slice,
)
from open_connect import DEFAULT_HOST, DEFAULT_PORT, Launch, OpenConnectClient, OpenConnectError  # noqa: E402
import plan as planlib  # noqa: E402

try:  # Windows: allow 'p' to pause between shots.
    import msvcrt  # type: ignore
except ImportError:  # pragma: no cover - non-Windows
    msvcrt = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def json_line(path: Path, row: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, default=str) + "\n")


def resolve_gspro_dir(value: str | None) -> Path:
    path = Path(value).expanduser() if value else default_gspro_dir()
    if path is None or not path.exists():
        raise SystemExit(
            "Could not find the GSPro data folder. Pass --gspro-dir, e.g.\n"
            r'  --gspro-dir "C:\Users\<you>\AppData\LocalLow\GSPro\GSPro"')
    return path


def launch_of(shot: dict[str, Any]) -> Launch:
    return Launch(
        ballSpeedMph=float(shot["ballSpeedMph"]), vlaDeg=float(shot["vlaDeg"]),
        hlaDeg=float(shot.get("hlaDeg", 0.0)), spinRpm=float(shot["spinRpm"]),
        spinAxisDeg=float(shot.get("spinAxisDeg", 0.0)),
    )


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        value = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        value = ""
    return value or default


def parse_angle(text: str, positive: str, negative: str) -> float | None:
    """'3U' -> 3, '2D' -> -2, '1.5L' -> 1.5, '-1' -> -1, '' -> None."""
    text = text.strip().upper().replace("°", "")
    if not text:
        return None
    sign = 1.0
    if text.endswith(positive):
        text = text[:-1]
    elif text.endswith(negative):
        text, sign = text[:-1], -1.0
    try:
        return sign * float(text)
    except ValueError:
        return None


def gspro_version(gspro_dir: Path) -> str | None:
    log = gspro_dir / LOG_FILE
    if not log.exists():
        return None
    head = read_from(log, 0, 64 * 1024)
    for line in head.splitlines():
        if "version" in line.lower() and "gspro" in line.lower():
            return line.strip()[:200]
    return None


def make_session_dir(base: str | None, name: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = Path(base).expanduser() if base else HERE / "sessions" / f"{stamp}-{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def penalty_text(evidence: dict[str, Any]) -> str:
    log = evidence.get("log") or {}
    parts = []
    for p in log.get("penalties", []):
        parts.append(f"{p['surfaceName']} speed {p['speed']:.0%} spin {p['spin']:.0%} VLA {p['vla']:.0%}")
    if log.get("typeCodes"):
        parts.append(f"type {log['typeCodes'][-1]}")
    if not parts:
        parts.append("no penalty line")
    rec = evidence.get("round") or {}
    if rec.get("carryYds") is not None:
        parts.append(f"carry {rec['carryYds']:.1f}")
    if rec.get("restYds") is not None:
        parts.append(f"rest {rec['restYds']:.1f}")
    if rec.get("startingSurface") is not None:
        parts.append(f"start surface {rec['startingSurface']:g}")
    return " | ".join(parts)


def maybe_pause() -> None:
    if msvcrt is None:
        return
    pressed = False
    while msvcrt.kbhit():
        if msvcrt.getwch().lower() == "p":
            pressed = True
    if pressed:
        ask("Paused. Press Enter to continue")


# --------------------------------------------------------------------------
# ping

def cmd_ping(args: argparse.Namespace) -> int:
    clubs = planlib.STOCK
    shot = planlib._shot("7i" if "7i" in clubs else next(iter(clubs)), "ping")
    results = []
    for version in [v.strip() for v in args.api_versions.split(",") if v.strip()]:
        print(f"\nAPI version {version}: connecting to {args.host}:{args.port} ...")
        try:
            with OpenConnectClient(args.host, args.port, api_version=version) as client:
                time.sleep(1.5)
                pre = client.drain()
                if pre:
                    print(f"  replies before the shot: {pre}")
                print(f"  firing 7i stock ({shot['ballSpeedMph']} mph, {shot['vlaDeg']}°, {shot['spinRpm']} rpm) ...")
                result = client.fire(launch_of(shot), wait_for_stop_s=args.timeout)
                time.sleep(1.0)
                late = client.drain()
        except OpenConnectError as exc:
            print(f"  {exc}")
            return 3
        codes = [r.get("Code") for r in result["replies"] + late]
        after = result["stoppedAfterS"]
        after_text = "" if after is None else f"after {after:.1f}s"
        print(f"  codes: {codes}  stop: {result['stopSource']} {after_text}")
        for reply in result["replies"] + late:
            print(f"  {json.dumps(reply)[:300]}")
        results.append({"apiVersion": version, "codes": codes, "stop": result["stopSource"]})
        time.sleep(args.gap)
    print("\nSummary:")
    for r in results:
        print(f"  v{r['apiVersion']}: codes {r['codes']} -> "
              f"{'202 arrives: use this version' if 202 in r['codes'] else 'no 202 (runner will watch files instead)'}")
    return 0


# --------------------------------------------------------------------------
# discover

def cmd_discover(args: argparse.Namespace) -> int:
    gspro_dir = resolve_gspro_dir(args.gspro_dir)
    out = make_session_dir(args.out, "discover")
    print(f"GSPro folder: {gspro_dir}\nReport folder: {out}")
    before = snapshot_folder(gspro_dir)
    db_before = {}
    for rel in before:
        if rel.lower().endswith(".db"):
            try:
                db_before[rel] = sqlite_table_state(gspro_dir / rel)
            except Exception as exc:  # noqa: BLE001 - report and continue
                db_before[rel] = {"_error": str(exc)}
    print(f"Snapshot taken: {len(before)} files.")

    if args.fire:
        shot = planlib._shot(args.club, "discover")
        print(f"Firing {args.fire} x {args.club} stock through Open Connect "
              f"(have GSPro in the mode you want to test, ball placed) ...")
        with OpenConnectClient(args.host, args.port, api_version=args.api_version) as client:
            for i in range(args.fire):
                result = client.fire(launch_of(shot), wait_for_stop_s=args.timeout)
                print(f"  shot {i + 1}: codes {[r.get('Code') for r in result['replies']]} stop {result['stopSource']}")
                time.sleep(args.settle)
    else:
        ask("Now hit 3 shots in GSPro (in the mode you want to test). Press Enter when the last ball has stopped")
    time.sleep(2.0)

    after = snapshot_folder(gspro_dir)
    changes = diff_snapshots(before, after)
    report: dict[str, Any] = {"gsproDir": str(gspro_dir), "at": utc_now(), "changes": changes, "databases": {}}
    print("\nFiles that changed:")
    if not changes:
        print("  none")
    for change in changes:
        rel = change["path"]
        path = gspro_dir / rel
        print(f"  {change['change']:9} {rel}  {change['sizeBefore']} -> {change['sizeAfter']} bytes")
        safe = rel.replace("/", "__")
        if change["change"] == "deleted":
            continue
        if rel.lower().endswith(".db") or rel.lower().endswith((".db-wal", ".db-shm")):
            db_rel = rel.split(".db")[0] + ".db"
            if db_rel in report["databases"] or not (gspro_dir / db_rel).exists():
                continue
            try:
                state = sqlite_table_state(gspro_dir / db_rel)
            except Exception as exc:  # noqa: BLE001
                report["databases"][db_rel] = {"error": str(exc)}
                continue
            grew = {}
            for table, now in state.items():
                was = db_before.get(db_rel, {}).get(table, {"rows": 0, "maxRowid": 0})
                if now["rows"] != was.get("rows") or now["maxRowid"] != was.get("maxRowid"):
                    rows = sqlite_rows_after(gspro_dir / db_rel, table, was.get("maxRowid"), limit=20)
                    grew[table] = {"before": was, "after": now, "newRows": rows}
                    print(f"      table {table}: rows {was.get('rows')} -> {now['rows']}")
            report["databases"][db_rel] = grew
        elif change["change"] == "modified" and change["sizeBefore"] is not None \
                and change["sizeAfter"] > change["sizeBefore"] and path.suffix.lower() in {".txt", ".log"}:
            text = read_from(path, change["sizeBefore"])
            (out / f"{safe}.appended.txt").write_text(text, encoding="utf-8")
            parsed = parse_log_slice(text)
            change["parsed"] = parsed
            print(f"      appended {len(text)} chars: {len(parsed['launches'])} launch lines, "
                  f"{len(parsed['penalties'])} penalty lines")
        elif path.stat().st_size <= 32 * 1024 * 1024:
            (out / safe).write_bytes(path.read_bytes())
    (out / "discovery-report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"\nSaved {out / 'discovery-report.json'}")
    if any(c["path"].endswith(".db") for c in changes):
        print("If a GSPro.db table grew with one row per shot, pass it to run with --db-table NAME.")
    return 0


# --------------------------------------------------------------------------
# plan

def cmd_plan(args: argparse.Namespace) -> int:
    path = Path(args.output)
    planlib.write_plan(path)
    plan = planlib.load_plan(path)
    total = sum(len(s["shots"]) for s in plan["spots"])
    print(f"Wrote {path}: {len(plan['spots'])} spots, {total} shots (+ label check).")
    return 0


# --------------------------------------------------------------------------
# run

class Runner:
    def __init__(self, args: argparse.Namespace, client: OpenConnectClient, watcher: ShotWatcher, out: Path) -> None:
        self.args = args
        self.client = client
        self.watcher = watcher
        self.out = out
        self.shots_path = out / "shots.jsonl"
        self.spots_path = out / "spots.jsonl"
        self.count = 0

    def fire(self, spot: dict[str, Any], shot: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
        maybe_pause()
        self.count += 1
        tag = f"s{spot['spot']:03d}-{self.count:04d}"
        self.watcher.mark()
        started = utc_now()
        result = self.client.fire(
            launch_of(shot), wait_for_stop_s=self.args.timeout,
            is_done=lambda: self.watcher.done(self.args.quiet, self.args.fallback),
        )
        time.sleep(self.args.settle)
        evidence = self.watcher.collect(tag)
        row = {
            "tag": tag, "firedAt": started, "spot": spot["spot"], "targetLie": spot.get("targetLie"),
            "shot": shot, "gsproPlayer": self.client.last_player,
            "replies": result["replies"], "stopSource": result["stopSource"],
            "stoppedAfterS": result["stoppedAfterS"], "evidence": evidence, **(extra or {}),
        }
        json_line(self.shots_path, row)
        club = (self.client.last_player or {}).get("Club")
        print(f"  {tag} {shot['club']:>6} {shot['kind']:<12} -> {penalty_text(evidence)}"
              f"{f' | GSPro club {club}' if club else ''} | stop {result['stopSource']}")
        if result["stopSource"] in ("no-ack", "error"):
            print("  GSPro did not accept the shot. Check GSPconnect, then press Enter to retry this spot's next shot.")
            ask("Enter to continue")
        return row

    def spot_header(self, spot: dict[str, Any], total: int) -> dict[str, Any] | None:
        print(f"\n=== Spot {spot['spot']}/{total}: {spot['targetLie']} ({spot.get('note', '')}) ===")
        print("In GSPro On Course practice: drop the ball on a matching spot (any hole), ready to rehit.")
        command = ask("Press Enter when placed ('s' skip spot, 'q' quit)")
        if command.lower() == "q":
            return None
        if command.lower() == "s":
            return {"skip": True}
        surface = ask("  Surface the GSPro HUD shows", spot["targetLie"])
        up_down = parse_angle(ask("  Lie up/down from the HUD (e.g. 3U, 2D, 0; Enter if not shown)"), "U", "D")
        left_right = parse_angle(ask("  Lie left/right from the HUD (e.g. 2L, 1R, 0; Enter if not shown)"), "L", "R")
        info = {
            "spot": spot["spot"], "targetLie": spot["targetLie"], "note": spot.get("note"),
            "hudSurface": surface, "hudUpDownDeg": up_down, "hudLeftRightDeg": left_right,
            "placedAt": utc_now(),
        }
        json_line(self.spots_path, info)
        return info

    def label_check(self, plan: dict[str, Any]) -> None:
        check = plan.get("labelCheck") or {}
        spot = {"spot": 0, "targetLie": check.get("lie", "rough"), "note": "club label check"}
        print("\n=== Club label check ===")
        print(f"Identical {check.get('club', '7i')} shots with different clubs selected in GSPro. "
              "If GSPro's penalty is the same for every label, labels don't matter for the main run.")
        info = self.spot_header(spot, 0)
        if info is None or info.get("skip"):
            return
        for label in check.get("gsproClubs", ["7i", "PW", "Driver"]):
            ask(f"  Select {label} in GSPro, then press Enter")
            for shot in planlib.label_check_shots(plan):
                self.fire(spot, shot, {"spotInfo": info, "gsproClubSelected": label})

    def run(self, plan: dict[str, Any]) -> None:
        spots = plan["spots"]
        if plan.get("labelCheck", {}).get("enabled") and not self.args.skip_label_check:
            self.label_check(plan)
        for spot in spots:
            if spot["spot"] < self.args.start_spot:
                continue
            info = self.spot_header(spot, len(spots))
            if info is None:
                print(f"Stopped. Resume with --start-spot {spot['spot']} --out \"{self.out}\"")
                return
            if info.get("skip"):
                continue
            first_start = None
            for shot in spot["shots"]:
                row = self.fire(spot, shot, {"spotInfo": info})
                start = ((row["evidence"].get("round") or {}).get("start"))
                if start and first_start is None:
                    first_start = start
                elif start and first_start:
                    moved = ((start["x"] - first_start["x"]) ** 2 + (start["z"] - first_start["z"]) ** 2) ** 0.5
                    if moved > 1.0:
                        print(f"  WARNING: the ball started {moved:.1f} m from this spot's first shot. "
                              "Practice may have stopped rehitting from the dropped spot.")
                        if ask("  Continue this spot? (y/n)", "y").lower() != "y":
                            break
        print("\nAll spots done.")


def cmd_run(args: argparse.Namespace) -> int:
    gspro_dir = resolve_gspro_dir(args.gspro_dir)
    plan_path = Path(args.plan) if args.plan else None
    plan = planlib.load_plan(plan_path) if plan_path else planlib.build_plan()
    out = make_session_dir(args.out, "run")
    session = {
        "schema": "looper-gspro-lie-lab-session-v1", "startedAt": utc_now(), "gsproDir": str(gspro_dir),
        "gsproVersionLine": gspro_version(gspro_dir), "apiVersion": args.api_version,
        "dbTable": args.db_table, "wind": "calm (set manually)", "plan": plan,
    }
    session_file = out / "session.json"
    if not session_file.exists():
        session_file.write_text(json.dumps(session, indent=2), encoding="utf-8")
    total = sum(len(s["shots"]) for s in plan["spots"] if s["spot"] >= args.start_spot)
    print(f"Session folder: {out}\nGSPro folder: {gspro_dir}\n{total} shots planned "
          f"(about {total * 14 / 3600:.1f} h of firing plus your clicks).")
    print("Checklist: Uneekor launcher closed, GSPro wind calm, On Course practice (rehit from a dropped ball), not a handicap round.")
    if msvcrt is not None:
        print("Press 'p' any time to pause after the current shot.")
    ask("Press Enter to connect")
    watcher = ShotWatcher(gspro_dir, out / "evidence", db_table=args.db_table)
    try:
        with OpenConnectClient(args.host, args.port, api_version=args.api_version) as client:
            Runner(args, client, watcher, out).run(plan)
    except OpenConnectError as exc:
        print(exc)
        return 3
    except KeyboardInterrupt:
        print(f"\nStopped. Everything so far is saved in {out}")
    print(f"Next: python lie_lab.py analyze \"{out}\"")
    return 0


# --------------------------------------------------------------------------

def cmd_analyze(args: argparse.Namespace) -> int:
    import analyze

    return analyze.main([str(p) for p in args.sessions], Path(args.out) if args.out else None)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    def connection(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--host", default=DEFAULT_HOST)
        sp.add_argument("--port", type=int, default=DEFAULT_PORT)
        sp.add_argument("--timeout", type=float, default=30.0, help="Max seconds to wait for a shot to finish")

    sp = sub.add_parser("ping", help="Fire one test shot per API version and print GSPro's replies")
    connection(sp)
    sp.add_argument("--api-versions", default="1,2")
    sp.add_argument("--gap", type=float, default=6.0, help="Seconds between the two test shots")
    sp.set_defaults(func=cmd_ping)

    sp = sub.add_parser("discover", help="Find which GSPro files change when shots are hit")
    connection(sp)
    sp.add_argument("--gspro-dir")
    sp.add_argument("--out")
    sp.add_argument("--fire", type=int, default=0, help="Fire N shots itself instead of you hitting them")
    sp.add_argument("--club", default="7i")
    sp.add_argument("--api-version", default="1")
    sp.add_argument("--settle", type=float, default=8.0)
    sp.set_defaults(func=cmd_discover)

    sp = sub.add_parser("plan", help="Write the default plan to a JSON file you can edit")
    sp.add_argument("--output", default="plan.json")
    sp.set_defaults(func=cmd_plan)

    sp = sub.add_parser("run", help="Run the lie session")
    connection(sp)
    sp.add_argument("--gspro-dir")
    sp.add_argument("--plan", help="Plan JSON (default: built-in plan)")
    sp.add_argument("--out", help="Session folder (reuse one to resume)")
    sp.add_argument("--api-version", default="1", help="Use 2 if `ping` showed 202 replies there")
    sp.add_argument("--db-table", help="GSPro.db table that gets one row per shot (from `discover`)")
    sp.add_argument("--start-spot", type=int, default=1)
    sp.add_argument("--skip-label-check", action="store_true")
    sp.add_argument("--settle", type=float, default=2.0, help="Seconds after the ball stops before the next shot")
    sp.add_argument("--quiet", type=float, default=2.0, help="No-202 fallback: files quiet this long = stopped")
    sp.add_argument("--fallback", type=float, default=14.0, help="No-202 fallback: max seconds before trusting quiet")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("analyze", help="Summarize one or more session folders")
    sp.add_argument("sessions", nargs="+", type=Path)
    sp.add_argument("--out", help="Output folder (default: the first session)")
    sp.set_defaults(func=cmd_analyze)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
