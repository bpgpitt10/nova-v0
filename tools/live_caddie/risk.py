from __future__ import annotations
import math
from .assumptions import Assumptions
from .geometry import point_polyline_distance, gaussian_pattern_samples, point_in_polygon
from .models import CandidateShot, HazardBoundary, GreenSurface

def boundary_risk(candidate: CandidateShot, hazards: list[HazardBoundary], assumptions: Assumptions) -> tuple[float, float | None]:
    if not hazards:
        return 0.0, None
    # Boundary-proximity index only; do not present this as probability of entering penalty.
    sigma = math.hypot(candidate.carry_sigma_yds, candidate.lateral_sigma_yds)
    denom = max(1e-6, sigma * float(assumptions.get("hazard_boundary.buffer_sigma")))
    minimum: float | None = None
    for hazard in hazards:
        distance = point_polyline_distance(candidate.landing, hazard.points)
        if distance is not None:
            minimum = distance if minimum is None else min(minimum, distance)
    if minimum is None:
        return 0.0, None
    normalized = minimum / denom
    risk = math.exp(-0.5 * normalized * normalized)
    return max(0.0, min(1.0, risk)), minimum

def green_containment(candidate: CandidateShot, green: GreenSurface | None, assumptions: Assumptions) -> float | None:
    if green is None or len(green.polygon) < 3:
        return None
    extent = float(assumptions.get("green.sample_sigma_extent"))
    samples = gaussian_pattern_samples(
        candidate.landing,
        candidate.carry_sigma_yds,
        candidate.lateral_sigma_yds,
        extent,
    )
    return sum(weight for point, weight in samples if point_in_polygon(point, green.polygon))
