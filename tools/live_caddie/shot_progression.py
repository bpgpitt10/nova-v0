from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any


@dataclass(frozen=True)
class ShotProgressionInputs:
    previous_identity: dict[str, Any] | None
    current_identity: dict[str, Any] | None
    previous_screen_shot_number: int | None = None
    current_screen_shot_number: int | None = None
    previous_distance_to_pin_yds: float | None = None
    current_distance_to_pin_yds: float | None = None


@dataclass(frozen=True)
class ShotProgressionDecision:
    event: str
    shot_advanced: bool
    hole_changed: bool
    previous_shot_number: int | None
    current_shot_number: int | None
    distance_change_yds: float | None
    confidence: float
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


def _normalize_course(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(re.findall(r"[a-z0-9]+", str(value).lower().replace("&", " and ")))


def _identity_parts(identity: dict[str, Any] | None) -> tuple[str, int | None]:
    if not identity:
        return "", None
    course = _normalize_course(identity.get("course_name"))
    try:
        hole = int(identity.get("hole_number")) if identity.get("hole_number") is not None else None
    except (TypeError, ValueError):
        hole = None
    return course, hole


def _hole_changed(previous: dict[str, Any] | None, current: dict[str, Any] | None) -> bool:
    previous_course, previous_hole = _identity_parts(previous)
    current_course, current_hole = _identity_parts(current)
    if previous_hole is None or current_hole is None:
        return False
    if previous_course and current_course and previous_course != current_course:
        return True
    return previous_hole != current_hole


def infer_shot_progression(inputs: ShotProgressionInputs) -> ShotProgressionDecision:
    """Interpret the future upper-left GSPro shot counter without mutating lifecycle.

    This deliberately stays independent of OCR coordinates. Once non-practice-mode
    screenshots arrive, an adapter only needs to populate the two shot-number fields.
    The progression semantics remain stable and testable here.
    """

    changed = _hole_changed(inputs.previous_identity, inputs.current_identity)
    previous = inputs.previous_screen_shot_number
    current = inputs.current_screen_shot_number
    distance_change = None
    if inputs.previous_distance_to_pin_yds is not None and inputs.current_distance_to_pin_yds is not None:
        distance_change = float(inputs.current_distance_to_pin_yds) - float(inputs.previous_distance_to_pin_yds)

    if changed:
        return ShotProgressionDecision(
            event="hole-changed",
            shot_advanced=False,
            hole_changed=True,
            previous_shot_number=previous,
            current_shot_number=current,
            distance_change_yds=distance_change,
            confidence=1.0,
            detail="course/hole identity changed; shot-counter reset is interpreted in the new-hole lifecycle",
        )

    if previous is None or current is None:
        return ShotProgressionDecision(
            event="counter-unavailable",
            shot_advanced=False,
            hole_changed=False,
            previous_shot_number=previous,
            current_shot_number=current,
            distance_change_yds=distance_change,
            confidence=0.0,
            detail="upper-left shot counter is unavailable on one or both observations",
        )

    previous = int(previous)
    current = int(current)
    delta = current - previous
    if delta == 1:
        return ShotProgressionDecision(
            event="shot-advanced",
            shot_advanced=True,
            hole_changed=False,
            previous_shot_number=previous,
            current_shot_number=current,
            distance_change_yds=distance_change,
            confidence=1.0,
            detail=f"GSPro shot counter advanced {previous} -> {current}",
        )
    if delta == 0:
        return ShotProgressionDecision(
            event="unchanged",
            shot_advanced=False,
            hole_changed=False,
            previous_shot_number=previous,
            current_shot_number=current,
            distance_change_yds=distance_change,
            confidence=1.0,
            detail=f"GSPro shot counter remains {current}",
        )
    if delta < 0:
        return ShotProgressionDecision(
            event="counter-reset-or-mulligan",
            shot_advanced=False,
            hole_changed=False,
            previous_shot_number=previous,
            current_shot_number=current,
            distance_change_yds=distance_change,
            confidence=0.85,
            detail=f"GSPro shot counter moved backward {previous} -> {current}; treat as reset/mulligan until corroborated",
        )
    return ShotProgressionDecision(
        event="counter-jump",
        shot_advanced=False,
        hole_changed=False,
        previous_shot_number=previous,
        current_shot_number=current,
        distance_change_yds=distance_change,
        confidence=0.6,
        detail=f"GSPro shot counter jumped {previous} -> {current}; do not silently invent missed shot events",
    )
