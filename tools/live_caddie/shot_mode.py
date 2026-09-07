from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any

from .assumptions import Assumptions


@dataclass(frozen=True)
class ShotModeInputs:
    surface_label: str | None
    pin_distance_yds: float | None
    aim_distance_yds: float | None
    aim_forward_tee_yds: float | None = None
    aim_right_tee_yds: float | None = None
    canonical_green_polygon: tuple[tuple[float, float], ...] | None = None
    green_context_available: bool = False


@dataclass(frozen=True)
class ShotModeDecision:
    mode: str
    confidence: float
    reason: str
    aim_inside_green: bool | None
    aim_pin_distance_difference_yds: float | None
    distance_tolerance_yds: float | None
    full_shot_allowed: bool
    assumption_version: str

    def to_dict(self) -> dict:
        return asdict(self)


def _normalize_surface(value: str | None) -> str:
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def _point_in_polygon(x: float, y: float, polygon: tuple[tuple[float, float], ...]) -> bool:
    """Ray-cast point containment with no dependency on CV/UI code."""
    if len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = float(polygon[i][0]), float(polygon[i][1])
        xj, yj = float(polygon[j][0]), float(polygon[j][1])
        crosses = ((yi > y) != (yj > y))
        if crosses:
            denominator = yj - yi
            if abs(denominator) > 1e-12:
                x_at_y = (xj - xi) * (y - yi) / denominator + xi
                if x < x_at_y:
                    inside = not inside
        j = i
    return inside


def _aim_inside_green(inputs: ShotModeInputs) -> bool | None:
    if (
        inputs.aim_forward_tee_yds is None
        or inputs.aim_right_tee_yds is None
        or not inputs.canonical_green_polygon
        or len(inputs.canonical_green_polygon) < 3
    ):
        return None
    return _point_in_polygon(
        float(inputs.aim_forward_tee_yds),
        float(inputs.aim_right_tee_yds),
        inputs.canonical_green_polygon,
    )


def infer_shot_mode(
    inputs: ShotModeInputs,
    assumptions: Assumptions | None = None,
) -> ShotModeDecision:
    """Classify full-shot context without embedding policy in capture orchestration.

    `approach` means the strategic target is the green/pin complex.
    `strategic` means GSPro is targeting a layup/position materially separate from pin.
    `no-full-shot` explicitly hands green states away from this full-shot workstream.
    `unknown` blocks automatic mode-dependent UI actions until more evidence exists.
    """
    assumptions = assumptions or Assumptions.load()
    cfg = assumptions.get("shot_mode")
    surface = _normalize_surface(inputs.surface_label)
    non_full = {_normalize_surface(item) for item in cfg["non_full_shot_surfaces"]}
    if surface and surface in non_full:
        return ShotModeDecision(
            mode="no-full-shot",
            confidence=float(cfg["non_full_shot_surface_confidence"]),
            reason=f"GSPro surface is {inputs.surface_label}; full-shot caddie yields to the separate putting flow",
            aim_inside_green=None,
            aim_pin_distance_difference_yds=None,
            distance_tolerance_yds=None,
            full_shot_allowed=False,
            assumption_version=assumptions.version,
        )

    inside = _aim_inside_green(inputs)
    if inside is True:
        return ShotModeDecision(
            mode="approach",
            confidence=float(cfg["aim_inside_green_confidence"]),
            reason="GSPro AIM target maps inside the canonical target green",
            aim_inside_green=True,
            aim_pin_distance_difference_yds=(
                abs(float(inputs.pin_distance_yds) - float(inputs.aim_distance_yds))
                if inputs.pin_distance_yds is not None and inputs.aim_distance_yds is not None else None
            ),
            distance_tolerance_yds=None,
            full_shot_allowed=True,
            assumption_version=assumptions.version,
        )
    if inside is False:
        # A mapped AIM target clearly outside the green is strong evidence of a
        # strategic layup/position target, especially on par 5s or recovery shots.
        return ShotModeDecision(
            mode="strategic",
            confidence=float(cfg["aim_outside_green_confidence"]),
            reason="GSPro AIM target maps outside the canonical target green",
            aim_inside_green=False,
            aim_pin_distance_difference_yds=(
                abs(float(inputs.pin_distance_yds) - float(inputs.aim_distance_yds))
                if inputs.pin_distance_yds is not None and inputs.aim_distance_yds is not None else None
            ),
            distance_tolerance_yds=None,
            full_shot_allowed=True,
            assumption_version=assumptions.version,
        )

    difference = None
    tolerance = None
    if inputs.pin_distance_yds is not None and inputs.aim_distance_yds is not None:
        pin = float(inputs.pin_distance_yds)
        aim = float(inputs.aim_distance_yds)
        difference = abs(pin - aim)
        tolerance = max(
            float(cfg["aim_pin_distance_absolute_tolerance_yds"]),
            abs(pin) * float(cfg["aim_pin_distance_relative_tolerance_fraction"]),
        )
        if difference <= tolerance:
            return ShotModeDecision(
                mode="approach",
                confidence=float(cfg["aim_pin_distance_match_confidence"]),
                reason="GSPro AIM distance is close enough to PIN distance to represent a green-targeting shot",
                aim_inside_green=None,
                aim_pin_distance_difference_yds=difference,
                distance_tolerance_yds=tolerance,
                full_shot_allowed=True,
                assumption_version=assumptions.version,
            )
        return ShotModeDecision(
            mode="strategic",
            confidence=float(cfg["aim_pin_distance_divergence_confidence"]),
            reason="GSPro AIM distance materially differs from PIN distance, indicating a strategic target",
            aim_inside_green=None,
            aim_pin_distance_difference_yds=difference,
            distance_tolerance_yds=tolerance,
            full_shot_allowed=True,
            assumption_version=assumptions.version,
        )

    if (
        inputs.pin_distance_yds is not None
        and bool(inputs.green_context_available)
        and float(inputs.pin_distance_yds) <= float(cfg["fallback_approach_max_pin_distance_yds"])
    ):
        return ShotModeDecision(
            mode="approach",
            confidence=float(cfg["fallback_approach_confidence"]),
            reason="AIM geometry is unavailable, but the target green is modeled and PIN distance is within fallback approach range",
            aim_inside_green=None,
            aim_pin_distance_difference_yds=None,
            distance_tolerance_yds=None,
            full_shot_allowed=True,
            assumption_version=assumptions.version,
        )

    return ShotModeDecision(
        mode="unknown",
        confidence=float(cfg["unknown_confidence"]),
        reason="insufficient evidence to distinguish strategic from approach targeting",
        aim_inside_green=None,
        aim_pin_distance_difference_yds=difference,
        distance_tolerance_yds=tolerance,
        full_shot_allowed=True,
        assumption_version=assumptions.version,
    )


def polygon_from_canonical_hole(canonical_hole: dict[str, Any]) -> tuple[tuple[float, float], ...] | None:
    rows = (canonical_hole.get("green_surface") or {}).get("polygon") or []
    polygon = []
    for row in rows:
        if row.get("forward") is None or row.get("right") is None:
            continue
        polygon.append((float(row["forward"]), float(row["right"])))
    return tuple(polygon) if len(polygon) >= 3 else None
