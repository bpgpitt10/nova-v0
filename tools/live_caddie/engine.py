from __future__ import annotations
from .assumptions import Assumptions
from .candidates import generate_candidates
from .models import ClubProfile, LiveShotState, HazardBoundary, GreenSurface, RecommendationResult
from .registry import versions
from .scoring import evaluate, is_hard_distance_miss


def _confidence(state: LiveShotState, green: GreenSurface | None, scored, assumptions: Assumptions) -> tuple[float, list[str]]:
    fallbacks: list[str] = []
    confidence = 1.0

    registration = state.registration_confidence
    if registration is not None and registration < float(assumptions.get("confidence.minimum_registration_confidence")):
        confidence *= max(0.25, registration)
        fallbacks.append("canonical minimap registration is below preferred confidence")

    error = state.pin_crosscheck_error_yds
    if error is not None:
        limit = max(
            float(assumptions.get("confidence.pin_crosscheck_absolute_yds")),
            float(assumptions.get("confidence.pin_crosscheck_relative_fraction")) * state.pin_distance_yds,
        )
        if abs(error) > limit:
            confidence *= 0.55
            fallbacks.append("canonical PIN-distance cross-check is outside tolerance")

    if state.mode == "strategic":
        has_spatial_aim = state.gspro_aim_forward_yds is not None and state.gspro_aim_right_yds is not None
        has_aim_distance = state.gspro_aim_distance_yds is not None and state.gspro_aim_distance_yds > 0
        if not (has_spatial_aim and has_aim_distance):
            confidence *= float(assumptions.get("confidence.missing_strategic_aim_multiplier"))
            fallbacks.append("GSPro strategic AIM geometry is incomplete; pin-line fallback was used")

    if state.mode == "approach" and green is None:
        confidence *= float(assumptions.get("confidence.missing_approach_green_multiplier"))
        fallbacks.append("target-green geometry is unavailable; recommendation cannot score green containment")

    if len(scored) >= 2:
        gap = scored[1].total_score - scored[0].total_score
        reference = float(assumptions.get("confidence.low_confidence_score_gap"))
        if gap < reference:
            confidence *= 0.72 + 0.28 * (gap / max(reference, 1e-6))
            fallbacks.append("top shot choices are closely ranked")

    return max(0.0, min(1.0, confidence)), fallbacks


def recommend(*, profiles: list[ClubProfile], state: LiveShotState, hazards: list[HazardBoundary],
              green: GreenSurface | None = None, assumptions: Assumptions | None = None,
              alternatives: int = 4) -> RecommendationResult:
    assumptions = assumptions or Assumptions.load()
    candidates = generate_candidates(profiles, state, assumptions)

    # Grossly wrong carry choices are not allowed to win merely because they happen
    # to avoid every visible hazard. The rejection rule is itself externalized.
    eligible = [
        candidate for candidate in candidates
        if not is_hard_distance_miss(candidate, state, assumptions)
    ]
    scored = [evaluate(candidate, state, hazards, green, assumptions) for candidate in eligible]
    scored.sort(key=lambda row: row.total_score)

    confidence, fallbacks = _confidence(state, green, scored, assumptions)
    recommended = scored[0] if scored else None
    if recommended is None:
        confidence = 0.0
        if candidates:
            fallbacks.append("all generated shots failed the configured distance-fit gate")
        else:
            fallbacks.append("no playable candidate shots were generated")

    return RecommendationResult(
        recommended=recommended,
        alternatives=scored[1:1 + alternatives],
        confidence=confidence,
        fallbacks=fallbacks,
        calculation_versions=versions(),
        assumption_version=assumptions.version,
    )
