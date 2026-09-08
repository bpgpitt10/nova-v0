from __future__ import annotations
import json
from pathlib import Path
from typing import Any

_MISSING = object()


class Assumptions:
    def __init__(self, payload: dict[str, Any], source: Path | None = None):
        self.payload = payload
        self.source = source
        if payload.get("schema_version") != "looper-live-caddie-assumptions-v0":
            raise ValueError("Unsupported live-caddie assumptions schema")
        self.validate()

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Assumptions":
        if path is None:
            path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
        path = Path(path)
        return cls(json.loads(path.read_text(encoding="utf-8")), path)

    @property
    def version(self) -> str:
        return str(self.payload.get("assumptions_version", "unknown"))

    def get(self, dotted_key: str, default: Any = _MISSING) -> Any:
        cur: Any = self.payload
        for part in dotted_key.split("."):
            if not isinstance(cur, dict) or part not in cur:
                if default is not _MISSING:
                    return default
                raise KeyError(dotted_key)
            cur = cur[part]
        return cur

    def validate(self) -> None:
        required_sections = (
            "canonical_geometry",
            "screen_detection",
            "hole_model_cache",
            "tee_state",
            "source_resolution",
            "green_refinement",
            "round_orchestrator",
            "shot_mode",
            "candidate_policy",
            "short_game",
            "distance_fit",
            "dispersion",
            "hazard_boundary",
            "green",
            "scoring",
            "confidence",
            "environment",
            "actuation",
        )
        for section in required_sections:
            if not isinstance(self.payload.get(section), dict):
                raise ValueError(f"Missing/invalid assumptions section: {section}")

        identity = self.get("screen_detection.round_identity")
        for key in (
            "hole_number_roi_normalized",
            "course_name_roi_normalized",
            "par_roi_normalized",
            "yards_roi_normalized",
        ):
            roi = identity.get(key)
            if not isinstance(roi, list) or len(roi) != 4:
                raise ValueError(f"screen_detection.round_identity.{key} must be x1,y1,x2,y2")
            x1, y1, x2, y2 = [float(value) for value in roi]
            if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
                raise ValueError(f"screen_detection.round_identity.{key} must be normalized to 0..1")
        if not (0.0 <= float(identity["minimum_usable_confidence"]) <= 1.0):
            raise ValueError("round identity minimum_usable_confidence must be 0..1")
        identity_weight_sum = sum(
            float(identity[key])
            for key in ("course_weight", "hole_weight", "par_weight", "yards_weight")
        )
        if abs(identity_weight_sum - 1.0) > 1e-6:
            raise ValueError("round identity confidence weights must sum to 1.0")

        surface = self.get("screen_detection.minimap_surface")
        if not (0.0 <= float(surface["fuzzy_match_min"]) <= 1.0):
            raise ValueError("minimap surface fuzzy_match_min must be 0..1")

        cache = self.get("hole_model_cache")
        if not (0.0 <= float(cache["course_name_similarity_min"]) <= 1.0):
            raise ValueError("hole_model_cache.course_name_similarity_min must be 0..1")
        if float(cache["hole_yardage_tolerance_yds"]) < 0:
            raise ValueError("hole_model_cache.hole_yardage_tolerance_yds cannot be negative")
        for key in (
            "par_match_bonus",
            "yardage_match_bonus",
            "base_course_hole_confidence",
            "course_similarity_weight",
            "missing_course_par_yard_confidence",
            "unique_hole_confidence",
            "legacy_latest_confidence",
            "latest_without_warning_confidence",
        ):
            value = float(cache[key])
            if not (0.0 <= value <= 1.0):
                raise ValueError(f"hole_model_cache.{key} must be 0..1")

        tee = self.get("tee_state")
        probable = float(tee["minimum_probable_confidence"])
        confirmed = float(tee["minimum_confirmed_confidence"])
        if not (0.0 <= probable <= confirmed <= 1.0):
            raise ValueError("tee_state confidence thresholds must satisfy 0 <= probable <= confirmed <= 1")
        for key in (
            "current_identity_valid_weight",
            "minimap_tee_surface_weight",
            "hole_change_weight",
            "shot_number_one_weight",
            "no_recorded_shots_weight",
            "distance_matches_hole_weight",
            "previous_hole_terminal_weight",
            "flat_lie_weight",
            "full_hole_minimap_weight",
        ):
            if float(tee[key]) < 0:
                raise ValueError(f"tee_state.{key} cannot be negative")
        if float(tee["distance_absolute_tolerance_yds"]) < 0:
            raise ValueError("tee_state.distance_absolute_tolerance_yds cannot be negative")
        if float(tee["distance_relative_tolerance_fraction"]) < 0:
            raise ValueError("tee_state.distance_relative_tolerance_fraction cannot be negative")

        source = self.get("source_resolution")
        precedence = source.get("distance_to_pin_precedence")
        if not isinstance(precedence, list) or not precedence:
            raise ValueError("source_resolution.distance_to_pin_precedence must be a non-empty list")
        if len(precedence) != len(set(precedence)):
            raise ValueError("distance-to-pin precedence contains duplicate sources")
        for key in (
            "upper_left_source_confidence",
            "pin_card_source_confidence",
            "unrated_source_confidence",
            "warning_confidence_cap",
            "hard_conflict_confidence_cap",
            "identity_minimum_confidence",
            "canonical_distance_minimum_registration_confidence",
            "surface_recognition_minimum_confidence",
        ):
            value = float(source[key])
            if not (0.0 <= value <= 1.0):
                raise ValueError(f"source_resolution.{key} must be 0..1")
        for key in (
            "distance_warning_absolute_yds",
            "distance_warning_relative_fraction",
            "distance_hard_conflict_absolute_yds",
            "distance_hard_conflict_relative_fraction",
        ):
            if float(source[key]) < 0:
                raise ValueError(f"source_resolution.{key} cannot be negative")
        if float(source["distance_hard_conflict_absolute_yds"]) < float(source["distance_warning_absolute_yds"]):
            raise ValueError("distance hard-conflict absolute threshold must be >= warning threshold")
        if float(source["distance_hard_conflict_relative_fraction"]) < float(source["distance_warning_relative_fraction"]):
            raise ValueError("distance hard-conflict relative threshold must be >= warning threshold")
        if float(source["hard_conflict_confidence_cap"]) > float(source["warning_confidence_cap"]):
            raise ValueError("hard-conflict confidence cap must be <= warning confidence cap")

        refinement = self.get("green_refinement")
        for key in (
            "minimum_registration_confidence",
            "minimum_heatmap_confidence",
        ):
            if not (0.0 <= float(refinement[key]) <= 1.0):
                raise ValueError(f"green_refinement.{key} must be 0..1")
        if float(refinement["maximum_pin_alignment_error_yds"]) <= 0:
            raise ValueError("green_refinement.maximum_pin_alignment_error_yds must be positive")
        if float(refinement["maximum_auto_refinement_distance_yds"]) <= 0:
            raise ValueError("green_refinement.maximum_auto_refinement_distance_yds must be positive")
        if int(refinement["maximum_history_entries"]) <= 0:
            raise ValueError("green_refinement.maximum_history_entries must be positive")

        orchestrator = self.get("round_orchestrator")
        if int(orchestrator["tee_stable_observations"]) <= 0:
            raise ValueError("round_orchestrator.tee_stable_observations must be positive")
        if int(orchestrator["normal_state_stable_observations"]) <= 0:
            raise ValueError("round_orchestrator.normal_state_stable_observations must be positive")
        if float(orchestrator["minimum_action_interval_ms"]) < 0:
            raise ValueError("round_orchestrator.minimum_action_interval_ms cannot be negative")

        shot_mode = self.get("shot_mode")
        surfaces = shot_mode.get("non_full_shot_surfaces")
        if not isinstance(surfaces, list) or not surfaces:
            raise ValueError("shot_mode.non_full_shot_surfaces must be a non-empty list")
        for key in (
            "non_full_shot_surface_confidence",
            "aim_inside_green_confidence",
            "aim_outside_green_confidence",
            "aim_pin_distance_match_confidence",
            "aim_pin_distance_divergence_confidence",
            "fallback_approach_confidence",
            "unknown_confidence",
            "minimum_actionable_confidence",
        ):
            value = float(shot_mode[key])
            if not (0.0 <= value <= 1.0):
                raise ValueError(f"shot_mode.{key} must be 0..1")
        if float(shot_mode["aim_pin_distance_absolute_tolerance_yds"]) < 0:
            raise ValueError("shot_mode aim/pin absolute tolerance cannot be negative")
        if float(shot_mode["aim_pin_distance_relative_tolerance_fraction"]) < 0:
            raise ValueError("shot_mode aim/pin relative tolerance cannot be negative")
        if float(shot_mode["fallback_approach_max_pin_distance_yds"]) <= 0:
            raise ValueError("shot_mode fallback approach distance must be positive")

        for mode in ("approach", "strategic"):
            weights = self.get(f"scoring.{mode}")
            keys = (
                "distance_fit_weight",
                "hazard_boundary_weight",
                "green_miss_weight",
                "aim_change_weight",
            )
            values = [float(weights[key]) for key in keys]
            if any(value < 0 for value in values):
                raise ValueError(f"Negative scoring weight in scoring.{mode}")
            if abs(sum(values) - 1.0) > 1e-6:
                raise ValueError(f"scoring.{mode} weights must sum to 1.0")
        if float(self.get("scoring.aim_change_exponent")) <= 0:
            raise ValueError("scoring.aim_change_exponent must be positive")

        for key in ("approach_aim_offsets_yds", "strategic_aim_offsets_yds"):
            offsets = self.get(f"candidate_policy.{key}")
            if not isinstance(offsets, list) or not offsets:
                raise ValueError(f"candidate_policy.{key} must be a non-empty list")
            if not any(abs(float(value)) <= 1e-9 for value in offsets):
                raise ValueError(f"candidate_policy.{key} must include the zero/base-aim candidate")

        if float(self.get("candidate_policy.smooth_factor")) <= 0:
            raise ValueError("candidate_policy.smooth_factor must be positive")
        if int(self.get("candidate_policy.max_candidates")) <= 0:
            raise ValueError("candidate_policy.max_candidates must be positive")
        if float(self.get("candidate_policy.min_carry_yds")) < 0:
            raise ValueError("candidate_policy.min_carry_yds cannot be negative")

        short_game = self.get("short_game")
        for key in (
            "modeled_coverage_absolute_tolerance_yds",
            "modeled_coverage_relative_fraction",
            "minimum_geometry_guidance_distance_yds",
            "green_clearance_reference_yds",
            "hazard_clearance_reference_yds",
            "aim_offset_reference_yds",
            "minimum_side_advantage_score",
        ):
            if float(short_game[key]) < 0:
                raise ValueError(f"short_game.{key} cannot be negative")
        for key in (
            "green_clearance_reference_yds",
            "hazard_clearance_reference_yds",
            "aim_offset_reference_yds",
        ):
            if float(short_game[key]) <= 0:
                raise ValueError(f"short_game.{key} must be positive")
        guidance_offsets = short_game.get("geometry_aim_offsets_yds")
        if not isinstance(guidance_offsets, list) or not guidance_offsets:
            raise ValueError("short_game.geometry_aim_offsets_yds must be a non-empty list")
        if not any(abs(float(value)) <= 1e-9 for value in guidance_offsets):
            raise ValueError("short_game.geometry_aim_offsets_yds must include zero")
        rounded_offsets = {round(float(value), 9) for value in guidance_offsets}
        if any(round(-float(value), 9) not in rounded_offsets for value in guidance_offsets):
            raise ValueError("short_game.geometry_aim_offsets_yds must be symmetric around zero")
        guidance_weights = short_game.get("geometry_scoring")
        if not isinstance(guidance_weights, dict):
            raise ValueError("short_game.geometry_scoring must be an object")
        guidance_weight_values = [
            float(guidance_weights[key])
            for key in ("green_clearance_weight", "hazard_clearance_weight", "aim_change_weight")
        ]
        if any(value < 0 for value in guidance_weight_values):
            raise ValueError("short_game.geometry_scoring weights cannot be negative")
        if abs(sum(guidance_weight_values) - 1.0) > 1e-6:
            raise ValueError("short_game.geometry_scoring weights must sum to 1.0")
        for key in (
            "confidence_green_and_hazard",
            "confidence_green_only",
            "confidence_hazard_only",
            "confidence_no_geometry",
        ):
            value = float(short_game[key])
            if not (0.0 <= value <= 1.0):
                raise ValueError(f"short_game.{key} must be 0..1")

        if float(self.get("distance_fit.hard_reject_multiplier")) <= 1.0:
            raise ValueError("distance_fit.hard_reject_multiplier must be > 1")
        if not bool(self.get("actuation.never_zoom_back_in")):
            raise ValueError("Looper product invariant requires actuation.never_zoom_back_in=true")
