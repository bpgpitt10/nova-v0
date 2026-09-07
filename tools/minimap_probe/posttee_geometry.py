#!/usr/bin/env python3
"""Build post-tee geometry against the correct cached tee HoleModel.

The white minimap pin is useful confirmation, but it is no longer required after the
tee.  Course/hole screen identity selects the cached HoleModel; feature registration
places the current ball into it; the cached canonical pin is then projected back into
the current minimap even when GSPro has cropped the real pin completely offscreen.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np

import aim_marker
import green_visibility
import hole_model_cache
import minimap_registration
import probe_v2 as v2
import probe_v4  # noqa: F401; installs robust player-marker patch used by tee v8


def _config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    return json.loads(path.read_text(encoding="utf-8"))


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


def _inverse_transform_point(matrix_2x3, canonical_x: float, canonical_y: float) -> tuple[float, float]:
    matrix = np.asarray(matrix_2x3, dtype=np.float64).reshape(2, 3)
    inverse = cv2.invertAffineTransform(matrix)
    point = inverse @ np.array([float(canonical_x), float(canonical_y), 1.0], dtype=np.float64)
    return float(point[0]), float(point[1])


def _project_cached_pin(hole_model: dict, registration) -> tuple[float, float]:
    pin = (hole_model.get("minimap") or {}).get("pin_pixel") or {}
    return _inverse_transform_point(
        registration.matrix_2x3,
        float(pin["x"]),
        float(pin["y"]),
    )


def analyze(
    *,
    current_minimap,
    pin_distance_yds: float,
    output_root,
    aim_distance_yds: float | None = None,
    round_identity: dict | object | None = None,
) -> dict:
    config = _config()
    selection = hole_model_cache.find_hole_model(output_root, identity=round_identity)
    hole_model = selection.model
    hole_model_path = selection.model_path
    canonical_path = selection.canonical_path
    canonical = cv2.imread(str(canonical_path), cv2.IMREAD_COLOR)
    if canonical is None:
        raise RuntimeError(f"Could not read cached canonical minimap {canonical_path}")

    ball = v2.detect_ball_marker(current_minimap)

    registration = minimap_registration.register_current_to_canonical(
        current_minimap,
        canonical,
        detector_config=config["screen_detection"]["registration"],
    )
    canonical_position = minimap_registration.canonical_position_from_hole_model(
        hole_model=hole_model,
        current_ball_xy=(ball.x, ball.y),
        registration=registration,
    )

    # Registration itself supplies the current minimap scale.  This removes the
    # previous dependency on a visible white minimap pin.
    canonical_yd_per_px = float((hole_model.get("minimap") or {}).get("yards_per_pixel") or 0.0)
    current_yd_per_px = canonical_yd_per_px * float(registration.scale)
    if current_yd_per_px <= 0:
        raise RuntimeError("Could not derive current minimap scale from registration")

    projected_pin_x, projected_pin_y = _project_cached_pin(hole_model, registration)
    visible_pin = None
    visible_pin_error = None
    try:
        visible_pin = v2.detect_pin_marker(current_minimap)
        visible_pin_error = math.dist(
            (visible_pin.x, visible_pin.y),
            (projected_pin_x, projected_pin_y),
        )
    except Exception:
        visible_pin = None

    projection_tolerance = float(config["screen_detection"]["green_visibility"]["pin_projection_check_tolerance_px"])
    pin_marker_verified = visible_pin is not None and visible_pin_error is not None and visible_pin_error <= projection_tolerance
    # Canonical projection is authoritative for geometry.  A visible marker is a
    # diagnostic/check only, because the projection also works when the pin is offscreen.
    pin_x, pin_y = projected_pin_x, projected_pin_y

    visibility = green_visibility.evaluate_visibility(
        hole_model=hole_model,
        minimap_width=current_minimap.shape[1],
        minimap_height=current_minimap.shape[0],
        ball_x=ball.x,
        ball_y=ball.y,
        pin_x=pin_x,
        pin_y=pin_y,
        pin_distance_yds=float(pin_distance_yds),
        current_yards_per_pixel=current_yd_per_px,
        detector_config=config["screen_detection"]["green_visibility"],
    )

    canonical_remaining = float(canonical_position["canonical_remaining_pin_yds"])
    pin_crosscheck_error = canonical_remaining - float(pin_distance_yds)
    confidence_cfg = config["confidence"]
    crosscheck_limit = max(
        float(confidence_cfg["pin_crosscheck_absolute_yds"]),
        float(pin_distance_yds) * float(confidence_cfg["pin_crosscheck_relative_fraction"]),
    )
    crosscheck_ok = abs(pin_crosscheck_error) <= crosscheck_limit

    aim_context = None
    aim_warning = None
    if aim_distance_yds is not None:
        try:
            marker = aim_marker.detect_aim_marker(
                current_minimap,
                ball_xy=(ball.x, ball.y),
                pin_xy=(pin_x, pin_y),
                aim_distance_yds=float(aim_distance_yds),
                yards_per_pixel=current_yd_per_px,
                detector_config=config["screen_detection"]["aim_marker"],
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

    visible_pin_payload = None
    if visible_pin is not None:
        visible_pin_payload = {"x": visible_pin.x, "y": visible_pin.y}

    return {
        "hole_model_path": str(hole_model_path),
        "canonical_minimap_path": str(canonical_path),
        "hole_model_selection": selection.meta(),
        "current_markers": {
            "ball_pixel": {"x": ball.x, "y": ball.y},
            "pin_pixel": {"x": pin_x, "y": pin_y},
            "pin_pixel_source": "cached-canonical-projection",
            "visible_pin_pixel": visible_pin_payload,
            "pin_marker_visible": visible_pin is not None,
            "pin_marker_verified_against_projection": pin_marker_verified,
            "pin_projection_error_px": visible_pin_error,
            "pin_projection_tolerance_px": projection_tolerance,
        },
        "registration": registration.to_dict(),
        "current_yards_per_pixel": current_yd_per_px,
        "canonical_position": canonical_position,
        "pin_distance_crosscheck": {
            "screen_pin_distance_yds": float(pin_distance_yds),
            "canonical_remaining_pin_yds": canonical_remaining,
            "error_yds": pin_crosscheck_error,
            "limit_yds": crosscheck_limit,
            "ok": crosscheck_ok,
        },
        "aim_context": aim_context,
        "aim_context_warning": aim_warning,
        "green_visibility": visibility.to_dict(),
        "w_recovery_recommended": not visibility.visible,
        "assumption_version": config.get("assumptions_version"),
        "note": (
            "Post-tee geometry does not require a visible minimap pin. Course/hole identity selects "
            "the tee HoleModel; registration projects its cached pin/green into the current viewport."
        ),
    }
