from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .assumptions import Assumptions


@dataclass(frozen=True)
class DistanceSourceValue:
    source: str
    value_yds: float | None
    confidence: float | None = None
    available: bool = True


@dataclass(frozen=True)
class SourceDisagreement:
    left_source: str
    right_source: str
    difference_yds: float
    level: str


@dataclass(frozen=True)
class ResolvedDistance:
    value_yds: float | None
    source: str | None
    confidence: float
    status: str
    disagreements: tuple[SourceDisagreement, ...]
    candidates: tuple[DistanceSourceValue, ...]
    assumption_version: str

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["disagreements"] = [asdict(item) for item in self.disagreements]
        payload["candidates"] = [asdict(item) for item in self.candidates]
        return payload


def _threshold(reference: float, *, absolute: float, relative: float) -> float:
    return max(float(absolute), abs(float(reference)) * float(relative))


def resolve_distance_to_pin(
    *,
    upper_left_yds: float | None = None,
    pin_card_yds: float | None = None,
    canonical_yds: float | None = None,
    canonical_registration_confidence: float | None = None,
    assumptions: Assumptions | None = None,
) -> ResolvedDistance:
    """Resolve DTP once for the whole product and expose disagreement explicitly.

    Precedence, confidence and disagreement behavior are all configuration. A lower-
    priority source remains useful as a cross-check. Canonical geometry is only
    eligible when registration confidence meets the configured floor.
    """
    assumptions = assumptions or Assumptions.load()
    cfg = assumptions.get("source_resolution")

    canonical_ok = (
        canonical_yds is not None
        and canonical_registration_confidence is not None
        and float(canonical_registration_confidence) >= float(cfg["canonical_distance_minimum_registration_confidence"])
    )
    values = {
        "upper-left-distance-to-pin": DistanceSourceValue(
            "upper-left-distance-to-pin",
            upper_left_yds,
            float(cfg["upper_left_source_confidence"]) if upper_left_yds is not None else None,
            upper_left_yds is not None,
        ),
        "pin-card-distance-to-pin": DistanceSourceValue(
            "pin-card-distance-to-pin",
            pin_card_yds,
            float(cfg["pin_card_source_confidence"]) if pin_card_yds is not None else None,
            pin_card_yds is not None,
        ),
        "canonical-distance-to-pin": DistanceSourceValue(
            "canonical-distance-to-pin",
            canonical_yds,
            float(canonical_registration_confidence) if canonical_registration_confidence is not None else None,
            canonical_ok,
        ),
    }

    ordered: list[DistanceSourceValue] = []
    for source in cfg["distance_to_pin_precedence"]:
        if source in values:
            ordered.append(values[source])
    already = {item.source for item in ordered}
    for source, value in values.items():
        if source not in already:
            ordered.append(value)

    eligible = [item for item in ordered if item.available and item.value_yds is not None]
    if not eligible:
        return ResolvedDistance(
            value_yds=None,
            source=None,
            confidence=0.0,
            status="unavailable",
            disagreements=(),
            candidates=tuple(ordered),
            assumption_version=assumptions.version,
        )

    selected = eligible[0]
    disagreements: list[SourceDisagreement] = []
    hard = False
    warning = False
    for index, left in enumerate(eligible):
        for right in eligible[index + 1:]:
            difference = abs(float(left.value_yds) - float(right.value_yds))
            reference = max(abs(float(left.value_yds)), abs(float(right.value_yds)), 1.0)
            hard_limit = _threshold(
                reference,
                absolute=float(cfg["distance_hard_conflict_absolute_yds"]),
                relative=float(cfg["distance_hard_conflict_relative_fraction"]),
            )
            warning_limit = _threshold(
                reference,
                absolute=float(cfg["distance_warning_absolute_yds"]),
                relative=float(cfg["distance_warning_relative_fraction"]),
            )
            if difference > hard_limit:
                level = "hard-conflict"
                hard = True
            elif difference > warning_limit:
                level = "warning"
                warning = True
            else:
                level = "agree"
            disagreements.append(SourceDisagreement(left.source, right.source, difference, level))

    base_confidence = float(
        selected.confidence
        if selected.confidence is not None
        else cfg["unrated_source_confidence"]
    )
    if hard:
        status = "hard-conflict"
        confidence = min(base_confidence, float(cfg["hard_conflict_confidence_cap"]))
    elif warning:
        status = "warning"
        confidence = min(base_confidence, float(cfg["warning_confidence_cap"]))
    else:
        status = "resolved"
        confidence = base_confidence

    return ResolvedDistance(
        value_yds=float(selected.value_yds),
        source=selected.source,
        confidence=max(0.0, min(1.0, confidence)),
        status=status,
        disagreements=tuple(disagreements),
        candidates=tuple(ordered),
        assumption_version=assumptions.version,
    )


def resolve_identity(identity: dict[str, Any] | None, assumptions: Assumptions | None = None) -> dict[str, Any]:
    assumptions = assumptions or Assumptions.load()
    cfg = assumptions.get("source_resolution")
    payload = dict(identity or {})
    confidence = float(payload.get("confidence") or 0.0)
    usable = bool(
        payload.get("course_name")
        and payload.get("hole_number") is not None
        and confidence >= float(cfg["identity_minimum_confidence"])
    )
    return {
        "value": payload if usable else None,
        "usable": usable,
        "confidence": confidence,
        "source": payload.get("source") if payload else None,
        "assumption_version": assumptions.version,
    }
