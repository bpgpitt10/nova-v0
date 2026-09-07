from __future__ import annotations
from .assumptions import Assumptions
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

def generate_candidates(profiles: list[ClubProfile], state: LiveShotState, assumptions: Assumptions) -> list[CandidateShot]:
    policy = assumptions.get("candidate_policy")
    offsets = policy["approach_aim_offsets_yds"] if state.mode == "approach" else policy["strategic_aim_offsets_yds"]
    base_aim = state.gspro_aim_right_yds if state.gspro_aim_right_yds is not None else state.pin_right_yds

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
                right = (
                    float(base_aim)
                    + float(offset)
                    + float(profile.lateral_bias_yds)
                    + float(state.external_lateral_adjustment_yds)
                )
                shots.append(CandidateShot(
                    club=profile.club,
                    variant=name,
                    planned_carry_yds=float(carry),
                    carry_sigma_yds=carry_sigma * sigma_factor,
                    lateral_sigma_yds=lateral_sigma * sigma_factor,
                    pattern_bias_yds=float(profile.lateral_bias_yds),
                    aim_offset_yds=float(offset),
                    base_aim_right_yds=float(base_aim),
                    landing=PointYards(float(carry), right),
                ))
    return shots[:int(policy["max_candidates"])]
