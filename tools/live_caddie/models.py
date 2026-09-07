from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Literal

Mode = Literal["approach", "strategic"]

@dataclass(frozen=True)
class PointYards:
    forward: float
    right: float

@dataclass
class HazardBoundary:
    hazard_id: str
    points: list[PointYards]
    source: str = "gspro-red-penalty-boundary"
    side_semantics_known: bool = False

@dataclass
class GreenSurface:
    polygon: list[PointYards]
    pin: PointYards
    heatmap_samples: list[dict] = field(default_factory=list)
    confidence: float = 0.0
    source: str = "gspro-tee-heatmap"

@dataclass
class ClubProfile:
    club: str
    stock_carry_yds: float
    carry_sigma_yds: float | None = None
    lateral_bias_yds: float = 0.0
    lateral_sigma_yds: float | None = None
    pure_carry_yds: float | None = None
    explicit_variants: list[dict] = field(default_factory=list)

@dataclass
class LiveShotState:
    mode: Mode
    pin_distance_yds: float
    pin_elevation_delta_yds: float = 0.0
    pin_forward_yds: float | None = None
    pin_right_yds: float = 0.0
    gspro_aim_forward_yds: float | None = None
    gspro_aim_right_yds: float | None = None
    gspro_aim_distance_yds: float | None = None
    gspro_aim_elevation_delta_yds: float = 0.0
    external_carry_adjustment_yds: float = 0.0
    external_lateral_adjustment_yds: float = 0.0
    lie_up_down_deg: float | None = None
    lie_left_right_deg: float | None = None
    registration_confidence: float | None = None
    pin_crosscheck_error_yds: float | None = None

@dataclass
class CandidateShot:
    club: str
    variant: str
    planned_carry_yds: float
    carry_sigma_yds: float
    lateral_sigma_yds: float
    pattern_bias_yds: float
    aim_offset_yds: float
    base_target: PointYards
    aim_point: PointYards
    shot_unit: PointYards
    cross_unit: PointYards
    landing: PointYards

@dataclass
class CandidateEvaluation:
    candidate: CandidateShot
    total_score: float
    effective_target_distance_yds: float
    distance_error_yds: float
    distance_fit_score: float
    hazard_boundary_risk: float
    green_containment: float | None
    aim_change_score: float
    minimum_boundary_clearance_yds: float | None
    reasons: list[str] = field(default_factory=list)

@dataclass
class RecommendationResult:
    recommended: CandidateEvaluation | None
    alternatives: list[CandidateEvaluation]
    confidence: float
    fallbacks: list[str]
    calculation_versions: dict[str, str]
    assumption_version: str

    def to_dict(self) -> dict:
        return asdict(self)
