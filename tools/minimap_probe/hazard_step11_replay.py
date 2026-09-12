#!/usr/bin/env python3
"""Replay the latest Step 11 field evidence without actuating GSPro.

This is deliberately a field-lab utility, not Looper deployment architecture. It:
1) replays saved tee Y-pairs through the current green classifier;
2) inspects (and optionally reruns) Luna on saved tee imagery only;
3) replays saved post-tee minimaps against their exact tee HoleModel using the
   current registration code and PIN-distance trust gate.

No keyboard/mouse/GSPro actuation occurs here. Strategy authority remains OFF.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

import cv2

import green_heatmap
import posttee_geometry_v2


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "output"


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _tee_dirs(output: Path, limit: int) -> list[Path]:
    rows = [p for p in output.glob("tee_capture_*") if p.is_dir()]
    rows.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return list(reversed(rows[: max(1, int(limit))]))


def _approach_dirs(output: Path, limit: int) -> list[Path]:
    rows = [p for p in output.glob("approach_capture_*") if p.is_dir()]
    rows.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return list(reversed(rows[: max(1, int(limit))]))


def _manifest_status(capture: Path) -> dict[str, Any]:
    manifest_path = capture / "hazard_field_shadow_v0.json"
    if not manifest_path.is_file():
        return {"status": "missing-manifest"}
    try:
        manifest = _read(manifest_path)
        status = ((manifest.get("source_status") or {}).get("openai_vlm") or {})
        return status if isinstance(status, dict) else {"status": "malformed-status"}
    except Exception as exc:
        return {"status": "manifest-read-error", "error": str(exc)}


def _base_available(capture: Path) -> bool:
    path = capture / "hole_model.json"
    if not path.is_file():
        return False
    try:
        model = _read(path)
        return (model.get("base_geometry") or {}).get("available") is not False
    except Exception:
        return False


def _rerun_luna(capture: Path, timeout: float) -> None:
    script = HERE / "hazard_field_openai_enrich.py"
    cmd = [
        sys.executable,
        str(script),
        "--capture-dir",
        str(capture),
        "--allow-unconfirmed-semantic-image",
        "--no-sam",
        "--timeout",
        str(timeout),
    ]
    completed = subprocess.run(
        cmd,
        cwd=str(HERE),
        check=False,
        capture_output=True,
        text=True,
        timeout=max(15.0, float(timeout) + 15.0),
    )
    out = (completed.stdout or "").strip()
    err = (completed.stderr or "").strip()
    if out:
        print(f"    Luna replay: {out.splitlines()[-1]}")
    if err:
        print(f"    Luna stderr: {err.splitlines()[-1]}")


def _heatmap_replay(capture: Path) -> tuple[bool, str]:
    initial_path = capture / "tee_initial_minimap.png"
    toggled_path = capture / "tee_toggled_minimap.png"
    if not initial_path.is_file() or not toggled_path.is_file():
        return False, "pair missing"
    initial = cv2.imread(str(initial_path), cv2.IMREAD_COLOR)
    toggled = cv2.imread(str(toggled_path), cv2.IMREAD_COLOR)
    try:
        result = green_heatmap.classify_minimap_pair(initial, toggled)
        return True, (
            f"PASS mode={result.difference_mode} changed={result.changed_pixel_ratio:.4%} "
            f"green_area={result.target_green_area_px}px confidence={result.confidence:.2f}"
        )
    except Exception as exc:
        return False, f"FAIL {exc}"


def _fmt_luna(status: dict[str, Any]) -> str:
    state = status.get("status") or "unknown"
    model = status.get("model")
    latency = status.get("provider_latency_seconds")
    counts = status.get("hazard_counts") or {}
    error = status.get("error")
    parts = [str(state)]
    if model:
        parts.append(str(model))
    if latency is not None:
        try:
            parts.append(f"{float(latency):.2f}s")
        except Exception:
            pass
    if counts:
        parts.append(f"hazards={counts}")
    if error:
        parts.append(f"error={error}")
    return " | ".join(parts)


def _pin_yards(state: dict[str, Any]) -> float | None:
    try:
        value = (state.get("pin") or {}).get("distance_yds")
        return float(value) if value is not None else None
    except Exception:
        return None


def _replay_approach(capture: Path) -> tuple[bool, bool, str, str | None]:
    state_path = capture / "shot_state.json"
    image_path = capture / "approach_minimap.png"
    if not state_path.is_file() or not image_path.is_file():
        return False, False, "saved ShotState/minimap missing", None
    state = _read(state_path)
    model_raw = state.get("requested_hole_model_path")
    pin_yds = _pin_yards(state)
    if not model_raw or pin_yds is None:
        return False, False, "no exact HoleModel or trusted PIN distance", None
    model_path = Path(str(model_raw))
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        return False, False, "could not read saved approach minimap", model_path.parent.name

    try:
        result = posttee_geometry_v2.analyze(
            current_minimap=image,
            pin_distance_yds=pin_yds,
            hole_model_path=model_path,
        )
        reg = result.get("registration") or {}
        cross = result.get("pin_distance_crosscheck") or {}
        trusted = bool(result.get("geometry_trusted"))
        detail = (
            f"{'TRUSTED' if trusted else 'REJECTED'} "
            f"matches={reg.get('good_matches')} inliers={reg.get('inliers')} "
            f"ratio={float(reg.get('inlier_ratio') or 0):.2f} "
            f"reproj={float(reg.get('median_reprojection_error_px') or 0):.2f}px "
            f"mode={reg.get('acceptance_mode')} "
            f"pin={float(cross.get('canonical_remaining_pin_yds') or 0):.1f}/"
            f"{float(cross.get('screen_pin_distance_yds') or 0):.1f}yd"
        )
        return True, trusted, detail, model_path.parent.name
    except Exception as exc:
        return True, False, f"FAIL {exc}", model_path.parent.name


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Offline replay of latest Looper Step 11 field evidence")
    p.add_argument("--output-root", default=str(DEFAULT_OUTPUT))
    p.add_argument("--tee-limit", type=int, default=4)
    p.add_argument("--approach-limit", type=int, default=12)
    p.add_argument("--rerun-luna", action="store_true")
    p.add_argument("--luna-timeout", type=float, default=60.0)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    output = Path(args.output_root).expanduser().resolve()
    tees = _tee_dirs(output, args.tee_limit)
    if not tees:
        print("STEP 11 REPLAY: no saved tee captures found")
        return 1

    print("Looper Step 11 OFFLINE replay")
    print("GSPro actuation: NONE | Strategy authority: OFF")
    print()

    tee_names = {p.name for p in tees}
    valid_tees = 0
    luna_complete = 0
    heatmap_ok = 0

    for capture in tees:
        base_ok = _base_available(capture)
        if base_ok:
            valid_tees += 1
        heat_ok, heat_detail = _heatmap_replay(capture)
        if base_ok and heat_ok:
            heatmap_ok += 1

        status = _manifest_status(capture)
        if (
            args.rerun_luna
            and base_ok
            and status.get("status") != "complete"
            and os.environ.get("OPENAI_API_KEY")
        ):
            try:
                _rerun_luna(capture, args.luna_timeout)
            except Exception as exc:
                print(f"    Luna replay failed to launch: {exc}")
            status = _manifest_status(capture)

        if base_ok and status.get("status") == "complete":
            luna_complete += 1

        print(f"TEE {capture.name} | base={'READY' if base_ok else 'UNAVAILABLE'}")
        print(f"    Y pair: {heat_detail}")
        print(f"    Luna:   {_fmt_luna(status)}")

    print()
    print("POST-TEE REGISTRATION REPLAY")
    approach_total = 0
    approach_trusted = 0
    for capture in _approach_dirs(output, args.approach_limit):
        attempted, trusted, detail, tee_name = _replay_approach(capture)
        if not attempted or tee_name not in tee_names:
            continue
        approach_total += 1
        approach_trusted += int(trusted)
        print(f"APPROACH {capture.name} -> {tee_name}")
        print(f"    {detail}")

    print()
    print(
        f"STEP11 SUMMARY | valid_tees={valid_tees} | Luna_complete={luna_complete}/{valid_tees} | "
        f"Y_pair_recovered={heatmap_ok}/{valid_tees} | posttee_trusted={approach_trusted}/{approach_total}"
    )
    if args.rerun_luna and not os.environ.get("OPENAI_API_KEY"):
        print("NOTE: OPENAI_API_KEY missing; Luna rerun was not attempted.")
    print("No GSPro input was sent. No strategy layer was promoted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
