from __future__ import annotations

from dataclasses import asdict, dataclass
import math

from .aim_planning import AimCalibration


@dataclass(frozen=True)
class AimContext2D:
    forward_yds: float
    right_yds: float


@dataclass(frozen=True)
class AimOffsetVerification:
    requested_offset_yds: float
    achieved_offset_yds: float
    residual_yds: float
    verified: bool

    def to_dict(self) -> dict:
        return asdict(self)


def cross_track_delta_yds(
    baseline: AimContext2D,
    candidate: AimContext2D,
) -> float:
    """Signed candidate displacement perpendicular to the baseline aim vector.

    Coordinates are any consistent 2D yard basis (Looper uses canonical forward/right).
    Positive means candidate moved to the player's right of baseline; negative is left.
    """
    bf = float(baseline.forward_yds)
    br = float(baseline.right_yds)
    length = math.hypot(bf, br)
    if length <= 1e-9:
        raise ValueError("baseline AIM vector is too small for cross-track geometry")
    # Unit vector 90 degrees clockwise/right from baseline direction in a
    # (forward,right) coordinate basis.
    right_f = -br / length
    right_r = bf / length
    df = float(candidate.forward_yds) - bf
    dr = float(candidate.right_yds) - br
    return df * right_f + dr * right_r


def calibration_from_contexts(
    *,
    baseline: AimContext2D,
    sampled: AimContext2D,
    pulse_ms: float,
    confidence: float,
) -> AimCalibration:
    if pulse_ms <= 0:
        raise ValueError("AIM calibration pulse must be positive")
    observed = cross_track_delta_yds(baseline, sampled)
    return AimCalibration(
        sample_pulse_ms=float(pulse_ms),
        observed_cross_track_yds=float(observed),
        confidence=max(0.0, min(1.0, float(confidence))),
    )


def verify_requested_offset(
    *,
    baseline: AimContext2D,
    achieved: AimContext2D,
    requested_offset_yds: float,
    tolerance_yds: float,
) -> AimOffsetVerification:
    achieved_offset = cross_track_delta_yds(baseline, achieved)
    residual = float(achieved_offset) - float(requested_offset_yds)
    return AimOffsetVerification(
        requested_offset_yds=float(requested_offset_yds),
        achieved_offset_yds=float(achieved_offset),
        residual_yds=float(residual),
        verified=abs(residual) <= float(tolerance_yds),
    )
