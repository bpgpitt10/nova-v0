from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any

from .assumptions import Assumptions


@dataclass(frozen=True)
class TeeStateInputs:
    """Evidence available before a GSPro shot.

    `screen_shot_number` and `screen_distance_to_pin_yds` intentionally exist now
    even though the upper-left OCR adapter is not built yet.  When those screenshots
    arrive, the screen reader can populate these fields without changing tee-state
    math or lifecycle behavior.
    """

    current_identity: dict[str, Any] | None = None
    previous_identity: dict[str, Any] | None = None
    screen_shot_number: int | None = None
    screen_distance_to_pin_yds: float | None = None
    pin_card_distance_to_pin_yds: float | None = None
    shots_recorded_on_current_hole: int = 0
    previous_hole_terminal: bool | None = None
    flat_lie: bool | None = None
    full_hole_minimap: bool | None = None


@dataclass(frozen=True)
class TeeEvidenceItem:
    key: str
    present: bool
    weight: float
    detail: str


@dataclass(frozen=True)
class TeeStateDecision:
    status: str
    should_capture_tee: bool
    confidence: float
    anchor_present: bool
    hole_changed: bool
    current_identity_valid: bool
    distance_matches_hole: bool | None
    distance_error_yds: float | None
    distance_source: str | None
    hard_contradictions: tuple[str, ...]
    evidence: tuple[TeeEvidenceItem, ...]
    assumption_version: str

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["hard_contradictions"] = list(self.hard_contradictions)
        payload["evidence"] = [asdict(item) for item in self.evidence]
        return payload


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
    if hole is not None and not (1 <= hole <= 18):
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


def _distance_evidence(inputs: TeeStateInputs, cfg: dict[str, Any]) -> tuple[bool | None, float | None, str | None, str]:
    identity = inputs.current_identity or {}
    try:
        hole_yards = float(identity.get("hole_yards")) if identity.get("hole_yards") is not None else None
    except (TypeError, ValueError):
        hole_yards = None
    if hole_yards is None or hole_yards <= 0:
        return None, None, None, "displayed hole yardage unavailable"

    source = None
    observed = None
    if inputs.screen_distance_to_pin_yds is not None:
        observed = float(inputs.screen_distance_to_pin_yds)
        source = "upper-left-distance-to-pin"
    elif inputs.pin_card_distance_to_pin_yds is not None:
        observed = float(inputs.pin_card_distance_to_pin_yds)
        source = "pin-card-distance-to-pin"

    if observed is None:
        return None, None, None, "current distance-to-pin unavailable"

    error = observed - hole_yards
    tolerance = max(
        float(cfg["distance_absolute_tolerance_yds"]),
        abs(hole_yards) * float(cfg["distance_relative_tolerance_fraction"]),
    )
    matches = abs(error) <= tolerance
    return matches, error, source, (
        f"{observed:.1f} yd current DTP vs {hole_yards:.1f} yd displayed hole length "
        f"(error {error:+.1f}, tolerance {tolerance:.1f})"
    )


def infer_tee_state(
    inputs: TeeStateInputs,
    assumptions: Assumptions | None = None,
) -> TeeStateDecision:
    """Infer whether the current GSPro pre-shot state is a new-hole tee.

    This is deliberately a pure calculation.  It never captures the screen, presses
    keys, or mutates lifecycle state.  Screen/log adapters provide evidence; this
    function only combines that evidence using externally configured weights.
    """

    assumptions = assumptions or Assumptions.load()
    cfg = assumptions.get("tee_state")

    current_course, current_hole = _identity_parts(inputs.current_identity)
    current_identity_valid = bool(current_course and current_hole is not None)
    changed = _hole_changed(inputs.previous_identity, inputs.current_identity)
    shot_one = inputs.screen_shot_number == 1
    no_recorded_shots = int(inputs.shots_recorded_on_current_hole) == 0

    contradictions: list[str] = []
    if bool(cfg["shot_number_gt_one_is_hard_contradiction"]):
        if inputs.screen_shot_number is not None and int(inputs.screen_shot_number) > 1:
            contradictions.append(f"upper-left shot number is {int(inputs.screen_shot_number)}, not 1")
    if bool(cfg["recorded_shots_is_hard_contradiction"]):
        if int(inputs.shots_recorded_on_current_hole) > 0:
            contradictions.append(
                f"Looper already recorded {int(inputs.shots_recorded_on_current_hole)} shot(s) on this hole"
            )

    distance_match, distance_error, distance_source, distance_detail = _distance_evidence(inputs, cfg)

    evidence = (
        TeeEvidenceItem(
            "current_identity_valid",
            current_identity_valid,
            float(cfg["current_identity_valid_weight"]),
            f"current header identifies {current_course or '?'} hole {current_hole or '?'}",
        ),
        TeeEvidenceItem(
            "hole_changed",
            changed,
            float(cfg["hole_change_weight"]),
            "upper-right course/hole identity changed from the previous playable state",
        ),
        TeeEvidenceItem(
            "shot_number_one",
            shot_one,
            float(cfg["shot_number_one_weight"]),
            (
                "future upper-left shot counter reads 1"
                if inputs.screen_shot_number is not None
                else "upper-left shot counter not yet available"
            ),
        ),
        TeeEvidenceItem(
            "no_recorded_shots",
            no_recorded_shots,
            float(cfg["no_recorded_shots_weight"]),
            f"Looper has recorded {int(inputs.shots_recorded_on_current_hole)} shots on current hole",
        ),
        TeeEvidenceItem(
            "distance_matches_hole",
            distance_match is True,
            float(cfg["distance_matches_hole_weight"]),
            distance_detail,
        ),
        TeeEvidenceItem(
            "previous_hole_terminal",
            inputs.previous_hole_terminal is True,
            float(cfg["previous_hole_terminal_weight"]),
            (
                "previous hole had a made/gimme/terminal signal"
                if inputs.previous_hole_terminal is not None
                else "previous-hole terminal signal unavailable"
            ),
        ),
        TeeEvidenceItem(
            "flat_lie",
            inputs.flat_lie is True,
            float(cfg["flat_lie_weight"]),
            "GSPro lie is 0.0 / 0.0" if inputs.flat_lie is not None else "lie evidence unavailable",
        ),
        TeeEvidenceItem(
            "full_hole_minimap",
            inputs.full_hole_minimap is True,
            float(cfg["full_hole_minimap_weight"]),
            (
                "minimap appears to show the full hole"
                if inputs.full_hole_minimap is not None
                else "full-hole minimap evidence unavailable"
            ),
        ),
    )

    score = min(1.0, sum(item.weight for item in evidence if item.present))
    anchor_present = bool(changed or shot_one)

    if contradictions:
        status = "not-tee"
        should_capture = False
        score = 0.0
    else:
        confirmed_threshold = float(cfg["minimum_confirmed_confidence"])
        probable_threshold = float(cfg["minimum_probable_confidence"])
        anchor_required = bool(cfg["require_transition_or_shot_one_anchor"])
        confirmed = score >= confirmed_threshold and (anchor_present or not anchor_required)
        if confirmed:
            status = "confirmed"
            should_capture = True
        elif score >= probable_threshold:
            status = "probable"
            should_capture = False
        else:
            status = "not-tee"
            should_capture = False

    return TeeStateDecision(
        status=status,
        should_capture_tee=should_capture,
        confidence=round(float(score), 4),
        anchor_present=anchor_present,
        hole_changed=changed,
        current_identity_valid=current_identity_valid,
        distance_matches_hole=distance_match,
        distance_error_yds=distance_error,
        distance_source=distance_source,
        hard_contradictions=tuple(contradictions),
        evidence=evidence,
        assumption_version=assumptions.version,
    )
