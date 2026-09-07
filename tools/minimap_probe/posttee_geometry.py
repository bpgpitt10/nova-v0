#!/usr/bin/env python3
"""Build post-tee geometry against the cached tee HoleModel without touching GSPro."""

from __future__ import annotations

import cv2
import numpy as np

import aim_marker
import green_visibility
import hole_model_cache
import minimap_registration
import probe_v2 as v2
import probe_v4  # noqa: F401; installs robust player-marker patch used by tee v8


def _tee_relative_yards(hole_model: dict, canonical_x: float, canonical_y: float) -> tuple[float, float]:
    minimap = hole_model.get("minimap") or {}
    tee = np.array([
        float((minimap.get("ball_pixel") or {})["x"]),
        float((minimap.get("ball_pixel") or {})["y"]),
    ], dtype=float)
    pin = np.array([
        float((minimap.get("pin_pixel") or {})["x"]),
        float((minimap.get("pin_pixel") or {})["y"]),
    ], dtype=float)
    scale = float(minimap.get("yards_per_pixel") or 0.0)
    axis = pin - tee
    length = float(np.linalg.norm(axis))
    if length < 10 or scale <= 0:
        raise ValueError("HoleModel tee axis/scale missing")
    forward = axis / length
    right = np.array([-forward[1], forward[0]], dtype=float)
    delta = np.array([float(canonical_x), float(canonical_y)], dtype=float) - tee
    return float(np.dot(delta, forward) * scale), float(np.dot(delta, right) * scale)


def analyze(
    *,
    current_minimap,
    pin_distance_yds: float,
    output_root,
    aim_distance_yds: float | None = None,
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

    aim_context = None
    aim_warning = None
    if aim_distance_yds is not None:
        try:
            marker = aim_marker.detect_aim_marker(
                current_minimap,
                ball_xy=(ball.x, ball.y),
                pin_xy=(pin.x, pin.y),
                pin_distance_yds=float(pin_distance_yds),
                aim_distance_yds=float(aim_distance_yds),
            )
            canonical_aim_x, canonical_aim_y = minimap_registration.transform_point(
                registration.matrix_2x3,
                marker.x,
                marker.y,
            )
            aim_forward_tee, aim_right_tee = _tee_relative_yards(
                hole_model,
                canonical_aim_x,
                canonical_aim_y,
            )
            current_forward = float(canonical_position["tee_relative_forward_yds"])
            current_right = float(canonical_position["tee_relative_lateral_yds"])
            aim_context = {
                "marker": marker.to_dict(),
                "canonical_pixel": {"x": canonical_aim_x, "y": canonical_aim_y},
                "tee_relative_forward_yds": aim_forward_tee,
                "tee_relative_right_yds": aim_right_tee,
                "forward_yds": aim_forward_tee - current_forward,
                "right_yds": aim_right_tee - current_right,
            }
        except Exception as exc:
            aim_warning = str(exc)

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
        "aim_context": aim_context,
        "aim_context_warning": aim_warning,
        "green_visibility": visibility.to_dict(),
        "w_recovery_recommended": not visibility.visible,
        "note": (
            "Geometry analysis only. This module never presses W; W actuation remains a "
            "separate bounded UI step."
        ),
    }
