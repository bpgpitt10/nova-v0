from __future__ import annotations
import math
from .assumptions import Assumptions
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

def generate_candidates(profiles: list[ClubProfile], state: LiveShotState, assumptions: Assumptions) -> list[CandidateShot]:
    policy = assumptions.get("candidate_policy")
    offsets = policy["approach_aim_offsets_yds"] if state.mode == "approach" else policy["strategic_aim_offsets_yds"]
    base_target = base_target_for_state(state)
    _base_unit, base_cross = unit_and_cross(base_target)

    shots: list[CandidateShot] = []
    for profile in profiles:
        carry_sigma, lateral_sigma = _sigma(profile, assumptions)
        variants: list[tuple[str, float, float]] = []
        if policy.get("include_stock", True):
            variants.append(("Stock", profile.stock_carry_yds, 1.0))
        if policy.get("include_smooth", True):
            variants.append((
                "Smooth",
                profile.stock_carry_yds * float(policy["smooth_factor"]),
                float(policy["smooth_sigma_factor"]),
            ))
        if policy.get("include_pure_as_playable", False) and profile.pure_carry_yds:
            variants.append(("Pure", profile.pure_carry_yds, 1.0))
        for explicit in profile.explicit_variants:
            if explicit.get("playable", True) and "carry_yds" in explicit:
                variants.append((
                    str(explicit.get("name", "Variant")),
                    float(explicit["carry_yds"]),
                    float(explicit.get("sigma_factor", 1.0)),
                ))

        for name, carry, sigma_factor in variants:
            if carry < float(policy["min_carry_yds"]):
                continue
            for offset in offsets:
                # Offset is cross-track from GSPro strategic aim / pin target, not
                # absolute canonical-map right. This remains correct when GSPro's
                # intended shot points 20+ degrees away from the pin line.
                aim_point = PointYards(
                    base_target.forward + base_cross.forward * float(offset),
                    base_target.right + base_cross.right * float(offset),
                )
                shot_unit, cross_unit = unit_and_cross(aim_point)
                cross_mean = float(profile.lateral_bias_yds) + float(state.external_lateral_adjustment_yds)
                landing = PointYards(
                    shot_unit.forward * float(carry) + cross_unit.forward * cross_mean,
                    shot_unit.right * float(carry) + cross_unit.right * cross_mean,
                )
                shots.append(CandidateShot(
                    club=profile.club,
                    variant=name,
                    planned_carry_yds=float(carry),
                    carry_sigma_yds=carry_sigma * sigma_factor,
                    lateral_sigma_yds=lateral_sigma * sigma_factor,
                    pattern_bias_yds=float(profile.lateral_bias_yds),
                    aim_offset_yds=float(offset),
                    base_target=base_target,
                    aim_point=aim_point,
                    shot_unit=shot_unit,
                    cross_unit=cross_unit,
                    landing=landing,
                ))
    return shots[:int(policy["max_candidates"])]
