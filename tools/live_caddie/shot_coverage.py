from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from .assumptions import Assumptions
from .environment import effective_target_distance
from .models import CandidateShot, LiveShotState

Scope = Literal["modeled-shot", "geometry-only", "none"]


@dataclass(frozen=True)
class ShotCoverageDecision:
    scope: Scope
    effective_target_distance_yds: float
    shortest_modeled_carry_yds: float | None
    lower_coverage_limit_yds: float | None
    distance_below_shortest_modeled_carry_yds: float | None
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def assess_shot_coverage(
    candidates: list[CandidateShot],
    state: LiveShotState,
    assumptions: Assumptions,
) -> ShotCoverageDecision:
    """Decide whether Looper has a modeled shot at the short end of the bag.

    This is deliberately different from the broad scoring hard-reject gate. The
    scoring gate prevents a ridiculous club from winning a normal recommendation;
    this function prevents Looper from pretending a full/smooth wedge distribution
    describes a materially shorter partial shot.

    Explicit user variants are ordinary candidates. If a real 45-yard pitch variant
    exists, it lowers the shortest modeled carry and keeps that shot inside the
    modeled engine using the variant's own statistics.
    """
    target = float(effective_target_distance(state, assumptions))
    if state.mode != "approach":
        return ShotCoverageDecision(
            scope="modeled-shot",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=min((c.planned_carry_yds for c in candidates), default=None),
            lower_coverage_limit_yds=None,
            distance_below_shortest_modeled_carry_yds=None,
            reason="short-game lower-bound coverage applies only to approach shots",
        )

    if not candidates:
        return ShotCoverageDecision(
            scope="none",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=None,
            lower_coverage_limit_yds=None,
            distance_below_shortest_modeled_carry_yds=None,
            reason="no playable modeled shot candidates are available",
        )

    shortest = min(float(candidate.planned_carry_yds) for candidate in candidates)
    absolute = float(assumptions.get("short_game.modeled_coverage_absolute_tolerance_yds"))
    relative = float(assumptions.get("short_game.modeled_coverage_relative_fraction")) * shortest
    tolerance = max(absolute, relative)
    lower_limit = max(0.0, shortest - tolerance)
    gap = max(0.0, shortest - target)

    if target >= lower_limit:
        return ShotCoverageDecision(
            scope="modeled-shot",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=shortest,
            lower_coverage_limit_yds=lower_limit,
            distance_below_shortest_modeled_carry_yds=gap,
            reason="effective target remains within the configured lower edge of modeled shot coverage",
        )

    guidance_min = float(assumptions.get("short_game.minimum_geometry_guidance_distance_yds"))
    if target >= guidance_min:
        return ShotCoverageDecision(
            scope="geometry-only",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=shortest,
            lower_coverage_limit_yds=lower_limit,
            distance_below_shortest_modeled_carry_yds=gap,
            reason=(
                "target is materially shorter than the shortest modeled Stock/Smooth/explicit variant; "
                "do not extrapolate full-shot dispersion into an unmodeled partial shot"
            ),
        )

    return ShotCoverageDecision(
        scope="none",
        effective_target_distance_yds=target,
        shortest_modeled_carry_yds=shortest,
        lower_coverage_limit_yds=lower_limit,
        distance_below_shortest_modeled_carry_yds=gap,
        reason=(
            "target is inside the configured true-greenside cutoff and no explicit modeled variant covers it"
        ),
    )
