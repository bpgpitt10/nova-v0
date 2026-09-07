from __future__ import annotations
from .assumptions import Assumptions
from .models import CandidateShot, CandidateEvaluation, LiveShotState, HazardBoundary, GreenSurface
from .risk import boundary_risk, green_containment

def effective_target_distance(state: LiveShotState, assumptions: Assumptions) -> float:
    target = float(state.pin_distance_yds) + float(state.external_carry_adjustment_yds)
    if assumptions.get("environment.use_target_elevation"):
        target += float(state.pin_elevation_delta_yds)
    return target

def evaluate(candidate: CandidateShot, state: LiveShotState, hazards: list[HazardBoundary], green: GreenSurface | None, assumptions: Assumptions) -> CandidateEvaluation:
    target = effective_target_distance(state, assumptions)
    absolute_tol = float(assumptions.get("distance_fit.absolute_tolerance_yds"))
    relative_tol = float(assumptions.get("distance_fit.relative_tolerance_fraction")) * max(target, 1.0)
    tolerance = max(absolute_tol, relative_tol)
    distance_fit = min(1.0, abs(candidate.planned_carry_yds - target) / max(tolerance, 1e-6))

    h_risk, clearance = boundary_risk(candidate, hazards, assumptions)
    containment = green_containment(candidate, green, assumptions)
    green_miss = 0.0 if containment is None else 1.0 - containment

    aim_reference = max(1.0, float(assumptions.get("scoring.aim_change_reference_yds")))
    aim_change = min(1.0, abs(candidate.aim_offset_yds) / aim_reference)

    weights = assumptions.get(f"scoring.{state.mode}")
    total = (
        float(weights["distance_fit_weight"]) * distance_fit
        + float(weights["hazard_boundary_weight"]) * h_risk
        + float(weights["green_miss_weight"]) * green_miss
        + float(weights["aim_change_weight"]) * aim_change
    )

    reasons: list[str] = []
    if clearance is not None:
        pattern_sigma = (candidate.carry_sigma_yds ** 2 + candidate.lateral_sigma_yds ** 2) ** 0.5
        if clearance <= pattern_sigma * float(assumptions.get("hazard_boundary.danger_sigma")):
            reasons.append("shot pattern is dangerously close to a penalty boundary")
        elif clearance <= pattern_sigma * float(assumptions.get("hazard_boundary.tight_sigma")):
            reasons.append("shot pattern has a tight penalty-boundary margin")
    if containment is not None:
        if containment >= float(assumptions.get("green.strong_containment_fraction")):
            reasons.append("strong modeled green containment")
        elif containment < float(assumptions.get("green.minimum_containment_fraction")):
            reasons.append("too much modeled pattern misses the target green")
    if distance_fit < 0.30:
        reasons.append("carry fits the effective target distance")
    if state.mode == "strategic" and abs(candidate.aim_offset_yds) <= 1e-6:
        reasons.append("preserves GSPro strategic aim")

    return CandidateEvaluation(
        candidate=candidate,
        total_score=total,
        distance_fit_score=distance_fit,
        hazard_boundary_risk=h_risk,
        green_containment=containment,
        aim_change_score=aim_change,
        minimum_boundary_clearance_yds=clearance,
        reasons=reasons,
    )
