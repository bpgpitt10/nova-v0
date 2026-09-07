from __future__ import annotations
import math
from .assumptions import Assumptions
from .geometry import point_polyline_distance, gaussian_pattern_samples, point_in_polygon
from .models import CandidateShot, HazardBoundary, GreenSurface

def _nearest_boundary_distance(point, hazards: list[HazardBoundary]) -> float | None:
    minimum: float | None = None
    for hazard in hazards:
        distance = point_polyline_distance(point, hazard.points)
        if distance is not None:
            minimum = distance if minimum is None else min(minimum, distance)
    return minimum

def boundary_risk(candidate: CandidateShot, hazards: list[HazardBoundary], assumptions: Assumptions) -> tuple[float, float | None]:
    """Return weighted dispersion proximity to red penalty boundaries.

    This remains a boundary-risk index, not probability of entering a penalty area.
    The important change from v0 is that the whole oriented shot pattern is sampled;
    a safe center with a wide tail near a red line now scores differently from a
    tight pattern whose center is the same distance away.
    """
    if not hazards:
        return 0.0, None

    center_clearance = _nearest_boundary_distance(candidate.landing, hazards)
    if center_clearance is None:
        return 0.0, None

    sigma = math.hypot(candidate.carry_sigma_yds, candidate.lateral_sigma_yds)
    denom = max(1e-6, sigma * float(assumptions.get("hazard_boundary.buffer_sigma")))
    extent = float(assumptions.get("hazard_boundary.sample_sigma_extent"))
    samples = gaussian_pattern_samples(
        candidate.landing,
        candidate.carry_sigma_yds,
        candidate.lateral_sigma_yds,
        extent,
        shot_unit=candidate.shot_unit,
        cross_unit=candidate.cross_unit,
    )

    weighted_risk = 0.0
    weight_seen = 0.0
    for point, weight in samples:
        distance = _nearest_boundary_distance(point, hazards)
        if distance is None:
            continue
        normalized = distance / denom
        proximity = math.exp(-0.5 * normalized * normalized)
        weighted_risk += float(weight) * proximity
        weight_seen += float(weight)

    if weight_seen <= 1e-9:
        return 0.0, center_clearance
    risk = weighted_risk / weight_seen
    return max(0.0, min(1.0, risk)), center_clearance

def green_containment(candidate: CandidateShot, green: GreenSurface | None, assumptions: Assumptions) -> float | None:
    if green is None or len(green.polygon) < 3:
        return None
    extent = float(assumptions.get("green.sample_sigma_extent"))
    samples = gaussian_pattern_samples(
        candidate.landing,
        candidate.carry_sigma_yds,
        candidate.lateral_sigma_yds,
        extent,
        shot_unit=candidate.shot_unit,
        cross_unit=candidate.cross_unit,
    )
    return sum(weight for point, weight in samples if point_in_polygon(point, green.polygon))
