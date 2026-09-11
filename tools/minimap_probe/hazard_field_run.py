#!/usr/bin/env python3
"""Step 11: one-command Looper hazard field-test session and bounded review package.

This is field-lab validation tooling only. It launches the persistent GSPro watcher,
binds all collected evidence to that watcher session, waits briefly for tee shadow
workers to finish, runs the read-only course archaeology collector, runs the Step 10
comparison report automatically, and creates one bounded review ZIP.

It never grants strategy authority and is not production architecture for looper.golf.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from typing import Any, Iterable

SCHEMA_VERSION = "looper-hazard-field-run-v0"
STRATEGY_AUTHORITY = False
HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT_ROOT = HERE / "output"
DEFAULT_GSPRO_DIR = Path.home() / "AppData" / "LocalLow" / "GSPro" / "GSPro"

CAPTURE_PREFIXES = ("tee_capture_", "approach_capture_")
ALLOWED_SUFFIXES = {
    ".json", ".jsonl", ".md", ".txt", ".dat", ".csv",
    ".png", ".jpg", ".jpeg", ".webp",
}
ALLOWED_EXACT_NAMES = {
    "features.json",
    "geometry_candidates.json",
    "hazard_geometry_v0.json",
    "hazard_field_shadow_v0.json",
    "hazard_shadow_v0.json",
    "hole_model.json",
    "capture_context.json",
    "shot_state.json",
    "course_hazard_cache_manifest.json",
    "collector_manifest.json",
}


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _safe_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in value).strip("-") or "run"


def _capture_dirs(root: Path) -> dict[str, float]:
    if not root.is_dir():
        return {}
    out: dict[str, float] = {}
    for path in root.iterdir():
        if path.is_dir() and path.name.startswith(CAPTURE_PREFIXES):
            try:
                out[path.name] = path.stat().st_mtime
            except OSError:
                pass
    return out


def _new_capture_dirs(root: Path, baseline: dict[str, float], started_epoch: float) -> list[Path]:
    if not root.is_dir():
        return []
    rows: list[Path] = []
    for path in root.iterdir():
        if not path.is_dir() or not path.name.startswith(CAPTURE_PREFIXES):
            continue
        try:
            path.stat().st_mtime
        except OSError:
            continue
        if path.name not in baseline:
            rows.append(path)
    return sorted(rows, key=lambda p: (p.stat().st_mtime, p.name))


def _wait_for_shadow(captures: list[Path], timeout_s: float, poll_s: float = 0.25) -> dict[str, Any]:
    tee = [p for p in captures if p.name.startswith("tee_capture_")]
    if not tee or timeout_s <= 0:
        return {"tee_capture_count": len(tee), "ready": [], "pending": [p.name for p in tee], "waited_seconds": 0.0}
    deadline = time.monotonic() + timeout_s
    while True:
        pending = [p for p in tee if not (p / "hazard_field_shadow_v0.json").is_file()]
        if not pending or time.monotonic() >= deadline:
            break
        time.sleep(min(poll_s, max(0.0, deadline - time.monotonic())))
    ready = [p.name for p in tee if (p / "hazard_field_shadow_v0.json").is_file()]
    ready_set = set(ready)
    pending = [p.name for p in tee if p.name not in ready_set]
    return {
        "tee_capture_count": len(tee),
        "ready": ready,
        "pending": pending,
        "waited_seconds": round(max(0.0, timeout_s - max(0.0, deadline - time.monotonic())), 3),
    }


def _copy_allowed_tree(
    source: Path,
    destination: Path,
    *,
    max_file_bytes: int,
    remaining_bytes: list[int],
    records: list[dict[str, Any]],
    source_label: str,
) -> None:
    if not source.exists():
        return
    paths = [source] if source.is_file() else sorted(p for p in source.rglob("*") if p.is_file())
    for path in paths:
        try:
            rel = path.name if source.is_file() else str(path.relative_to(source))
            size = path.stat().st_size
        except Exception as exc:
            records.append({"source": str(path), "status": "stat-error", "error": str(exc), "group": source_label})
            continue
        allowed = path.name in ALLOWED_EXACT_NAMES or path.suffix.lower() in ALLOWED_SUFFIXES
        if not allowed:
            records.append({"source": str(path), "status": "skipped-type", "size_bytes": size, "group": source_label})
            continue
        if size > max_file_bytes:
            records.append({"source": str(path), "status": "skipped-file-budget", "size_bytes": size, "group": source_label})
            continue
        if size > remaining_bytes[0]:
            records.append({"source": str(path), "status": "skipped-total-budget", "size_bytes": size, "group": source_label})
            continue
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(path, target)
            remaining_bytes[0] -= size
            records.append({"source": str(path), "destination": str(target), "status": "copied", "size_bytes": size, "group": source_label})
        except Exception as exc:
            records.append({"source": str(path), "status": "copy-error", "error": str(exc), "group": source_label})


def _cache_entry_dirs(captures: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for capture in captures:
        manifest = _read_json(capture / "hazard_field_shadow_v0.json")
        cache = ((manifest.get("source_status") or {}).get("course_cache") or {})
        raw = cache.get("entry_dir")
        if not raw:
            continue
        path = Path(str(raw)).expanduser()
        try:
            key = str(path.resolve()).lower()
        except Exception:
            key = str(path).lower()
        if key not in seen and path.is_dir():
            seen.add(key)
            out.append(path)
    return out


def _run_process(command: list[str], *, cwd: Path, log_path: Path) -> dict[str, Any]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            completed = subprocess.run(command, cwd=str(cwd), stdout=log, stderr=subprocess.STDOUT, check=False)
        return {
            "status": "ok" if completed.returncode == 0 else "error",
            "returncode": completed.returncode,
            "command": command,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "log": str(log_path),
        }
    except Exception as exc:
        return {
            "status": "launch-error",
            "returncode": None,
            "command": command,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "log": str(log_path),
            "error": f"{type(exc).__name__}: {exc}",
        }


def _latest_dir(root: Path, prefix: str, after_epoch: float) -> Path | None:
    if not root.is_dir():
        return None
    rows = []
    for path in root.iterdir():
        if path.is_dir() and path.name.startswith(prefix):
            try:
                if path.stat().st_mtime >= after_epoch - 2.0:
                    rows.append(path)
            except OSError:
                pass
    return max(rows, key=lambda p: p.stat().st_mtime) if rows else None


def _make_zip(source_dir: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir.parent))


def watcher_command(args: argparse.Namespace, state_file: Path) -> list[str]:
    command = [
        sys.executable,
        str(HERE / "round_watch_v32.py"),
        "--monitor", str(args.monitor),
        "--poll-ms", str(args.poll_ms),
        "--posttee-min-settle-ms", str(args.posttee_min_settle_ms),
        "--capture-retry-ms", str(args.capture_retry_ms),
        "--max-capture-attempts", str(args.max_capture_attempts),
        "--transition-stable-observations", str(args.transition_stable_observations),
        "--log-hole-fresh-seconds", str(args.log_hole_fresh_seconds),
        "--state-file", str(state_file),
        "--gspro-dir", str(Path(args.gspro_dir).expanduser()),
    ]
    if not args.dry_run:
        command.append("--execute-actions")
    if args.roi:
        command += ["--roi", args.roi]
    if args.tesseract:
        command += ["--tesseract", args.tesseract]
    if args.no_aim_debug:
        command.append("--no-aim-debug")
    return command


def finalize_run(
    args: argparse.Namespace,
    *,
    run_dir: Path,
    output_root: Path,
    baseline_captures: dict[str, float],
    started_epoch: float,
    state_file: Path,
    manifest: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    evidence_dir = run_dir / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    captures = _new_capture_dirs(output_root, baseline_captures, started_epoch)
    shadow_wait = _wait_for_shadow(captures, args.shadow_settle_seconds)
    manifest["shadow_settle"] = shadow_wait
    if shadow_wait["pending"]:
        manifest["warnings"].append(
            f"{len(shadow_wait['pending'])} tee capture(s) still lacked hazard_field_shadow_v0.json at finalize; package remains usable but incomplete."
        )

    state = _read_json(state_file)
    session_id = str(state.get("session_id") or "").strip() or None
    manifest["watcher_session_id"] = session_id
    manifest["capture_count"] = len(captures)
    manifest["capture_dirs"] = [p.name for p in captures]

    max_file_bytes = int(args.max_file_mb * 1024 * 1024)
    remaining = [int(args.max_total_mb * 1024 * 1024)]
    copy_records: list[dict[str, Any]] = []

    for capture in captures:
        _copy_allowed_tree(
            capture,
            evidence_dir / "captures" / capture.name,
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="capture",
        )

    if state_file.is_file():
        _copy_allowed_tree(
            state_file,
            evidence_dir / "watcher" / state_file.name,
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="watcher-state",
        )
    if session_id:
        corpus = output_root / "round_watch_corpus_v3" / session_id
        _copy_allowed_tree(
            corpus,
            evidence_dir / "watcher" / "round_watch_corpus_v3" / session_id,
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="watcher-corpus",
        )

    for index, cache_dir in enumerate(_cache_entry_dirs(captures), 1):
        _copy_allowed_tree(
            cache_dir,
            evidence_dir / "course_cache" / f"entry_{index:02d}",
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="course-cache",
        )

    # Steps 2-4 are run automatically after play. The work directory lives outside
    # the review package; only bounded evidence and normalized geometry are copied in.
    # This replaces the old request for a generic course ZIP with targeted evidence.
    work_root = output_root / ".hazard_field_work" / run_dir.name
    archaeology_root = work_root / "collector"
    archaeology_started = time.time()
    archaeology_command = [
        sys.executable, str(HERE / "course_archaeology_collector.py"),
        "--locallow", str(Path(args.gspro_dir).expanduser()),
        "--output-root", str(archaeology_root),
        "--max-copy-mb", str(min(args.max_file_mb, 8.0)),
        "--no-zip",
    ]
    archaeology = _run_process(
        archaeology_command,
        cwd=HERE,
        log_path=run_dir / "logs" / "course_archaeology.log",
    )
    manifest["course_archaeology_collector"] = archaeology
    archaeology_dir = _latest_dir(archaeology_root, "course_archaeology_", archaeology_started)
    if archaeology_dir:
        _copy_allowed_tree(
            archaeology_dir,
            evidence_dir / "course_archaeology" / "collector",
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="course-archaeology-collector",
        )
    elif archaeology.get("status") != "ok":
        manifest["warnings"].append("Course archaeology collector did not produce a run directory; continuing without it.")

    gkd_root = work_root / "gkd"
    gkd_started = time.time()
    gkd_command = [
        sys.executable, str(HERE / "gkd_archaeology.py"),
        "--locallow", str(Path(args.gspro_dir).expanduser()),
        "--output-root", str(gkd_root),
    ]
    gkd_run = _run_process(gkd_command, cwd=HERE, log_path=run_dir / "logs" / "gkd_archaeology.log")
    manifest["gkd_archaeology"] = gkd_run
    gkd_dir = _latest_dir(gkd_root, "gkd_archaeology_", gkd_started)
    if gkd_dir:
        _copy_allowed_tree(
            gkd_dir,
            evidence_dir / "course_archaeology" / "gkd",
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="gkd-archaeology",
        )
    else:
        manifest["warnings"].append("GKD archaeology produced no run directory; continuing without fresh GKD evidence.")

    asset_root = work_root / "assets"
    asset_started = time.time()
    asset_command = [
        sys.executable, str(HERE / "course_asset_archaeology.py"),
        "--locallow", str(Path(args.gspro_dir).expanduser()),
        "--output-root", str(asset_root),
        "--no-mesh-export",
        "--no-zip",
    ]
    asset_run = _run_process(
        asset_command,
        cwd=HERE,
        log_path=run_dir / "logs" / "course_asset_archaeology.log",
    )
    manifest["course_asset_archaeology"] = asset_run
    asset_dir = _latest_dir(asset_root, "course_asset_archaeology_", asset_started)
    if asset_dir:
        _copy_allowed_tree(
            asset_dir,
            evidence_dir / "course_archaeology" / "unity",
            max_file_bytes=max_file_bytes,
            remaining_bytes=remaining,
            records=copy_records,
            source_label="course-asset-archaeology",
        )
    else:
        manifest["warnings"].append("Course-asset archaeology produced no run directory; Unity transform remains blocked.")

    # Normalize fresh Step 3/4 outputs into a run-local Step 9 bundle so Step 10 can
    # score them in the same report. This cache is temporary and never strategy-authoritative.
    analysis_inputs: list[Path] = []
    if gkd_dir and (gkd_dir / "features.json").is_file():
        analysis_inputs.append(gkd_dir / "features.json")
    if asset_dir and (asset_dir / "geometry_candidates.json").is_file():
        analysis_inputs.append(asset_dir / "geometry_candidates.json")
    course_key = state.get("course_key")
    course_name = state.get("course_name")
    if (not course_key or not course_name) and captures:
        for capture in reversed(captures):
            context = _read_json(capture / "capture_context.json")
            nested = context.get("identity") if isinstance(context.get("identity"), dict) else {}
            course_key = course_key or context.get("course_key") or nested.get("course_key")
            course_name = course_name or context.get("course_name") or nested.get("course_name")
            if course_key and course_name:
                break
    if analysis_inputs and (course_key or course_name):
        cache_root = work_root / "normalized_cache"
        cache_command = [
            sys.executable, str(HERE / "course_hazard_cache.py"),
            "--cache-root", str(cache_root),
            "build",
        ]
        if course_key:
            cache_command += ["--course-key", str(course_key)]
        if course_name:
            cache_command += ["--course-name", str(course_name)]
        for item in analysis_inputs:
            cache_command += ["--input", str(item)]
        cache_run = _run_process(
            cache_command,
            cwd=HERE,
            log_path=run_dir / "logs" / "course_cache_build.log",
        )
        manifest["fresh_course_geometry_normalization"] = cache_run
        bundles = sorted(cache_root.rglob("hazard_geometry_v0.json")) if cache_root.is_dir() else []
        for index, bundle in enumerate(bundles, 1):
            target = evidence_dir / "course_archaeology" / "normalized" / f"entry_{index:02d}"
            _copy_allowed_tree(
                bundle,
                target / bundle.name,
                max_file_bytes=max_file_bytes,
                remaining_bytes=remaining,
                records=copy_records,
                source_label="fresh-course-geometry",
            )
            sibling_manifest = bundle.parent / "course_hazard_cache_manifest.json"
            if sibling_manifest.is_file():
                _copy_allowed_tree(
                    sibling_manifest,
                    target / sibling_manifest.name,
                    max_file_bytes=max_file_bytes,
                    remaining_bytes=remaining,
                    records=copy_records,
                    source_label="fresh-course-geometry",
                )
        if not bundles:
            manifest["warnings"].append("Fresh Step 3/4 outputs were found but normalization produced no HazardGeometry bundle.")
    else:
        manifest["fresh_course_geometry_normalization"] = {
            "status": "skipped",
            "reason": "no-analysis-inputs-or-course-identity",
            "strategy_authority": False,
        }

    # Step 10 consumes only this run's staged evidence, preventing historical output
    # from leaking into the scorecard.
    comparison_root = run_dir / "comparison"
    comparison_started = time.time()
    compare_command = [
        sys.executable, str(HERE / "hazard_compare_report.py"),
        "--capture-root", str(evidence_dir),
        "--output-root", str(comparison_root),
        "--no-zip",
    ]
    comparison = _run_process(
        compare_command,
        cwd=HERE,
        log_path=run_dir / "logs" / "hazard_compare.log",
    )
    manifest["step10_comparison"] = comparison
    comparison_dir = _latest_dir(comparison_root, "hazard_comparison_", comparison_started)
    if comparison_dir:
        manifest["step10_report_dir"] = str(comparison_dir)
    else:
        manifest["warnings"].append("Step 10 comparison did not produce a report directory; raw field evidence is still packaged.")

    manifest["copy_records"] = copy_records
    manifest["packaging_budget"] = {
        "max_file_mb": args.max_file_mb,
        "max_total_mb": args.max_total_mb,
        "remaining_bytes_before_step10": remaining[0],
        "copied_file_count": sum(1 for row in copy_records if row.get("status") == "copied"),
        "skipped_file_count": sum(1 for row in copy_records if str(row.get("status", "")).startswith("skipped")),
    }
    manifest["finished_utc"] = iso_now()
    manifest["strategy_authority"] = False
    manifest["promotion_decision"] = "none"
    _write_json(run_dir / "field_run_manifest.json", manifest)

    zip_path = output_root / f"hazard_field_review_{run_dir.name.removeprefix('hazard_field_run_')}.zip"
    try:
        _make_zip(run_dir, zip_path)
        manifest["review_zip"] = str(zip_path)
    except Exception as exc:
        manifest["errors"].append(f"review-zip:{type(exc).__name__}:{exc}")
    _write_json(run_dir / "field_run_manifest.json", manifest)
    try:
        shutil.rmtree(work_root, ignore_errors=True)
    except Exception:
        pass
    return zip_path, manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Step 11: one-command Looper hazard field-test run")
    parser.add_argument("--monitor", type=int, default=1)
    parser.add_argument("--roi")
    parser.add_argument("--tesseract")
    parser.add_argument("--gspro-dir", default=str(DEFAULT_GSPRO_DIR))
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--poll-ms", type=float, default=350.0)
    parser.add_argument("--posttee-min-settle-ms", type=float, default=850.0)
    parser.add_argument("--capture-retry-ms", type=float, default=1100.0)
    parser.add_argument("--max-capture-attempts", type=int, default=2)
    parser.add_argument("--transition-stable-observations", type=int, default=2)
    parser.add_argument("--log-hole-fresh-seconds", type=float, default=3.0)
    parser.add_argument("--shadow-settle-seconds", type=float, default=20.0)
    parser.add_argument("--max-file-mb", type=float, default=8.0)
    parser.add_argument("--max-total-mb", type=float, default=80.0)
    parser.add_argument("--no-aim-debug", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Observe watcher lifecycle without executing capture actions")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_id = f"{stamp}_{uuid.uuid4().hex[:6]}"
    run_dir = output_root / f"hazard_field_run_{_safe_name(run_id)}"
    run_dir.mkdir(parents=True, exist_ok=True)
    state_file = run_dir / "watcher_state.json"
    started_epoch = time.time()
    baseline_captures = _capture_dirs(output_root)

    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "started_utc": iso_now(),
        "started_epoch": started_epoch,
        "field_lab_only": True,
        "production_architecture": "hosted-looper.golf-web-only",
        "strategy_authority": False,
        "promotion_decision": "none",
        "warnings": [],
        "errors": [],
    }
    _write_json(run_dir / "field_run_manifest.json", manifest)

    command = watcher_command(args, state_file)
    manifest["watcher_command"] = command
    _write_json(run_dir / "field_run_manifest.json", manifest)

    print("Looper Hazard Field Test — Step 11")
    print(f"Run: {run_id}")
    print("Play GSPro normally. Press Ctrl+C when you want to finalize the evidence package.")
    print("Hazard strategy authority: OFF | Promotion: NONE")

    watcher: subprocess.Popen[Any] | None = None
    try:
        watcher = subprocess.Popen(command, cwd=str(HERE))
        watcher_returncode = watcher.wait()
        manifest["watcher_returncode"] = watcher_returncode
        if watcher_returncode != 0:
            manifest["warnings"].append(f"Watcher exited with code {watcher_returncode}; finalization will still run.")
    except KeyboardInterrupt:
        manifest["stop_reason"] = "user-ctrl-c"
        if watcher is not None and watcher.poll() is None:
            try:
                watcher.wait(timeout=4.0)
            except subprocess.TimeoutExpired:
                try:
                    watcher.terminate()
                    watcher.wait(timeout=3.0)
                except Exception:
                    try:
                        watcher.kill()
                    except Exception:
                        pass
        manifest["watcher_returncode"] = watcher.poll() if watcher is not None else None
    except Exception as exc:
        manifest["errors"].append(f"watcher-launch:{type(exc).__name__}:{exc}")
        manifest["stop_reason"] = "watcher-launch-error"

    zip_path, manifest = finalize_run(
        args,
        run_dir=run_dir,
        output_root=output_root,
        baseline_captures=baseline_captures,
        started_epoch=started_epoch,
        state_file=state_file,
        manifest=manifest,
    )

    print("\nField test finalized.")
    print(f"Run directory: {run_dir}")
    print(f"Review ZIP: {zip_path if zip_path.exists() else 'ZIP FAILED - see manifest'}")
    print(f"Captures: {manifest.get('capture_count', 0)} | watcher session: {manifest.get('watcher_session_id') or 'unknown'}")
    comparison = manifest.get("step10_comparison") or {}
    print(f"Step 10 comparison: {comparison.get('status', 'unknown')}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 0 if not manifest.get("errors") else 1


if __name__ == "__main__":
    raise SystemExit(main())
