#!/usr/bin/env python3
"""Replay the 2026-09-11 FarmLinks Step 11 field evidence as a regression suite.

This is deliberately tied to saved simulator-PC artifacts listed in the regression
manifest. It makes the important field discoveries executable rather than leaving
them only in chat/log prose:
- H1 tee-capture race remains a known negative case;
- H2-H4 retain valid tee base geometry and completed Luna semantics;
- the ignored-first-Y-pulse signature remains detectable from raw saved frames;
- ordinary post-tee registration stays trusted;
- the legitimate ~141 degree GSPro minimap rotation stays trusted;
- currentRound DistanceToPin continues to behave as meters in this corpus.

No GSPro input is sent. No API calls are made. No source is promoted.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2

import posttee_geometry_v2

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "regression" / "step11_20260911_farmlinks.json"
DEFAULT_OUTPUT = HERE / "output"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def minimap_change(initial, candidate) -> tuple[float, float]:
    if initial is None or candidate is None:
        raise RuntimeError("missing minimap image")
    if initial.shape != candidate.shape:
        return 1.0, 999.0
    diff = cv2.absdiff(initial, candidate)
    max_diff = diff.max(axis=2)
    mean_diff = diff.mean(axis=2)
    changed_ratio = float(((max_diff >= 10) & (mean_diff >= 3)).mean())
    return changed_ratio, float(diff.mean())


def approx_equal(a: float, b: float, tolerance: float = 0.75) -> bool:
    return abs(float(a) - float(b)) <= float(tolerance)


def fail(rows: list[dict[str, Any]], case: str, detail: str) -> None:
    rows.append({"case": case, "status": "FAIL", "detail": detail})


def passed(rows: list[dict[str, Any]], case: str, detail: str) -> None:
    rows.append({"case": case, "status": "PASS", "detail": detail})


def validate_tee(root: Path, case: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    name = str(case["capture"])
    folder = root / name
    label = f"TEE {name}"
    if not folder.is_dir():
        fail(rows, label, f"capture folder missing: {folder}")
        return
    try:
        model = read_json(folder / "hole_model.json")
        context = read_json(folder / "capture_context.json")
        manifest = read_json(folder / "hazard_field_shadow_v0.json")
    except Exception as exc:
        fail(rows, label, f"required JSON missing/unreadable: {exc}")
        return

    base = bool((model.get("base_geometry") or {}).get("available"))
    expected_base = bool(case.get("expect_base_geometry"))
    if base != expected_base:
        fail(rows, label, f"base_geometry={base}, expected={expected_base}")
        return

    expected_context = case.get("expect_capture_context_succeeded")
    if expected_context is not None and bool(context.get("capture_succeeded")) != bool(expected_context):
        fail(rows, label, f"capture_context.succeeded={context.get('capture_succeeded')}, expected={expected_context}")
        return

    expected_pin = case.get("expect_pin_yds")
    if expected_pin is not None:
        actual_pin = (model.get("base_geometry") or {}).get("pin_distance_yds")
        if actual_pin is None or not approx_equal(actual_pin, expected_pin):
            fail(rows, label, f"tee pin={actual_pin}, expected~={expected_pin}")
            return

    luna = (manifest.get("source_status") or {}).get("openai_vlm") or {}
    status = luna.get("status")
    allowed_status = case.get("expect_luna_status_any")
    if allowed_status is not None:
        if status not in allowed_status:
            fail(rows, label, f"Luna status={status!r}, expected one of {allowed_status}")
            return
    elif case.get("expect_luna_status") is not None and status != case["expect_luna_status"]:
        fail(rows, label, f"Luna status={status!r}, expected={case['expect_luna_status']!r}")
        return

    expected_counts = case.get("expect_luna_counts")
    if expected_counts is not None:
        counts = luna.get("hazard_counts") or {}
        for key, expected in expected_counts.items():
            if int(counts.get(key, -1)) != int(expected):
                fail(rows, label, f"Luna {key}={counts.get(key)}, expected={expected}")
                return

    y = case.get("y_evidence")
    y_detail = ""
    if y:
        initial = cv2.imread(str(folder / "tee_initial_minimap.png"), cv2.IMREAD_COLOR)
        toggled = cv2.imread(str(folder / "tee_toggled_minimap.png"), cv2.IMREAD_COLOR)
        restored = cv2.imread(str(folder / "tee_restored_minimap.png"), cv2.IMREAD_COLOR)
        try:
            toggle_ratio, toggle_mean = minimap_change(initial, toggled)
            restore_ratio, restore_mean = minimap_change(initial, restored)
        except Exception as exc:
            fail(rows, label, f"Y evidence unreadable: {exc}")
            return
        if toggle_ratio > float(y["initial_to_toggled_max_changed_ratio"]):
            fail(rows, label, f"initial->toggled changed_ratio={toggle_ratio:.4%} exceeds field signature")
            return
        if restore_ratio < float(y["initial_to_restored_min_changed_ratio"]):
            fail(rows, label, f"initial->restored changed_ratio={restore_ratio:.4%} below field signature")
            return
        y_detail = f" | Y unchanged={toggle_ratio:.4%}, recovered-opposite={restore_ratio:.4%}"

    passed(rows, label, f"base={base} | Luna={status}{y_detail}")


def validate_approach(root: Path, case: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    name = str(case["capture"])
    folder = root / name
    tee = root / str(case["tee_capture"])
    label = f"APPROACH {name}"
    if not folder.is_dir() or not tee.is_dir():
        fail(rows, label, f"capture/tee folder missing under {root}")
        return
    image = cv2.imread(str(folder / "approach_minimap.png"), cv2.IMREAD_COLOR)
    if image is None:
        fail(rows, label, "approach_minimap.png unreadable")
        return

    screen_pin = float(case["screen_pin_yds"])
    structured_m = float(case["structured_pin_m"])
    structured_yds = float(case["structured_pin_yds"])
    converted = structured_m * 1.0936132983377078
    if abs(converted - structured_yds) > 0.02:
        fail(rows, label, f"meters->yards regression mismatch: {converted:.4f} vs {structured_yds:.4f}")
        return
    if abs(screen_pin - structured_yds) > 1.0:
        fail(rows, label, f"screen PIN {screen_pin:.2f} vs structured {structured_yds:.2f} yd")
        return

    try:
        result = posttee_geometry_v2.analyze(
            current_minimap=image,
            pin_distance_yds=screen_pin,
            hole_model_path=tee / "hole_model.json",
        )
    except Exception as exc:
        fail(rows, label, f"registration replay raised: {exc}")
        return

    if bool(result.get("geometry_trusted")) != bool(case.get("expect_geometry_trusted")):
        fail(rows, label, f"geometry_trusted={result.get('geometry_trusted')}, expected={case.get('expect_geometry_trusted')}")
        return

    registration = result.get("registration") or {}
    mode = registration.get("acceptance_mode")
    if case.get("expect_registration_mode") and mode != case["expect_registration_mode"]:
        fail(rows, label, f"mode={mode!r}, expected={case['expect_registration_mode']!r}")
        return
    allowed_modes = case.get("expect_registration_mode_any")
    if allowed_modes and mode not in allowed_modes:
        fail(rows, label, f"mode={mode!r}, expected one of {allowed_modes}")
        return

    rotation = float(registration.get("rotation_deg"))
    if case.get("expect_rotation_abs_max_deg") is not None and abs(rotation) > float(case["expect_rotation_abs_max_deg"]):
        fail(rows, label, f"rotation={rotation:.2f} exceeds expected ordinary-rotation range")
        return
    if case.get("expect_rotation_deg_range"):
        low, high = [float(x) for x in case["expect_rotation_deg_range"]]
        if not (low <= abs(rotation) <= high):
            fail(rows, label, f"rotation={rotation:.2f}, expected abs in [{low},{high}]")
            return

    cross = result.get("pin_distance_crosscheck") or {}
    error = float(cross.get("error_yds"))
    if abs(error) > float(case.get("expect_pin_error_abs_max_yds", 8.0)):
        fail(rows, label, f"PIN crosscheck error={error:.2f} yd")
        return

    passed(
        rows,
        label,
        f"TRUSTED mode={mode} rotation={rotation:.2f}deg pin_error={error:.2f}yd "
        f"matches={registration.get('good_matches')} inliers={registration.get('inliers')} reproj={registration.get('median_reprojection_error_px')}px",
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay locked Step 11 FarmLinks field regressions")
    p.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    p.add_argument("--output-root", default=str(DEFAULT_OUTPUT))
    p.add_argument("--json-out")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    manifest = read_json(Path(args.manifest).expanduser().resolve())
    root = Path(args.output_root).expanduser().resolve()
    rows: list[dict[str, Any]] = []

    print("Looper Step 11 FIELD REGRESSION replay")
    print("Saved evidence only. GSPro actuation: NONE | API calls: NONE | Strategy authority: OFF")
    for case in manifest.get("tee_cases") or []:
        validate_tee(root, case, rows)
    for case in manifest.get("approach_cases") or []:
        validate_approach(root, case, rows)

    for row in rows:
        print(f"{row['status']:4} {row['case']} | {row['detail']}")
    passed_count = sum(row["status"] == "PASS" for row in rows)
    failed_count = sum(row["status"] == "FAIL" for row in rows)
    summary = {
        "schema_version": "looper-step11-field-regression-result-v0",
        "manifest": manifest.get("name"),
        "course_key": manifest.get("course_key"),
        "passed": passed_count,
        "failed": failed_count,
        "cases": rows,
        "strategy_authority": False,
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"STEP11 REGRESSION SUMMARY | PASS={passed_count} | FAIL={failed_count}")
    print("No GSPro input was sent. No API call was made. No strategy layer was promoted.")
    return 0 if failed_count == 0 and rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
