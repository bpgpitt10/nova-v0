#!/usr/bin/env python3
"""Resolve GSPro minimap yards-per-pixel without assuming ball->pin is hole yardage.

Background
----------
GSPro tee minimaps keep ball->pin separation nearly fixed in pixels even when
screen-reported hole yardage follows a routed/dogleg path.  That makes
``hole_yards / ball_to_pin_pixels`` biased on some non-straight holes.

The minimap itself exposes a better local ruler: gray GSPro waypoint markers
with numeric yardage labels.  Their label is measured from the current ball,
and the marker lives in the same rendered minimap coordinate system as a click.

Policy
------
1. Prefer one or more labeled gray waypoint observations.
2. When multiple useful waypoints exist, require their implied scales to agree.
3. For par 3 tee shots, ball->pin is an acceptable fallback because there is no
   dogleg routing problem to solve.
4. For non-par-3 states with no trusted waypoint, fail closed rather than silently
   treating routed hole yardage as a straight-line ruler.

This module is intentionally pure math.  Marker detection / label OCR is a
separate concern so scale policy can be tested deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import statistics
from typing import Iterable


MIN_SCALE_YPP = 0.03
MAX_SCALE_YPP = 3.0
MIN_WAYPOINT_YARDS = 75.0
MAX_WAYPOINT_SPREAD_PCT = 2.5


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class WaypointObservation:
    yards: float
    pixel: Point
    confidence: float = 1.0


@dataclass(frozen=True)
class ScaleResolution:
    yards_per_pixel: float
    source: str
    waypoint_count: int
    waypoint_spread_pct: float | None
    diagnostic_pin_yards_per_pixel: float | None
    diagnostic_pin_delta_pct: float | None


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def _plausible_scale(value: float) -> bool:
    return math.isfinite(value) and MIN_SCALE_YPP <= value <= MAX_SCALE_YPP


def _pin_scale(ball: Point, pin: Point, pin_distance_yds: float | None) -> float | None:
    if pin_distance_yds is None or pin_distance_yds <= 0:
        return None
    pixels = _distance(ball, pin)
    if pixels < 20:
        return None
    value = float(pin_distance_yds) / pixels
    return value if _plausible_scale(value) else None


def scale_from_waypoints(
    ball: Point,
    observations: Iterable[WaypointObservation],
    *,
    min_waypoint_yards: float = MIN_WAYPOINT_YARDS,
    max_spread_pct: float = MAX_WAYPOINT_SPREAD_PCT,
) -> tuple[float, int, float | None]:
    """Return a robust local scale from labeled GSPro gray waypoints.

    Short labels are deliberately ignored by default.  At 20-30 yd, a one or
    two-pixel center estimate materially changes the inferred scale; farther
    waypoints are much more stable rulers.
    """

    scales: list[float] = []
    for observation in observations:
        if observation.confidence <= 0 or observation.yards < min_waypoint_yards:
            continue
        pixels = _distance(ball, observation.pixel)
        if pixels < 20:
            continue
        scale = float(observation.yards) / pixels
        if _plausible_scale(scale):
            scales.append(scale)

    if not scales:
        raise RuntimeError("No trusted long-enough gray waypoint is available for minimap scale.")

    resolved = float(statistics.median(scales))
    spread_pct = None
    if len(scales) >= 2:
        spread_pct = (max(scales) - min(scales)) / resolved * 100.0
        if spread_pct > max_spread_pct:
            raise RuntimeError(
                "Gray waypoint scales disagree: "
                f"{spread_pct:.2f}% spread exceeds {max_spread_pct:.2f}% tolerance."
            )

    return resolved, len(scales), spread_pct


def resolve_minimap_scale(
    *,
    ball: Point,
    pin: Point,
    pin_distance_yds: float | None,
    par: int | None,
    waypoints: Iterable[WaypointObservation] = (),
) -> ScaleResolution:
    """Resolve authoritative scale plus a non-authoritative pin diagnostic."""

    pin_ypp = _pin_scale(ball, pin, pin_distance_yds)

    try:
        waypoint_ypp, count, spread_pct = scale_from_waypoints(ball, waypoints)
    except RuntimeError:
        waypoint_ypp = None
        count = 0
        spread_pct = None

    if waypoint_ypp is not None:
        delta_pct = None
        if pin_ypp is not None:
            delta_pct = (pin_ypp / waypoint_ypp - 1.0) * 100.0
        return ScaleResolution(
            yards_per_pixel=waypoint_ypp,
            source="gray-waypoint",
            waypoint_count=count,
            waypoint_spread_pct=spread_pct,
            diagnostic_pin_yards_per_pixel=pin_ypp,
            diagnostic_pin_delta_pct=delta_pct,
        )

    if par == 3 and pin_ypp is not None:
        return ScaleResolution(
            yards_per_pixel=pin_ypp,
            source="ball-pin-par3",
            waypoint_count=0,
            waypoint_spread_pct=None,
            diagnostic_pin_yards_per_pixel=pin_ypp,
            diagnostic_pin_delta_pct=0.0,
        )

    raise RuntimeError(
        "No authoritative minimap scale: non-par-3 states require a trusted labeled gray waypoint."
    )
