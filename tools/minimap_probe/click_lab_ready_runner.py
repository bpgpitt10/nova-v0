#!/usr/bin/env python3
"""Final hardened Click Lab runner for short live-validation sessions.

Adds one convenience/safety layer on top of click_lab_runner:
- explicit --distance remains authoritative;
- otherwise prefer a fresh GSPro currentRound.dat DistanceToPin;
- otherwise fall back to the existing PIN-card OCR path.

This avoids requiring a manual distance entry in the normal case without ever
silently trusting stale round state.
"""

from __future__ import annotations

import time
from pathlib import Path

import click_lab
import click_lab_runner  # noqa: F401 - imports the marker/click hardening patches
import probe as base

MAX_CURRENT_ROUND_AGE_SECONDS = 10 * 60

_original_read_pin_distance = click_lab.read_pin_distance


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


click_lab.read_pin_distance = _read_pin_distance_ready


if __name__ == "__main__":
    raise SystemExit(click_lab.main())
