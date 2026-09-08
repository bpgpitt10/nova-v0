from __future__ import annotations
import math
from .assumptions import Assumptions
from .environment import effective_target_distance
from .geometry import unit_and_cross
from .models import ClubProfile, LiveShotState, CandidateShot, PointYards


def _sigma(profile: ClubProfile, assumptions: Assumptions) -> tuple[float, float]:
    carry = profile.carry_sigma_yds
    lateral = profile.lateral_sigma_yds
    if carry is None:
        carry = profile.stock_carry_yds * float(assumptions.get("dispersion.default_carry_sigma_fraction"))
    if lateral is None:
        lateral = profile.stock_carry_yds * float(assumptions.get("dispersion.default_lateral_sigma_fraction"))
    carry = max(float(carry), float(assumptions.get("dispersion.minimum_carry_sigma_yds")))
    lateral = max(float(lateral), float(assumptions.get("dispersion.minimum_lateral_sigma_yds")))
    return carry, lateral


def _scaled_direction(forward: float | None, right: float | None, distance: float | None) -> PointYards | None:
    if forward is None or right is None:
        return None
    norm = math.hypot(float(forward), float(right))
    if norm <= 1e-9:
        return None
    magnitude = float(distance) if distance is not None and distance > 0 else norm
    return PointYards(float(forward) / norm * magnitude, float(right) / norm * magnitude)


def base_target_for_state(state: LiveShotState) -> PointYards:
    """Resolve the golf target vector without embedding strategic policy in UI code.

    Strategic shots preserve GSPro's spatial AIM direction and AIM-card distance.
    Approaches use the canonical pin direction and screen PIN distance. Fallbacks are
    deliberately simple and observable so confidence logic can flag missing geometry.
    """
    if state.mode == "strategic":
        target = _scaled_direction(
            state.gspro_aim_forward_yds,
            state.gspro_aim_right_yds,
            state.gspro_aim_distance_yds,
        )
        if target is not None:
            return target
        if state.gspro_aim_distance_yds is not None and state.gspro_aim_distance_yds > 0:
            return PointYards(float(state.gspro_aim_distance_yds), 0.0)

    target = _scaled_direction(
        state.pin_forward_yds,
        state.pin_right_yds,
        state.pin_distance_yds,
    )
    if target is not None:
        return target
    return PointYards(max(0.0, float(state.pin_distance_yds)), float(state.pin_right_yds))


def _variant_rows(profile: ClubProfile, assumptions: Assumptions) -> list[dict]:
    """Return playable variants with trustworthy pattern statistics.

    Stock and synthetic Smooth intentionally inherit the Stock pattern under explicit
    assumptions. A real tagged variant is different: Looper must never borrow Stock
    wedge dispersion for a materially shorter pitch/chip. An explicit variant is
    therefore modeled only when it carries its own carry/lateral dispersion values
    and the publisher has not marked it model-unready.
    """
    policy = assumptions.get("candidate_policy")
    base_carry_sigma, base_lateral_sigma = _sigma(profile, assumptions)
    rows: list[dict] = []

    if policy.get("include_stock", True):
        rows.append({
            "name": "Stock",
            "carry": float(profile.stock_carry_yds),
            "carry_sigma": base_carry_sigma,
            "lateral_sigma": base_lateral_sigma,
            "lateral_bias": float(profile.lateral_bias_yds),
            "source": "stock",
        })

    if policy.get("include_smooth", True):
        sigma_factor = float(policy["smooth_sigma_factor"])
        rows.append({
            "name": "Smooth",
            "carry": float(profile.stock_carry_yds) * float(policy["smooth_factor"]),
            "carry_sigma": base_carry_sigma * sigma_factor,
            "lateral_sigma": base_lateral_sigma * sigma_factor,
            "lateral_bias": float(profile.lateral_bias_yds),
            "source": "synthetic-smooth",
        })

    if policy.get("include_pure_as_playable", False) and profile.pure_carry_yds:
        rows.append({
            "name": "Pure",
            "carry": float(profile.pure_carry_yds),
            "carry_sigma": base_carry_sigma,
            "lateral_sigma": base_lateral_sigma,
            "lateral_bias": float(profile.lateral_bias_yds),
            "source": "pure-reference-enabled",
        })

    for explicit in profile.explicit_variants:
        if not explicit.get("playable", True) or "carry_yds" not in explicit:
            continue
        if explicit.get("model_ready") is False:
            continue

        has_own_pattern = (
            explicit.get("carry_sigma_yds") is not None
            and explicit.get("lateral_sigma_yds") is not None
            and explicit.get("lateral_bias_yds") is not None
        )
        if not has_own_pattern:
            # Even a named/known-carry variant is not a hazard-risk model until its
            # own pattern exists. It can still cause geometry-only guidance upstream.
            continue

        carry_sigma = float(explicit["carry_sigma_yds"])
        lateral_sigma = float(explicit["lateral_sigma_yds"])
        lateral_bias = float(explicit["lateral_bias_yds"])
        if carry_sigma < 0 or lateral_sigma < 0:
            # A negative dispersion is invalid source data. Do not silently abs() it
            # into a seemingly trustworthy player model.
            continue
        rows.append({
            "name": str(explicit.get("name", "Variant")),
            "carry": float(explicit["carry_yds"]),
            "carry_sigma": carry_sigma,
            "lateral_sigma": lateral_sigma,
            "lateral_bias": lateral_bias,
            "source": "explicit-variant",
        })
    return rows


def modeled_variant_carries(profiles: list[ClubProfile], assumptions: Assumptions) -> list[float]:
    """Return every model-supported carry before aim expansion/truncation.

    Shot-coverage decisions must not depend on bag order, aim-offset count, or the
    max-candidate cap. This list is the lower-bound model inventory itself.
    """
    minimum_carry = float(assumptions.get("candidate_policy.min_carry_yds"))
    carries: list[float] = []
    for profile in profiles:
        for variant in _variant_rows(profile, assumptions):
            carry = float(variant["carry"])
            if carry >= minimum_carry:
                carries.append(carry)
    return carries


def generate_candidates(profiles: list[ClubProfile], state: LiveShotState, assumptions: Assumptions) -> list[CandidateShot]:
    policy = assumptions.get("candidate_policy")
    offsets = policy["approach_aim_offsets_yds"] if state.mode == "approach" else policy["strategic_aim_offsets_yds"]
    base_target = base_target_for_state(state)
    _base_unit, base_cross = unit_and_cross(base_target)

    shots: list[CandidateShot] = []
    minimum_carry = float(policy["min_carry_yds"])
    for profile in profiles:
        for variant in _variant_rows(profile, assumptions):
            carry = float(variant["carry"])
            if carry < minimum_carry:
                continue
            carry_sigma = float(variant["carry_sigma"])
            lateral_sigma = float(variant["lateral_sigma"])
            lateral_bias = float(variant["lateral_bias"])
            for offset in offsets:
                # Offset is cross-track from GSPro strategic aim / pin target, not
                # absolute canonical-map right. This remains correct when GSPro's
                # intended shot points 20+ degrees away from the pin line.
                aim_point = PointYards(
                    base_target.forward + base_cross.forward * float(offset),
                    base_target.right + base_cross.right * float(offset),
                )
                shot_unit, cross_unit = unit_and_cross(aim_point)
                cross_mean = lateral_bias + float(state.external_lateral_adjustment_yds)
                landing = PointYards(
                    shot_unit.forward * carry + cross_unit.forward * cross_mean,
                    shot_unit.right * carry + cross_unit.right * cross_mean,
                )
                shots.append(CandidateShot(
                    club=profile.club,
                    variant=str(variant["name"]),
                    planned_carry_yds=carry,
                    carry_sigma_yds=carry_sigma,
                    lateral_sigma_yds=lateral_sigma,
                    pattern_bias_yds=lateral_bias,
                    aim_offset_yds=float(offset),
                    base_target=base_target,
                    aim_point=aim_point,
                    shot_unit=shot_unit,
                    cross_unit=cross_unit,
                    landing=landing,
                ))

    # Never let bag ordering make the max-candidate guard silently drop the scoring
    # clubs / explicit variants at the end of a configured bag. Keep the candidates
    # closest to the effective target first, then the smallest aim departures.
    target = effective_target_distance(state, assumptions)
    shots.sort(key=lambda shot: (
        abs(float(shot.planned_carry_yds) - target),
        abs(float(shot.aim_offset_yds)),
        shot.club,
        shot.variant,
    ))
    return shots[:int(policy["max_candidates"])]
