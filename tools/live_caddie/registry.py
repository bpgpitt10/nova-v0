from __future__ import annotations
from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class CalculationSpec:
    calc_id: str
    version: str
    purpose: str
    implementation: str
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]
    assumption_keys: tuple[str, ...]
    dependencies: tuple[str, ...] = ()


CALCULATIONS = {
    "canonical_hole_extraction": CalculationSpec(
        "canonical-hole-extraction", "v0",
        "Convert tee minimap hazard/green pixels into a stable yard-space hole coordinate system.",
        "tools.live_caddie.canonicalize_capture.build_canonical_hole",
        ("tee HoleModel", "hazard-safe minimap", "target-green mask", "heatmap minimap"),
        ("canonical hazard polylines", "canonical green polygon", "heatmap samples"),
        ("canonical_geometry.player_marker_mask_radius_px", "canonical_geometry.hazard_min_arc_length_px",
         "canonical_geometry.hazard_simplify_epsilon_px", "canonical_geometry.green_simplify_epsilon_px",
         "canonical_geometry.heatmap_sample_stride_px"),
    ),
    "tee_state_inference": CalculationSpec(
        "tee-state-inference", "v0",
        "Infer a new-hole tee from course/hole transitions plus optional shot-number, DTP, terminal-hole, lie and full-hole-map evidence; never starts capture itself.",
        "tools.live_caddie.tee_state.infer_tee_state",
        ("current/previous round identity", "optional upper-left shot state", "PIN card DTP", "Looper lifecycle evidence"),
        ("TeeStateDecision",),
        ("tee_state.minimum_confirmed_confidence", "tee_state.minimum_probable_confidence",
         "tee_state.require_transition_or_shot_one_anchor", "tee_state.current_identity_valid_weight",
         "tee_state.hole_change_weight", "tee_state.shot_number_one_weight",
         "tee_state.no_recorded_shots_weight", "tee_state.distance_matches_hole_weight",
         "tee_state.previous_hole_terminal_weight", "tee_state.flat_lie_weight",
         "tee_state.full_hole_minimap_weight", "tee_state.distance_absolute_tolerance_yds",
         "tee_state.distance_relative_tolerance_fraction", "tee_state.shot_number_gt_one_is_hard_contradiction",
         "tee_state.recorded_shots_is_hard_contradiction"),
    ),
    "candidate_generation": CalculationSpec(
        "candidate-generation", "v2",
        "Create Stock, Smooth and explicit playable shot candidates around the correct spatial target vector without redefining Looper Stock/Pure.",
        "tools.live_caddie.candidates.generate_candidates",
        ("ClubProfile[]", "LiveShotState"),
        ("CandidateShot[]",),
        ("candidate_policy.smooth_factor", "candidate_policy.smooth_sigma_factor",
         "candidate_policy.include_pure_as_playable", "candidate_policy.approach_aim_offsets_yds",
         "candidate_policy.strategic_aim_offsets_yds", "dispersion.minimum_carry_sigma_yds",
         "dispersion.minimum_lateral_sigma_yds"),
    ),
    "effective_target": CalculationSpec(
        "effective-target-distance", "v1",
        "Use PIN distance for approaches and GSPro AIM distance for strategic shots, then apply explicit elevation/external environment adjustment.",
        "tools.live_caddie.environment.effective_target_distance",
        ("LiveShotState",),
        ("effective target carry yards",),
        ("environment.use_target_elevation", "environment.elevation_effective_distance_factor", "environment.wind_mode"),
    ),
    "hazard_boundary_risk": CalculationSpec(
        "hazard-boundary-risk", "v1",
        "Score weighted proximity of the oriented shot dispersion to authoritative red penalty boundaries without claiming which side is penalty.",
        "tools.live_caddie.risk.boundary_risk",
        ("CandidateShot", "HazardBoundary[]"),
        ("boundary risk index", "expected-center boundary clearance"),
        ("hazard_boundary.buffer_sigma", "hazard_boundary.danger_sigma", "hazard_boundary.tight_sigma",
         "hazard_boundary.sample_sigma_extent"),
    ),
    "green_containment": CalculationSpec(
        "green-containment", "v1",
        "Estimate how much of an oriented deterministic Gaussian pattern sample lies inside the canonical target green.",
        "tools.live_caddie.risk.green_containment",
        ("CandidateShot", "GreenSurface"),
        ("green containment fraction",),
        ("green.sample_sigma_extent", "green.minimum_containment_fraction", "green.strong_containment_fraction"),
    ),
    "shot_scoring": CalculationSpec(
        "shot-scoring", "v2",
        "Combine mode-aware distance fit, boundary risk, green containment and strategic aim change using external weights.",
        "tools.live_caddie.scoring.evaluate",
        ("CandidateShot", "LiveShotState", "HazardBoundary[]", "GreenSurface?"),
        ("CandidateEvaluation",),
        ("distance_fit.absolute_tolerance_yds", "distance_fit.relative_tolerance_fraction",
         "distance_fit.hard_reject_multiplier", "scoring.approach", "scoring.strategic",
         "scoring.aim_change_reference_yds"),
        ("effective-target-distance", "hazard-boundary-risk", "green-containment"),
    ),
    "recommendation_confidence": CalculationSpec(
        "recommendation-confidence", "v1",
        "Gate recommendation confidence using registration/cross-check completeness and separation between top candidates.",
        "tools.live_caddie.engine._confidence",
        ("LiveShotState", "GreenSurface?", "CandidateEvaluation[]"),
        ("recommendation confidence", "fallback messages"),
        ("confidence.minimum_registration_confidence", "confidence.pin_crosscheck_absolute_yds",
         "confidence.pin_crosscheck_relative_fraction", "confidence.low_confidence_score_gap",
         "confidence.missing_strategic_aim_multiplier", "confidence.missing_approach_green_multiplier"),
        ("shot-scoring",),
    ),
    "aim_actuation_plan": CalculationSpec(
        "aim-actuation-plan", "v0",
        "Convert a recommended cross-track AIM change plus same-shot movement calibration into a bounded LEFT/RIGHT key plan; never presses keys itself.",
        "tools.live_caddie.aim_planning.build_aim_plan",
        ("RecommendationResult", "AimCalibration"),
        ("AimPlan",),
        ("actuation.minimum_confidence", "actuation.maximum_automatic_aim_offset_yds",
         "actuation.aim_deadband_yds", "actuation.minimum_calibration_confidence",
         "actuation.minimum_yards_per_ms", "actuation.maximum_yards_per_ms",
         "actuation.maximum_single_command_ms", "actuation.verification_tolerance_yds"),
        ("recommendation-confidence",),
    ),
}


def versions() -> dict[str, str]:
    return {spec.calc_id: spec.version for spec in CALCULATIONS.values()}


def manifest() -> list[dict]:
    """Machine-readable Model/Math Inspector contract for UI/dev tooling."""
    return [asdict(spec) for spec in CALCULATIONS.values()]
