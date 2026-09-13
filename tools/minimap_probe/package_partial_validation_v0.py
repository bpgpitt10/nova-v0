#!/usr/bin/env python3
"""Package one GSPro round-watch session for offline Looper validation.

This is intentionally post-run tooling. It does not touch GSPro, press keys, or change
strategy authority. It gathers only captures tagged to one watcher session, writes a
compact QA manifest, and creates a ZIP suitable for offline fairway/green/geometry
review.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any
import zipfile


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT_ROOT = HERE / "output"
DEFAULT_STATE = DEFAULT_OUTPUT_ROOT / "round_watch_state.json"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def nested_find(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for child in value.values():
            found = nested_find(child, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = nested_find(child, key)
            if found is not None:
                return found
    return None


def target_summary(target: Any) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    return {
        "distance_yds": target.get("distance_yds"),
        "elevation_raw": target.get("elevation_raw"),
        "elevation_direction": target.get("elevation_direction"),
        "elevation_delta_ft": target.get("elevation_delta_ft"),
        "source": target.get("source"),
    }


def file_flags(folder: Path, names: list[str]) -> dict[str, bool]:
    return {name: (folder / name).is_file() for name in names}


def capture_summary(folder: Path, context: dict[str, Any]) -> dict[str, Any]:
    shot = read_json(folder / "shot_state.json") or {}
    hole_model = read_json(folder / "hole_model.json") or {}
    capture_type = context.get("capture_type")

    row: dict[str, Any] = {
        "capture_folder": folder.name,
        "capture_type": capture_type,
        "course_name": context.get("course_name"),
        "hole_number": context.get("hole_number"),
        "par": context.get("par"),
        "shot_number": context.get("shot_number"),
        "capture_succeeded": context.get("capture_succeeded"),
        "pin": target_summary(shot.get("pin")),
        "aim": target_summary(shot.get("aim")),
        "aim_acquisition_status": (shot.get("aim_acquisition") or {}).get("status") if isinstance(shot.get("aim_acquisition"), dict) else None,
        "aim_return_verified": (shot.get("aim_acquisition") or {}).get("verified_return") if isinstance(shot.get("aim_acquisition"), dict) else None,
        "wind_present": shot.get("wind") is not None,
    }

    if capture_type == "tee":
        row["green"] = {
            "heatmap_confidence": nested_find(hole_model, "heatmap_confidence"),
            "changed_pixel_ratio": nested_find(hole_model, "changed_pixel_ratio"),
            "target_green_area_px": nested_find(hole_model, "target_green_area_px"),
            "target_green_bbox": nested_find(hole_model, "target_green_bbox"),
            "pin_distance_to_mask_px": nested_find(hole_model, "pin_distance_to_mask_px"),
            "heatmap_was_initial_state": nested_find(hole_model, "heatmap_was_initial_state"),
        }
        row["files"] = file_flags(folder, [
            "hole_model.json",
            "shot_state.json",
            "tee_initial_screen.png",
            "tee_toggled_screen.png",
            "tee_heatmap_minimap.png",
            "tee_target_green_mask.png",
            "tee_green_debug_overlay.png",
            "tee_hazard_safe_minimap.png",
            "latest_pin_card_v6.png",
            "latest_aim_card_v6.png",
        ])
    else:
        geometry = shot.get("canonical_geometry") if isinstance(shot.get("canonical_geometry"), dict) else {}
        registration = geometry.get("registration") if isinstance(geometry.get("registration"), dict) else {}
        green_visibility = geometry.get("green_visibility") if isinstance(geometry.get("green_visibility"), dict) else {}
        crosscheck = geometry.get("pin_distance_crosscheck") if isinstance(geometry.get("pin_distance_crosscheck"), dict) else {}
        row["posttee_geometry"] = {
            "attempted": shot.get("canonical_geometry_attempted"),
            "trusted": shot.get("canonical_geometry_trusted"),
            "warning": shot.get("canonical_geometry_warning"),
            "registration_confidence": registration.get("confidence"),
            "registration_inliers": registration.get("inliers"),
            "pin_distance_crosscheck_ok": crosscheck.get("ok"),
            "green_visible": green_visibility.get("visible"),
            "w_recovery_recommended": geometry.get("w_recovery_recommended"),
        }
        row["lie_slope"] = shot.get("lie_slope")
        row["files"] = file_flags(folder, [
            "shot_state.json",
            "approach_initial_screen.png",
            "approach_minimap.png",
            "approach_lie_footer.png",
            "approach_pin_card.png",
            "approach_aim_card.png",
        ])
    return row


def discover_session(output_root: Path, state_path: Path, requested: str | None) -> str:
    if requested:
        return requested
    state = read_json(state_path)
    if state and state.get("session_id"):
        return str(state["session_id"])
    newest: tuple[float, str] | None = None
    for folder in output_root.iterdir() if output_root.exists() else []:
        context_path = folder / "capture_context.json"
        context = read_json(context_path) if context_path.is_file() else None
        if not context or not context.get("watcher_session_id"):
            continue
        stamp = float(context.get("tagged_local_epoch") or folder.stat().st_mtime)
        candidate = (stamp, str(context["watcher_session_id"]))
        if newest is None or candidate[0] > newest[0]:
            newest = candidate
    if newest:
        return newest[1]
    raise RuntimeError("Could not determine a watcher session. Run round_watch first or pass --session-id.")


def matching_captures(output_root: Path, session_id: str) -> list[tuple[Path, dict[str, Any]]]:
    captures: list[tuple[Path, dict[str, Any]]] = []
    if not output_root.exists():
        return captures
    for folder in output_root.iterdir():
        if not folder.is_dir() or not (folder.name.startswith("tee_capture_") or folder.name.startswith("approach_capture_")):
            continue
        context = read_json(folder / "capture_context.json")
        if context and str(context.get("watcher_session_id")) == session_id:
            captures.append((folder, context))
    captures.sort(key=lambda item: float(item[1].get("tagged_local_epoch") or item[0].stat().st_mtime))
    return captures


def build_manifest(session_id: str, captures: list[tuple[Path, dict[str, Any]]], state: dict[str, Any] | None) -> dict[str, Any]:
    rows = [capture_summary(folder, context) for folder, context in captures]
    tee_rows = [r for r in rows if r.get("capture_type") == "tee"]
    post_rows = [r for r in rows if r.get("capture_type") == "post-tee"]
    holes = sorted({r.get("hole_number") for r in rows if r.get("hole_number") is not None})
    return {
        "schema_version": "looper-partial-validation-package-v0",
        "watcher_session_id": session_id,
        "created_local_epoch": time.time(),
        "capture_counts": {"total": len(rows), "tee": len(tee_rows), "post_tee": len(post_rows), "holes": len(holes)},
        "holes": holes,
        "captures": rows,
        "planned_offline_tests": [
            "fairway carry-arc validation at C-sigma, C, and C+sigma on tee captures",
            "heatmap-derived target-green mask visual QA and pin proximity",
            "tee canonical green reuse under post-tee registration and green visibility/cropping",
            "PIN/AIM target-card distance and signed elevation consistency",
            "post-tee lie OCR plausibility",
            "hazard geometry alignment and penalty/OB unsafe-side evidence collection",
            "AIM summon/return reliability and capture-state restoration",
            "player/team-color marker robustness from saved minimap pixels",
        ],
        "explicitly_not_tested": [
            "candidate-specific terrain elevation (deferred by v1 contract)",
            "strategy recommendation authority or automatic aim actuation",
            "wind extraction unless an independent Looper wind source is present in ShotState",
        ],
        "round_watch_state": state,
    }


def write_zip(zip_path: Path, output_root: Path, captures: list[tuple[Path, dict[str, Any]]], manifest_path: Path, state_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(manifest_path, arcname="partial_validation_manifest.json")
        if state_path.is_file():
            zf.write(state_path, arcname="round_watch_state.json")
        for folder, _context in captures:
            for path in sorted(folder.rglob("*")):
                if path.is_file() and path.suffix.lower() != ".zip":
                    zf.write(path, arcname=f"captures/{folder.name}/{path.relative_to(folder).as_posix()}")


def main() -> int:
    p = argparse.ArgumentParser(description="Package a partial Greywolf watcher session for offline review")
    p.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    p.add_argument("--state-file", default=str(DEFAULT_STATE))
    p.add_argument("--session-id")
    p.add_argument("--zip-path")
    args = p.parse_args()

    output_root = Path(args.output_root).expanduser().resolve()
    state_path = Path(args.state_file).expanduser().resolve()
    session_id = discover_session(output_root, state_path, args.session_id)
    captures = matching_captures(output_root, session_id)
    if not captures:
        raise RuntimeError(f"No tagged capture folders found for session {session_id}")

    state = read_json(state_path)
    manifest = build_manifest(session_id, captures, state)
    manifest_path = output_root / f"partial_validation_{session_id}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    zip_path = Path(args.zip_path).expanduser().resolve() if args.zip_path else output_root / f"partial_validation_{session_id}.zip"
    write_zip(zip_path, output_root, captures, manifest_path, state_path)
    latest = output_root / "latest_partial_validation.zip"
    if latest.resolve() != zip_path.resolve():
        shutil.copy2(zip_path, latest)

    counts = manifest["capture_counts"]
    print("Looper partial validation package")
    print(f"Session:     {session_id}")
    print(f"Holes:       {counts['holes']}")
    print(f"Tee:         {counts['tee']}")
    print(f"Post-tee:    {counts['post_tee']}")
    print(f"Manifest:    {manifest_path}")
    print(f"ZIP:         {zip_path}")
    print(f"Latest ZIP:  {latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
