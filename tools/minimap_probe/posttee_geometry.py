#!/usr/bin/env python3
"""Build post-tee geometry against the cached tee HoleModel without touching GSPro."""

from __future__ import annotations

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
) -> dict:
    hole_model, hole_model_path, canonical_path = hole_model_cache.find_latest_hole_model(output_root)
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
    crosscheck_ok = abs(pin_crosscheck_error) <= max(8.0, float(pin_distance_yds) * 0.05)

    return {
        "hole_model_path": str(hole_model_path),
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
            "ok": crosscheck_ok,
        },
        "green_visibility": visibility.to_dict(),
        "w_recovery_recommended": not visibility.visible,
        "note": (
            "Geometry analysis only. This module never presses W; field-tested W actuation "
            "must remain a separate bounded step."
        ),
    }
