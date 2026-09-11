#!/usr/bin/env python3
"""Fail-soft hardening shim for the Step 11 hazard field-test runner.

Keeps the existing field runner intact while ensuring post-round archaeology,
normalization, and comparison stages cannot stall the whole evidence package.
This remains field-lab tooling only; hosted looper.golf is the production app.
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

STAGE_TIMEOUTS_SECONDS = {
    "course_archaeology_collector.py": 90.0,
    "gkd_archaeology.py": 60.0,
    "course_asset_archaeology.py": 120.0,
    "course_hazard_cache.py": 60.0,
    "hazard_compare_report.py": 90.0,
}
DEFAULT_STAGE_TIMEOUT_SECONDS = 90.0

STAGE_LABELS = {
    "course_archaeology_collector.py": "archaeology collector (Step 2)",
    "gkd_archaeology.py": "GKD archaeology (Step 3)",
    "course_asset_archaeology.py": "Unity/assets archaeology (Step 4)",
    "course_hazard_cache.py": "normalize HazardGeometry (Step 9)",
    "hazard_compare_report.py": "compare sources (Step 10)",
}


def _script_name(command: list[str]) -> str:
    if len(command) > 1:
        return Path(str(command[1])).name
    if command:
        return Path(str(command[0])).name
    return "unknown"


def _bounded_run_process(
    command: list[str],
    *,
    cwd: Path,
    log_path: Path,
    timeout_override_s: float | None = None,
) -> dict[str, Any]:
    """Run one finalization child process with a hard timeout and fail-soft result."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    script = _script_name(command)
    label = STAGE_LABELS.get(script, script)
    timeout_s = (
        float(timeout_override_s)
        if timeout_override_s is not None
        else STAGE_TIMEOUTS_SECONDS.get(script, DEFAULT_STAGE_TIMEOUT_SECONDS)
    )
    print(f"[finalize] {label}...", flush=True)
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            completed = subprocess.run(
                command,
                cwd=str(cwd),
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=timeout_s,
            )
        status = "ok" if completed.returncode == 0 else "error"
        print(f"[finalize] {label}: {status}", flush=True)
        return {
            "status": status,
            "returncode": completed.returncode,
            "command": command,
            "timeout_seconds": timeout_s,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "log": str(log_path),
        }
    except subprocess.TimeoutExpired:
        with log_path.open("a", encoding="utf-8", errors="replace") as log:
            log.write(f"\nTIMEOUT: stage exceeded {timeout_s:.1f} seconds; Step 11 continued fail-soft.\n")
        print(f"[finalize] {label}: TIMEOUT after {timeout_s:.0f}s; continuing", flush=True)
        return {
            "status": "timeout",
            "returncode": None,
            "command": command,
            "timeout_seconds": timeout_s,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "log": str(log_path),
            "error": f"stage-timeout:{timeout_s:.1f}s",
        }
    except Exception as exc:
        print(f"[finalize] {label}: launch-error; continuing", flush=True)
        return {
            "status": "launch-error",
            "returncode": None,
            "command": command,
            "timeout_seconds": timeout_s,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "log": str(log_path),
            "error": f"{type(exc).__name__}: {exc}",
        }


def main() -> int:
    import hazard_field_run as field

    original_wait_for_shadow = field._wait_for_shadow
    original_make_zip = field._make_zip
    original_finalize_run = field.finalize_run

    def wait_for_shadow(*args: Any, **kwargs: Any) -> dict[str, Any]:
        print("[finalize] shadow workers settling...", flush=True)
        result = original_wait_for_shadow(*args, **kwargs)
        pending = len(result.get("pending") or [])
        print(f"[finalize] shadow settled ({pending} pending)", flush=True)
        return result

    def make_zip(source_dir: Path, zip_path: Path) -> None:
        print("[finalize] ZIP packaging...", flush=True)
        original_make_zip(source_dir, zip_path)
        print("[finalize] ZIP ready", flush=True)

    def finalize_run(*args: Any, **kwargs: Any):
        print("[finalize] watcher stopped -> finalizing Step 11 evidence", flush=True)
        return original_finalize_run(*args, **kwargs)

    field._run_process = _bounded_run_process
    field._wait_for_shadow = wait_for_shadow
    field._make_zip = make_zip
    field.finalize_run = finalize_run
    return field.main()


if __name__ == "__main__":
    raise SystemExit(main())
