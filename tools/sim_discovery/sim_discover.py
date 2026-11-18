#!/usr/bin/env python3
"""Looper sim discovery: find out which files a golf sim writes while you play.

For a sim Looper doesn't know yet (Muni Golf first). It answers one question:
when you hit a shot, what changes on this PC? It looks at file names, sizes and
times only. It never opens a file and never changes anything.

Double-click it (open with Python), or run `python sim_discover.py`.

What you do:
  1. Start the sim and get to the first tee. Then start this and press Enter.
  2. Play two or three holes. Hit shots, finish a hole. Export your shot
     history once if the sim has that.
  3. Come back and press Enter. It lists every file that was created or
     changed while you played, and the network ports the sim has open.
  4. It then watches the likely files for a minute. Hit ONE more shot, so it
     can see which files change the moment a shot is hit.

It writes sim_discovery_<time>.txt next to this file. Skim it, then send it to
Claude. It holds file paths, sizes and times, and the names of programs with
open ports; nothing from inside any file.
"""

from __future__ import annotations

import csv
import io
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
#: Folders that change constantly and have nothing to do with a golf sim.
NOISY = ("\\google\\chrome", "\\microsoft\\edge", "\\mozilla\\", "\\microsoft\\windows\\", "\\packages\\microsoft",
         "\\onedrive", "\\microsoft\\teams", "\\slack\\", "\\discord\\cache", "\\nvidia", "\\d3dscache", "\\crashdumps",
         "\\gspro\\", "\\uneekor", "\\looper\\", "\\python", "\\pip\\", "\\connecteddevicesplatform", "\\comms\\")
WATCH_SECONDS = 75
MAX_LISTED = 400


def default_roots() -> list[Path]:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    names = [os.environ.get("LOCALAPPDATA"), os.environ.get("APPDATA"), str(home / "AppData" / "LocalLow"),
             str(home / "Documents"), str(home / "Saved Games"), os.environ.get("PROGRAMDATA")]
    roots = []
    for name in names:
        if name and Path(name).is_dir() and Path(name) not in roots:
            roots.append(Path(name))
    return roots


def is_noisy(path: str) -> bool:
    lowered = path.lower().replace("/", "\\")
    return any(part in lowered for part in NOISY)


def changed_since(roots: list[Path], since: float) -> list[tuple[str, int, float]]:
    """Every file under the roots created or changed at or after `since`: (path, size, modified time)."""
    found: list[tuple[str, int, float]] = []
    stack = [str(root) for root in roots]
    while stack:
        folder = stack.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not is_noisy(entry.path + os.sep):
                                stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            info = entry.stat()
                            if max(info.st_mtime, getattr(info, "st_ctime", 0.0)) >= since and not is_noisy(entry.path):
                                found.append((entry.path, info.st_size, info.st_mtime))
                    except OSError:
                        continue
        except OSError:
            continue
    return sorted(found, key=lambda item: item[2])


def run_text(command: list[str]) -> str:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def running_programs() -> dict[str, tuple[str, str]]:
    """Process id -> (name, path of its program), from Windows."""
    text = run_text(["powershell", "-NoProfile", "-Command",
                     "Get-Process | Select-Object Id,ProcessName,Path | ConvertTo-Csv -NoTypeInformation"])
    programs: dict[str, tuple[str, str]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        programs[str(row.get("Id", "")).strip()] = (row.get("ProcessName") or "", row.get("Path") or "")
    return programs


def listening_ports(programs: dict[str, tuple[str, str]]) -> list[tuple[str, str, str]]:
    """(address:port, program name, program path) for everything listening on this PC."""
    ports = []
    for line in run_text(["netstat", "-ano", "-p", "TCP"]).splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == "TCP" and parts[3] == "LISTENING":
            name, path = programs.get(parts[4], ("?", ""))
            ports.append((parts[1], name, path))
    return sorted(set(ports), key=lambda item: (item[1].lower(), item[0]))


def sim_folders(programs: dict[str, tuple[str, str]], words: list[str]) -> list[Path]:
    """Install folders of running programs whose name or path mentions the sim."""
    folders = []
    for name, path in programs.values():
        if path and any(word in f"{name} {path}".lower() for word in words):
            folder = Path(path).parent
            if folder.is_dir() and folder not in folders:
                folders.append(folder)
    return folders


def stamp(when: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(when))


def watch(paths: list[str], seconds: float, sleep=time.sleep, clock=time.time) -> list[tuple[float, str, int]]:
    """Poll the given files and note each time one changes: (time, path, new size)."""
    def state(path: str) -> tuple[int, float] | None:
        try:
            info = os.stat(path)
            return info.st_size, info.st_mtime
        except OSError:
            return None
    last = {path: state(path) for path in paths}
    events: list[tuple[float, str, int]] = []
    deadline = clock() + seconds
    while clock() < deadline:
        sleep(0.5)
        for path in paths:
            now = state(path)
            if now != last[path]:
                last[path] = now
                events.append((clock(), path, now[0] if now else -1))
    return events


def main(read_line=input, roots: list[Path] | None = None, sleep=time.sleep, out_dir: Path | None = None,
         watch_seconds: float = WATCH_SECONDS) -> int:
    print(__doc__.split("What you do:")[0].strip(), "\n")
    words = [w.strip().lower() for w in (read_line("Name of the sim (a word in its program name) [muni]: ").strip() or "muni").split(",") if w.strip()]
    read_line("Start the sim, get to the first tee, then press Enter here. ")
    started = time.time()
    print(f"\nStarted at {stamp(started)}. Play two or three holes now, then come back.")
    read_line("Press Enter when you have played. ")

    programs = running_programs()
    extra = sim_folders(programs, words)
    all_roots = (roots if roots is not None else default_roots()) + [folder for folder in extra if folder not in (roots or [])]
    print("\nLooking for files that changed (this can take a minute)...")
    changed = changed_since(all_roots, started - 2)
    likely = [item for item in changed if any(word in item[0].lower() for word in words)]
    ports = listening_ports(programs)

    lines = [f"Looper sim discovery, {time.strftime('%Y-%m-%d %H:%M')}", f"Sim: {', '.join(words)}",
             f"Play window: {stamp(started)} to {stamp(time.time())}", "", "Folders searched:"]
    lines += [f"  {root}" for root in all_roots]
    lines += ["", f"Sim programs running: {len(extra)}"] + [f"  {folder}" for folder in extra]
    lines += ["", f"Files changed with the sim's name in the path: {len(likely)}"]
    lines += [f"  {stamp(when)}  {size:>12,}  {path}" for path, size, when in likely[:MAX_LISTED]]
    others = [item for item in changed if item not in likely]
    lines += ["", f"Other files changed while you played: {len(others)} (first {min(len(others), MAX_LISTED)} shown)"]
    lines += [f"  {stamp(when)}  {size:>12,}  {path}" for path, size, when in others[:MAX_LISTED]]
    lines += ["", "Programs with open ports on this PC (address, program):"]
    lines += [f"  {address:<24} {name}  {path}" for address, name, path in ports]

    print(f"\n{len(likely)} changed files mention the sim; {len(others)} others changed.")
    watched = [path for path, _, _ in (likely or changed)][-60:]
    if watched:
        print(f"\nNow watching {len(watched)} files for {watch_seconds:g} seconds.")
        read_line("Get ready to hit ONE shot. Press Enter, then hit it. ")
        watch_start = time.time()
        events = watch(watched, watch_seconds, sleep=sleep)
        lines += ["", f"Watch: one shot hit after {stamp(watch_start)}. Files that changed, in order:"]
        lines += [f"  +{when - watch_start:5.1f} s  {size:>12,}  {path}" for when, path, size in events] or ["  (nothing changed)"]
        print(f"{len(events)} changes seen during the watch.")

    out = (out_dir or HERE) / f"sim_discovery_{time.strftime('%Y%m%d_%H%M%S')}.txt"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nSaved {out}\nSkim it, then send it to Claude.")
    try:
        read_line("Press Enter to close.")
    except (EOFError, KeyboardInterrupt):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
