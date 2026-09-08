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
        "tee-state-inference", "v1",
        "Fallback/recovery inference for a new-hole tee from minimap Tee state, identity transition, optional shot/DTP, terminal-hole, lie and full-hole-map evidence; never starts capture itself.",
        "tools.live_caddie.tee_state.infer_tee_state",
        ("current/previous round identity", "minimap surface", "optional upper-left shot state", "PIN card DTP", "Looper lifecycle evidence"),
        ("TeeStateDecision",),
        ("tee_state.minimum_confirmed_confidence", "tee_state.minimum_probable_confidence",
         "tee_state.require_transition_or_shot_one_anchor", "tee_state.minimap_tee_surface_counts_as_anchor",
         "tee_state.current_identity_valid_weight", "tee_state.minimap_tee_surface_weight",
         "tee_state.hole_change_weight", "tee_state.shot_number_one_weight",
         "tee_state.no_recorded_shots_weight", "tee_state.distance_matches_hole_weight",
         "tee_state.previous_hole_terminal_weight", "tee_state.flat_lie_weight",
         "tee_state.full_hole_minimap_weight", "tee_state.distance_absolute_tolerance_yds",
         "tee_state.distance_relative_tolerance_fraction", "tee_state.non_tee_surface_is_hard_contradiction",
         "tee_state.shot_number_gt_one_is_hard_contradiction", "tee_state.recorded_shots_is_hard_contradiction"),
    ),
    "state_source_resolution": CalculationSpec(
        "state-source-resolution", "v1",
        "Resolve authoritative distance-to-pin from upper-left HUD, PIN card and canonical geometry using explicit precedence while preserving every source as a cross-check.",
        "tools.live_caddie.source_resolution.resolve_distance_to_pin",
        ("upper-left DTP?", "PIN card DTP?", "canonical DTP?", "registration confidence?"),
        ("ResolvedDistance", "source disagreements"),
        ("source_resolution.distance_to_pin_precedence", "source_resolution.upper_left_source_confidence",
         "source_resolution.pin_card_source_confidence", "source_resolution.unrated_source_confidence",
         "source_resolution.warning_confidence_cap", "source_resolution.hard_conflict_confidence_cap",
         "source_resolution.distance_warning_absolute_yds", "source_resolution.distance_warning_relative_fraction",
         "source_resolution.distance_hard_conflict_absolute_yds", "source_resolution.distance_hard_conflict_relative_fraction",
         "source_resolution.canonical_distance_minimum_registration_confidence"),
    ),
    "shot_progression": CalculationSpec(
        "shot-progression", "v0",
        "Interpret screen shot-number changes into advancement/reset/jump events for fallback diagnostics; structured completed-shot events are intended to own normal lifecycle progression.",
        "tools.live_caddie.shot_progression.infer_shot_progression",
        ("previous/current identity", "previous/current shot number", "previous/current DTP?"),
        ("ShotProgressionDecision",),
        (),
    ),
    "shot_mode_inference": CalculationSpec(
        "shot-mode-inference", "v0",
        "Classify post-tee state as strategic, approach, no-full-shot, or unknown using GSPro surface plus canonical AIM/green geometry with AIM-vs-PIN distance fallback.",
        "tools.live_caddie.shot_mode.infer_shot_mode",
        ("minimap surface", "PIN distance", "AIM distance", "canonical AIM target", "canonical target-green polygon"),
        ("ShotModeDecision",),
        ("shot_mode.non_full_shot_surfaces", "shot_mode.non_full_shot_surface_confidence",
         "shot_mode.aim_inside_green_confidence", "shot_mode.aim_outside_green_confidence",
         "shot_mode.aim_pin_distance_absolute_tolerance_yds", "shot_mode.aim_pin_distance_relative_fraction",
         "shot_mode.aim_pin_distance_match_confidence", "shot_mode.aim_pin_distance_divergence_confidence",
         "shot_mode.fallback_approach_max_pin_distance_yds", "shot_mode.fallback_approach_confidence",
         "shot_mode.unknown_confidence", "shot_mode.minimum_actionable_confidence"),
        ("canonical-hole-extraction",),
    ),
    "green_refinement_build": CalculationSpec(
        "green-refinement-build", "v0",
        "Transform a higher-resolution post-tee heatmap green back into canonical tee yard coordinates and verify pin alignment before merge.",
        "tools.live_caddie.green_refinement.build_refinement",
        ("tee HoleModel", "canonical HoleModel", "post-tee green mask", "post-tee heatmap", "registration transform"),
        ("GreenRefinement",),
        ("green_refinement.minimum_source_area_px", "green_refinement.polygon_simplify_epsilon_px",
         "green_refinement.heatmap_sample_stride_px", "green_refinement.maximum_pin_alignment_error_yds"),
        ("canonical-hole-extraction",),
    ),
    "green_refinement_merge": CalculationSpec(
        "green-refinement-merge", "v0",
        "Confidence-gate a canonical GreenSurfaceModel refinement while retaining provenance/history and refusing weak registration/heatmap evidence.",
        "tools.live_caddie.green_refinement.merge_refinement",
        ("canonical HoleModel", "GreenRefinement"),
        ("updated canonical HoleModel", "merge decision"),
        ("green_refinement.minimum_registration_confidence", "green_refinement.minimum_heatmap_confidence",
         "green_refinement.prefer_refinement_when_valid", "green_refinement.minimum_confidence_gain_to_replace",
         "green_refinement.maximum_history_entries"),
        ("green-refinement-build",),
    ),
    "candidate_generation": CalculationSpec(
        "candidate-generation", "v3",
        "Create Stock, synthetic Smooth and explicit playable shot candidates around the correct spatial target vector without redefining Looper Stock/Pure; explicit variants use their own observed pattern statistics when supplied.",
        "tools.live_caddie.candidates.generate_candidates",
        ("ClubProfile[]", "LiveShotState"),
        ("CandidateShot[]",),
        ("candidate_policy.smooth_factor", "candidate_policy.smooth_sigma_factor",
         "candidate_policy.include_pure_as_playable", "candidate_policy.min_carry_yds",
         "candidate_policy.approach_aim_offsets_yds", "candidate_policy.strategic_aim_offsets_yds",
         "dispersion.minimum_carry_sigma_yds", "dispersion.minimum_lateral_sigma_yds"),
        ("shot-mode-inference",),
    ),
    "short_game_shot_coverage": CalculationSpec(
        "short-game-shot-coverage", "v0",
        "Determine whether an approach is supported by an actual modeled Stock/Smooth/explicit shot, should fall back to geometry-only safe-side guidance, or is inside the true-greenside no-guidance cutoff.",
        "tools.live_caddie.shot_coverage.assess_shot_coverage",
        ("CandidateShot[]", "LiveShotState"),
        ("ShotCoverageDecision",),
        ("short_game.modeled_coverage_absolute_tolerance_yds",
         "short_game.modeled_coverage_relative_fraction",
         "short_game.minimum_geometry_guidance_distance_yds"),
        ("candidate-generation", "effective-target-distance"),
    ),
    "short_game_geometry_guidance": CalculationSpec(
        "short-game-geometry-guidance", "v0",
        "When no modeled partial shot exists, compare known green-edge and penalty-boundary geometry to provide a safe-side perspective without inventing club, spin, dispersion or probability.",
        "tools.live_caddie.short_game.build_short_game_guidance",
        ("LiveShotState", "HazardBoundary[]", "GreenSurface?", "effective target distance"),
        ("ShortGameGuidance",),
        ("short_game.geometry_aim_offsets_yds", "short_game.green_clearance_reference_yds",
         "short_game.hazard_clearance_reference_yds", "short_game.aim_offset_reference_yds",
         "short_game.minimum_side_advantage_score", "short_game.geometry_scoring",
         "short_game.confidence_green_and_hazard", "short_game.confidence_green_only",
         "short_game.confidence_hazard_only", "short_game.confidence_no_geometry"),
        ("short-game-shot-coverage", "canonical-hole-extraction"),
    ),
    "effective_target": CalculationSpec(
        "effective-target-distance", "v1",
        "Use PIN distance for approaches and GSPro AIM distance for strategic shots, then apply explicit elevation/external environment adjustment.",
        "tools.live_caddie.environment.effective_target_distance",
        ("LiveShotState",),
        ("effective target carry yards",),
        ("environment.use_target_elevation", "environment.elevation_effective_distance_factor", "environment.wind_mode"),
        ("shot-mode-inference",),
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
        "shot-scoring", "v3",
        "Combine mode-aware distance fit, boundary risk, green containment and nonlinear strategic aim-change cost using external assumptions.",
        "tools.live_caddie.scoring.evaluate",
        ("CandidateShot", "LiveShotState", "HazardBoundary[]", "GreenSurface?"),
        ("CandidateEvaluation",),
        ("distance_fit.absolute_tolerance_yds", "distance_fit.relative_tolerance_fraction",
         "distance_fit.hard_reject_multiplier", "scoring.approach", "scoring.strategic",
         "scoring.aim_change_reference_yds", "scoring.aim_change_exponent"),
        ("effective-target-distance", "hazard-boundary-risk", "green-containment"),
    ),
    "recommendation_confidence": CalculationSpec(
        "recommendation-confidence", "v1",
        "Gate modeled-shot recommendation confidence using registration/cross-check completeness and separation between top candidates.",
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
        "Convert a modeled recommended cross-track AIM change plus same-shot movement calibration into a bounded LEFT/RIGHT key plan; geometry-only guidance has no CandidateEvaluation and therefore cannot actuate.",
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
