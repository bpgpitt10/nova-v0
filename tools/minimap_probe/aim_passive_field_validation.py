#!/usr/bin/env python3
"""Validate passive minimap AIM sensing against AIM cards captured in Step 11.

The expensive LEFT/RIGHT AIM-card acquisition gives us ground truth after the fact.
This script asks whether the *original, untouched* minimap already contained enough
information to recover that aim distance before any actuation.

Expected field signature from 2026-09-11 FarmLinks:
- separate gray AIM marker visible: H2 tee, H3 tee, H4 tee, H3 post-tee at 65 yd;
- marker occluded/not separately visible: H2 post-tee at 107 yd and H3 at 21 yd,
  where the acquired AIM card was essentially at the pin.

No GSPro input and no OCR/API work occurs here.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2

import minimap_aim

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE / "output"
CASES = [
    ("tee_capture_20260911_210855_776326", "tee_initial_minimap.png", True),
    ("tee_capture_20260911_211018_339043", "tee_initial_minimap.png", True),
    ("tee_capture_20260911_211252_751665", "tee_initial_minimap.png", True),
    ("approach_capture_20260911_210938_997538", "approach_minimap.png", False),
    ("approach_capture_20260911_211118_485845", "approach_minimap.png", True),
    ("approach_capture_20260911_211149_959082", "approach_minimap.png", False),
]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def state_pin_aim(state: dict[str, Any]) -> tuple[float, float]:
    if state.get("capture_mode") == "post-tee" or str(state.get("schema_version", "")).startswith("post-tee"):
        pin = (state.get("pin") or {}).get("distance_yds")
    else:
        pin = (state.get("pin") or {}).get("distance_yds")
    aim = (state.get("aim") or {}).get("distance_yds")
    if pin is None or aim is None:
        raise RuntimeError("saved ShotState lacks PIN/AIM card ground truth")
    return float(pin), float(aim)


def validate_case(root: Path, capture_name: str, image_name: str, expect_visible: bool, tolerance_yds: float) -> dict[str, Any]:
    folder = root / capture_name
    state = read_json(folder / "shot_state.json")
    image = cv2.imread(str(folder / image_name), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"{image_name} unreadable")
    pin_yds, card_aim_yds = state_pin_aim(state)
    passive, meta = minimap_aim.read_passive_aim(image, pin_distance_yds=pin_yds)
    visible = passive is not None
    error = float(passive.distance_yds - card_aim_yds) if passive is not None else None
    status_ok = visible == bool(expect_visible)
    distance_ok = bool(passive is None or abs(error) <= tolerance_yds)
    return {
        "capture": capture_name,
        "image": image_name,
        "pin_yds": pin_yds,
        "aim_card_ground_truth_yds": card_aim_yds,
        "expected_marker_visible": bool(expect_visible),
        "passive_marker_visible": visible,
        "passive_aim_yds": float(passive.distance_yds) if passive is not None else None,
        "passive_minus_card_yds": error,
        "passive_meta": meta,
        "status_ok": status_ok,
        "distance_ok": distance_ok,
        "passed": bool(status_ok and distance_ok),
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay passive minimap AIM sensor against saved Step 11 field truth")
    p.add_argument("--output-root", default=str(DEFAULT_ROOT))
    p.add_argument("--tolerance-yds", type=float, default=3.0)
    p.add_argument("--output")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    rows = []
    errors = []
    for capture, image, expected in CASES:
        try:
            row = validate_case(root, capture, image, expected, args.tolerance_yds)
            rows.append(row)
            status = "PASS" if row["passed"] else "FAIL"
            if row["passive_marker_visible"]:
                detail = f"passive={row['passive_aim_yds']:.2f} vs card={row['aim_card_ground_truth_yds']:.2f} yd error={row['passive_minus_card_yds']:.2f}"
            else:
                detail = f"marker not visible; card={row['aim_card_ground_truth_yds']:.2f}, pin={row['pin_yds']:.2f} yd"
            print(f"{status} {capture} | {detail}")
        except Exception as exc:
            errors.append({"capture": capture, "error": f"{type(exc).__name__}: {exc}"})
            print(f"FAIL {capture} | {type(exc).__name__}: {exc}")

    visible_rows = [row for row in rows if row["passive_marker_visible"]]
    max_error = max((abs(float(row["passive_minus_card_yds"])) for row in visible_rows), default=None)
    payload = {
        "schema_version": "looper-passive-minimap-aim-field-validation-v0",
        "cases": rows,
        "errors": errors,
        "passed": sum(row["passed"] for row in rows),
        "failed": sum(not row["passed"] for row in rows) + len(errors),
        "visible_marker_cases": len(visible_rows),
        "total_cases": len(rows) + len(errors),
        "max_visible_distance_error_yds": max_error,
        "actuation_avoided_on_visible_cases": len(visible_rows),
        "strategy_authority": False,
    }
    output = Path(args.output).expanduser().resolve() if args.output else root / "passive_aim_field_validation_20260911.json"
    output.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    print(
        f"PASSIVE AIM SUMMARY | pass={payload['passed']} fail={payload['failed']} | "
        f"visible={payload['visible_marker_cases']}/{payload['total_cases']} | max_error={max_error} yd"
    )
    print(f"Output: {output}")
    print("No GSPro input was sent. No AIM card was opened. Strategy authority remains OFF.")
    return 0 if payload["failed"] == 0 and rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
