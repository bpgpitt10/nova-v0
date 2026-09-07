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
