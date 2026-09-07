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
            "candidate_policy",
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

        cache = self.get("hole_model_cache")
        if not (0.0 <= float(cache["course_name_similarity_min"]) <= 1.0):
            raise ValueError("hole_model_cache.course_name_similarity_min must be 0..1")
        if float(cache["hole_yardage_tolerance_yds"]) < 0:
            raise ValueError("hole_model_cache.hole_yardage_tolerance_yds cannot be negative")

        tee = self.get("tee_state")
        probable = float(tee["minimum_probable_confidence"])
        confirmed = float(tee["minimum_confirmed_confidence"])
        if not (0.0 <= probable <= confirmed <= 1.0):
            raise ValueError("tee_state confidence thresholds must satisfy 0 <= probable <= confirmed <= 1")
        for key in (
            "current_identity_valid_weight",
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
        if float(self.get("distance_fit.hard_reject_multiplier")) <= 1.0:
            raise ValueError("distance_fit.hard_reject_multiplier must be > 1")
        if not bool(self.get("actuation.never_zoom_back_in")):
            raise ValueError("Looper product invariant requires actuation.never_zoom_back_in=true")
