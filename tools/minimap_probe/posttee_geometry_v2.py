#!/usr/bin/env python3
"""Fail-soft post-tee geometry against the exact current-hole tee HoleModel.

Canonical registration and PIN-distance validation are independent of optional green
semantics. A missing/failed green heatmap layer no longer destroys otherwise useful
canonical position geometry.

Step 11 field evidence also proved GSPro can rotate the minimap dramatically on a
late approach (the saved ~141 degree transform aligned the green/bunker and mapped
the ball to a physically plausible point beyond/left of the pin). Registration
therefore uses the normal base path first, then a strongly PIN-anchored wide-rotation
fallback when descriptor evidence is exceptionally clean.
"""
from __future__ import annotations

from pathlib import Path

import cv2

import green_visibility
import hole_model_cache
import minimap_registration_rotating as minimap_registration
import probe_v2 as v2
import probe_v4  # noqa: F401; installs robust marker detection patches


def analyze(*, current_minimap, pin_distance_yds: float, hole_model_path: str | Path) -> dict:
    model, resolved_model_path, canonical_path = hole_model_cache.load_hole_model(hole_model_path)
    canonical = cv2.imread(str(canonical_path), cv2.IMREAD_COLOR)
    if canonical is None:
        raise RuntimeError(f"Could not read canonical minimap {canonical_path}")

    base_geometry = model.get("base_geometry") or {}
    if base_geometry.get("available") is False:
        raise RuntimeError(
            f"Tee HoleModel base geometry unavailable: {base_geometry.get('warning') or 'unknown reason'}"
        )

    ball = v2.detect_ball_marker(current_minimap)
    pin = v2.detect_pin_marker(current_minimap)
    canonical_pin = (model.get("minimap") or {}).get("pin_pixel") or {}
    canonical_pin_xy = None
    try:
        canonical_pin_xy = (float(canonical_pin["x"]), float(canonical_pin["y"]))
    except Exception:
        canonical_pin_xy = None

    registration = minimap_registration.register_current_to_canonical(
        current_minimap,
        canonical,
        current_anchor_xy=(float(pin.x), float(pin.y)) if canonical_pin_xy is not None else None,
        canonical_anchor_xy=canonical_pin_xy,
    )
    canonical_position = minimap_registration.canonical_position_from_hole_model(
        hole_model=model,
        current_ball_xy=(ball.x, ball.y),
        registration=registration,
    )

    canonical_remaining = float(canonical_position["canonical_remaining_pin_yds"])
    screen_pin = float(pin_distance_yds)
    error = canonical_remaining - screen_pin
    tolerance = max(8.0, screen_pin * 0.05)
    crosscheck_ok = abs(error) <= tolerance

    green_payload = {"available": False, "visible": None, "warning": None}
    green = model.get("green_surface") or {}
    if green.get("available", True) is not False and green.get("target_green_mask"):
        try:
            visibility = green_visibility.evaluate_visibility(
                hole_model=model,
                minimap_width=current_minimap.shape[1],
                minimap_height=current_minimap.shape[0],
                ball_x=ball.x,
                ball_y=ball.y,
                pin_x=pin.x,
                pin_y=pin.y,
                pin_distance_yds=screen_pin,
            )
            green_payload = {"available": True, **visibility.to_dict()}
        except Exception as exc:
            green_payload = {"available": False, "visible": None, "warning": str(exc)}
    else:
        green_payload["warning"] = green.get("warning") or "tee green semantic layer unavailable"

    trusted = bool(crosscheck_ok)
    green_visible = green_payload.get("visible") if green_payload.get("available") else None
    return {
        "hole_model_path": str(resolved_model_path),
        "hole_model_resolution": "explicit",
        "canonical_minimap_path": str(canonical_path),
        "current_markers": {
            "ball_pixel": {"x": ball.x, "y": ball.y},
            "pin_pixel": {"x": pin.x, "y": pin.y},
        },
        "registration": registration.to_dict(),
        "canonical_position": canonical_position,
        "pin_distance_crosscheck": {
            "screen_pin_distance_yds": screen_pin,
            "canonical_remaining_pin_yds": canonical_remaining,
            "error_yds": error,
            "tolerance_yds": tolerance,
            "ok": crosscheck_ok,
        },
        "green_visibility": green_payload,
        "geometry_trusted": trusted,
        "w_recovery_recommended": bool(trusted and green_visible is False),
        "geometry_rejection_reason": None if trusted else "canonical PIN-distance cross-check failed",
        "note": "Registration uses a shared PIN anchor, including a tightly gated wide-rotation fallback for GSPro reorientation, then still requires the independent PIN-distance cross-check. W is never actuated here.",
    }
