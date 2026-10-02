#!/usr/bin/env python3
"""Final hardened Click Lab runner for short live-validation sessions.

Adds convenience/safety layers on top of click_lab_runner:
- explicit --distance remains authoritative;
- otherwise prefer a fresh GSPro currentRound.dat DistanceToPin;
- otherwise fall back to the existing PIN-card OCR path;
- only direct 2D minimap-marker verification may produce a PASS after a click;
- a clicked-but-UNVERIFIED result exits nonzero so it cannot look successful.

AIM-card OCR remains useful diagnostic evidence, but radial distance alone cannot
prove that GSPro accepted the correct left/right target.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import click_lab
import click_lab_runner  # noqa: F401 - imports the marker/click hardening patches
import probe as base

MAX_CURRENT_ROUND_AGE_SECONDS = 10 * 60

_original_read_pin_distance = click_lab.read_pin_distance
_direct_marker_verify = click_lab.verify_after_click


def _read_pin_distance_ready(screen, explicit_distance, tesseract_path, debug_dir):
    # Deliberate CLI override always wins.
    if explicit_distance is not None:
        return _original_read_pin_distance(
            screen,
            explicit_distance,
            tesseract_path,
            debug_dir,
        )

    warnings: list[str] = []
    current_round = base.find_current_round()
    if current_round is not None:
        try:
            age_seconds = max(0.0, time.time() - current_round.stat().st_mtime)
            if age_seconds <= MAX_CURRENT_ROUND_AGE_SECONDS:
                distance = float(base.distance_from_current_round(current_round))
                if distance > 0:
                    print(
                        f"Distance source: currentRound.dat {distance:.1f} yd "
                        f"(age {age_seconds:.0f}s)"
                    )
                    return distance, f"currentRound.dat ({Path(current_round).name})", warnings
            else:
                warnings.append(
                    f"currentRound.dat is {age_seconds / 60.0:.1f} min old; not using it for click calibration."
                )
        except Exception as exc:
            warnings.append(f"Could not read fresh currentRound.dat distance: {exc}")

    try:
        distance, source, ocr_warnings = _original_read_pin_distance(
            screen,
            None,
            tesseract_path,
            debug_dir,
        )
        return distance, source, [*warnings, *ocr_warnings]
    except Exception as exc:
        detail = " ".join(warnings)
        suffix = f" Previous fallback notes: {detail}" if detail else ""
        raise RuntimeError(
            "Could not resolve a safe current distance-to-pin from fresh currentRound.dat or the GSPro PIN card. "
            "Use -Distance <yards> as the deliberate fallback." + suffix
        ) from exc


def _verify_after_click_ready(screen, tesseract_path, debug_dir, expected_distance_yds, tolerance_yds):
    observed, error, status, warnings = _direct_marker_verify(
        screen,
        tesseract_path,
        debug_dir,
        expected_distance_yds,
        tolerance_yds,
    )

    direct_unavailable = any(
        str(warning).startswith("Direct minimap-marker verification unavailable:")
        for warning in warnings
    )
    if direct_unavailable:
        diagnostic = (
            f" Legacy AIM-card radial observation was {observed:.1f} yd and is diagnostic only."
            if observed is not None
            else ""
        )
        return observed, error, "UNVERIFIED", [
            *warnings,
            "Direct 2D minimap-marker verification is required for PASS; OCR fallback cannot validate left/right accuracy."
            + diagnostic,
        ]

    return observed, error, status, warnings


def _run_ready() -> int:
    exit_code = int(click_lab.main())
    if exit_code != 0:
        return exit_code

    # click_lab's legacy main treats UNVERIFIED as exit 0. Tighten that contract
    # for this ready runner so PowerShell/automation cannot mistake it for PASS.
    result_path = Path(__file__).with_name("output") / "click_lab" / "latest_click_lab_result.json"
    if result_path.exists():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if bool(result.get("clicked")) and result.get("verification") == "UNVERIFIED":
                print("CLICK LAB RESULT: clicked target is UNVERIFIED; returning failure exit code 3.")
                return 3
        except Exception as exc:
            print(f"WARNING: could not inspect Click Lab result JSON for fail-closed exit handling: {exc}")
            return 3

    return exit_code


click_lab.read_pin_distance = _read_pin_distance_ready
click_lab.verify_after_click = _verify_after_click_ready


if __name__ == "__main__":
    raise SystemExit(_run_ready())
