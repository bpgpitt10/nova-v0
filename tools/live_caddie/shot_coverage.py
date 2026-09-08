from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from .assumptions import Assumptions
from .candidates import modeled_variant_carries
from .environment import effective_target_distance
from .models import ClubProfile, LiveShotState

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
    profiles: list[ClubProfile],
    state: LiveShotState,
    assumptions: Assumptions,
) -> ShotCoverageDecision:
    """Decide whether Looper has a trustworthy modeled shot at the short end.

    Coverage is calculated from the complete model-supported variant inventory before
    aim offsets are expanded or max_candidates truncation occurs. A tagged variant
    extends modeled coverage only when candidate generation accepts it as model-ready.
    """
    target = float(effective_target_distance(state, assumptions))
    carries = modeled_variant_carries(profiles, assumptions)
    shortest = min(carries) if carries else None

    if state.mode != "approach":
        return ShotCoverageDecision(
            scope="modeled-shot",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=shortest,
            lower_coverage_limit_yds=None,
            distance_below_shortest_modeled_carry_yds=None,
            reason="short-game lower-bound coverage applies only to approach shots",
        )

    guidance_min = float(assumptions.get("short_game.minimum_geometry_guidance_distance_yds"))
    guidance_max = float(assumptions.get("short_game.maximum_geometry_guidance_distance_yds"))

    if shortest is None:
        if guidance_min <= target <= guidance_max:
            return ShotCoverageDecision(
                scope="geometry-only",
                effective_target_distance_yds=target,
                shortest_modeled_carry_yds=None,
                lower_coverage_limit_yds=None,
                distance_below_shortest_modeled_carry_yds=None,
                reason=(
                    "no model-ready Stock/Smooth/explicit shot covers this short approach; "
                    "use geometry only rather than inventing a player pattern"
                ),
            )
        return ShotCoverageDecision(
            scope="none",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=None,
            lower_coverage_limit_yds=None,
            distance_below_shortest_modeled_carry_yds=None,
            reason="no playable model-supported shot candidates are available for this distance",
        )

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

    if guidance_min <= target <= guidance_max:
        return ShotCoverageDecision(
            scope="geometry-only",
            effective_target_distance_yds=target,
            shortest_modeled_carry_yds=shortest,
            lower_coverage_limit_yds=lower_limit,
            distance_below_shortest_modeled_carry_yds=gap,
            reason=(
                "target is materially shorter than the shortest model-ready Stock/Smooth/explicit variant; "
                "do not extrapolate full-shot dispersion into an unmodeled partial shot"
            ),
        )

    if target < guidance_min:
        reason = "target is inside the configured true-greenside cutoff and no model-ready explicit variant covers it"
    else:
        reason = "target is outside the configured short-game geometry-only window and lacks model-ready shot coverage"
    return ShotCoverageDecision(
        scope="none",
        effective_target_distance_yds=target,
        shortest_modeled_carry_yds=shortest,
        lower_coverage_limit_yds=lower_limit,
        distance_below_shortest_modeled_carry_yds=gap,
        reason=reason,
    )
