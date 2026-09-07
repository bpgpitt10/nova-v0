from __future__ import annotations
from dataclasses import dataclass, asdict

from .assumptions import Assumptions
from .models import RecommendationResult


@dataclass(frozen=True)
class AimCalibration:
    sample_pulse_ms: float
    observed_cross_track_yds: float
    confidence: float = 1.0

    @property
    def yards_per_ms(self) -> float:
        if self.sample_pulse_ms <= 0:
            return 0.0
        return abs(float(self.observed_cross_track_yds)) / float(self.sample_pulse_ms)


@dataclass
class AimPlan:
    status: str
    requested_offset_yds: float
    direction: str | None
    pulse_duration_ms: float | None
    predicted_offset_yds: float | None
    calibration_yards_per_ms: float | None
    recommendation_confidence: float
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def build_aim_plan(
    recommendation: RecommendationResult,
    *,
    calibration: AimCalibration | None,
    assumptions: Assumptions | None = None,
    automatic_enabled: bool = False,
) -> AimPlan:
    """Translate recommendation cross-track offset into a bounded actuator plan.

    This module never presses keys. It only produces a plan. The actual GSPro
    actuator must re-read AIM after movement and verify the achieved target.
    """
    assumptions = assumptions or Assumptions.load()
    best = recommendation.recommended
    if best is None:
        return AimPlan("blocked", 0.0, None, None, None, None, recommendation.confidence, "no recommendation exists")

    offset = float(best.candidate.aim_offset_yds)
    deadband = float(assumptions.get("actuation.aim_deadband_yds"))
    if abs(offset) <= deadband:
        return AimPlan("no-action", offset, None, 0.0, 0.0, None, recommendation.confidence, "recommended aim is inside configured deadband")

    if not automatic_enabled:
        return AimPlan("blocked", offset, None, None, None, None, recommendation.confidence, "automatic aim is not enabled for this run")

    minimum_confidence = float(assumptions.get("actuation.minimum_confidence"))
    if recommendation.confidence < minimum_confidence:
        return AimPlan("blocked", offset, None, None, None, None, recommendation.confidence, "recommendation confidence is below automatic-aim threshold")

    max_offset = float(assumptions.get("actuation.maximum_automatic_aim_offset_yds"))
    if abs(offset) > max_offset:
        return AimPlan("blocked", offset, None, None, None, None, recommendation.confidence, "requested aim change exceeds automatic-aim safety limit")

    if calibration is None:
        return AimPlan("blocked", offset, None, None, None, None, recommendation.confidence, "same-shot AIM movement calibration is unavailable")
    if calibration.confidence < float(assumptions.get("actuation.minimum_calibration_confidence")):
        return AimPlan("blocked", offset, None, None, None, calibration.yards_per_ms, recommendation.confidence, "AIM movement calibration confidence is too low")

    rate = calibration.yards_per_ms
    min_rate = float(assumptions.get("actuation.minimum_yards_per_ms"))
    max_rate = float(assumptions.get("actuation.maximum_yards_per_ms"))
    if not (min_rate <= rate <= max_rate):
        return AimPlan("blocked", offset, None, None, None, rate, recommendation.confidence, "AIM movement calibration rate is outside configured sanity bounds")

    duration = abs(offset) / rate
    max_duration = float(assumptions.get("actuation.maximum_single_command_ms"))
    if duration > max_duration:
        return AimPlan("blocked", offset, None, None, None, rate, recommendation.confidence, "required key duration exceeds configured single-command limit")

    direction = "RIGHT" if offset > 0 else "LEFT"
    predicted = rate * duration * (1.0 if offset > 0 else -1.0)
    return AimPlan(
        "ready",
        offset,
        direction,
        duration,
        predicted,
        rate,
        recommendation.confidence,
        "plan ready; actuator must verify final AIM from fresh screen state",
    )
