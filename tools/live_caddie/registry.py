from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class CalculationSpec:
    calc_id: str
    version: str
    purpose: str
    assumption_keys: tuple[str, ...]
    dependencies: tuple[str, ...] = ()

CALCULATIONS = {
    "canonical_hole_extraction": CalculationSpec(
        "canonical-hole-extraction", "v0",
        "Convert tee minimap hazard/green pixels into a stable yard-space hole coordinate system.",
        ("canonical_geometry.player_marker_mask_radius_px", "canonical_geometry.hazard_min_arc_length_px",
         "canonical_geometry.hazard_simplify_epsilon_px", "canonical_geometry.green_simplify_epsilon_px",
         "canonical_geometry.heatmap_sample_stride_px"),
    ),
    "candidate_generation": CalculationSpec(
        "candidate-generation", "v1",
        "Create Stock, Smooth and explicit playable shot candidates without redefining Looper Stock/Pure.",
        ("candidate_policy.smooth_factor", "candidate_policy.smooth_sigma_factor",
         "candidate_policy.include_pure_as_playable", "candidate_policy.approach_aim_offsets_yds",
         "candidate_policy.strategic_aim_offsets_yds", "dispersion.minimum_carry_sigma_yds",
         "dispersion.minimum_lateral_sigma_yds"),
    ),
    "effective_target": CalculationSpec(
        "effective-target-distance", "v0",
        "Translate PIN distance/elevation plus Looper-supplied environmental adjustment into required carry.",
        ("environment.use_target_elevation", "environment.wind_mode"),
    ),
    "hazard_boundary_risk": CalculationSpec(
        "hazard-boundary-risk", "v0",
        "Score proximity of the shot pattern to authoritative red penalty boundaries without claiming which side is penalty.",
        ("hazard_boundary.buffer_sigma", "hazard_boundary.danger_sigma", "hazard_boundary.tight_sigma"),
    ),
    "green_containment": CalculationSpec(
        "green-containment", "v0",
        "Estimate how much of a deterministic Gaussian pattern sample lies inside the canonical target green.",
        ("green.sample_sigma_extent", "green.minimum_containment_fraction", "green.strong_containment_fraction"),
    ),
    "shot_scoring": CalculationSpec(
        "shot-scoring", "v1",
        "Combine distance fit, boundary risk, green containment and strategic aim change using external weights.",
        ("scoring.approach", "scoring.strategic", "scoring.aim_change_reference_yds"),
        ("effective-target-distance", "hazard-boundary-risk", "green-containment"),
    ),
    "recommendation_confidence": CalculationSpec(
        "recommendation-confidence", "v0",
        "Gate recommendation confidence using registration/cross-check state and separation between top candidates.",
        ("confidence.minimum_registration_confidence", "confidence.pin_crosscheck_absolute_yds",
         "confidence.pin_crosscheck_relative_fraction", "confidence.low_confidence_score_gap"),
        ("shot-scoring",),
    ),
}

def versions() -> dict[str, str]:
    return {spec.calc_id: spec.version for spec in CALCULATIONS.values()}
