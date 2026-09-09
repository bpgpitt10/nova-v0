#!/usr/bin/env python3
"""Build post-tee geometry against a tee HoleModel without touching GSPro."""
from __future__ import annotations

from pathlib import Path

import cv2

import green_visibility
import hole_model_cache
import minimap_registration
import probe_v2 as v2
import probe_v4  # noqa: F401; installs robust player-marker patch used by tee v8


def analyze(
    *,
    current_minimap,
    pin_distance_yds: float,
    output_root,
    hole_model_path: str | Path | None = None,
) -> dict:
    """Analyze current minimap against an explicit tee model when supplied.

    `hole_model_path` is required by unattended watcher callers. The latest-by-time
    fallback exists only for manual diagnostic flows that do not know hole identity.
    """
    if hole_model_path:
        hole_model, resolved_model_path, canonical_path = hole_model_cache.load_hole_model(
            hole_model_path
        )
        model_resolution = "explicit"
    else:
        hole_model, resolved_model_path, canonical_path = hole_model_cache.find_latest_hole_model(
            output_root
        )
        model_resolution = "legacy-latest"

    canonical = cv2.imread(str(canonical_path), cv2.IMREAD_COLOR)
    if canonical is None:
        raise RuntimeError(f"Could not read cached canonical minimap {canonical_path}")

    ball = v2.detect_ball_marker(current_minimap)
    pin = v2.detect_pin_marker(current_minimap)

    registration = minimap_registration.register_current_to_canonical(
        current_minimap,
        canonical,
    )
    canonical_position = minimap_registration.canonical_position_from_hole_model(
        hole_model=hole_model,
        current_ball_xy=(ball.x, ball.y),
        registration=registration,
    )

    visibility = green_visibility.evaluate_visibility(
        hole_model=hole_model,
        minimap_width=current_minimap.shape[1],
        minimap_height=current_minimap.shape[0],
        ball_x=ball.x,
        ball_y=ball.y,
        pin_x=pin.x,
        pin_y=pin.y,
        pin_distance_yds=float(pin_distance_yds),
    )

    canonical_remaining = float(canonical_position["canonical_remaining_pin_yds"])
    pin_crosscheck_error = canonical_remaining - float(pin_distance_yds)
    tolerance = max(8.0, float(pin_distance_yds) * 0.05)
    crosscheck_ok = abs(pin_crosscheck_error) <= tolerance

    result = {
        "hole_model_path": str(resolved_model_path),
        "hole_model_resolution": model_resolution,
        "canonical_minimap_path": str(canonical_path),
        "current_markers": {
            "ball_pixel": {"x": ball.x, "y": ball.y},
            "pin_pixel": {"x": pin.x, "y": pin.y},
        },
        "registration": registration.to_dict(),
        "canonical_position": canonical_position,
        "pin_distance_crosscheck": {
            "screen_pin_distance_yds": float(pin_distance_yds),
            "canonical_remaining_pin_yds": canonical_remaining,
            "error_yds": pin_crosscheck_error,
            "tolerance_yds": tolerance,
            "ok": crosscheck_ok,
        },
        "green_visibility": visibility.to_dict(),
        "w_recovery_recommended": bool(crosscheck_ok and not visibility.visible),
        "geometry_trusted": bool(crosscheck_ok),
        "note": (
            "Geometry analysis only. This module never presses W. Canonical geometry "
            "must not feed the caddie when geometry_trusted is false."
        ),
    }

    # Hard semantic gate: keep the diagnostic registration, but make it explicit
    # that downstream strategy must not consume the canonical result when the
    # screen PIN distance disagrees with the transformed canonical geometry.
    if not crosscheck_ok:
        result["geometry_rejection_reason"] = (
            "canonical PIN-distance cross-check failed; registration retained for "
            "diagnostics only"
        )
    return result
