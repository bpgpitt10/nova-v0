from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from .assumptions import Assumptions
from .candidates import base_target_for_state
from .geometry import point_in_polygon, point_polyline_distance, point_segment_distance, unit_and_cross
from .models import GreenSurface, HazardBoundary, LiveShotState, PointYards

PreferredSide = Literal["left", "center", "right", "unknown"]


@dataclass(frozen=True)
class ShortGameGuidance:
    guidance_type: str
    target_distance_yds: float
    modeled_club_available: bool
    preferred_side: PreferredSide
    suggested_safe_offset_yds: float | None
    green_room_left_yds: float | None
    green_room_right_yds: float | None
    selected_green_edge_clearance_yds: float | None
    selected_hazard_boundary_clearance_yds: float | None
    green_context_available: bool
    hazard_context_available: bool
    confidence: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _polygon_boundary_distance(point: PointYards, polygon: list[PointYards]) -> float | None:
    if len(polygon) < 3:
        return None
    return min(
        point_segment_distance(point, polygon[i], polygon[(i + 1) % len(polygon)])
        for i in range(len(polygon))
    )


def _cross(a: PointYards, b: PointYards) -> float:
    return a.forward * b.right - a.right * b.forward


def _ray_polygon_distance(origin: PointYards, direction: PointYards, polygon: list[PointYards]) -> float | None:
    if len(polygon) < 3:
        return None
    best: float | None = None
    for i in range(len(polygon)):
        a = polygon[i]
        b = polygon[(i + 1) % len(polygon)]
        segment = PointYards(b.forward - a.forward, b.right - a.right)
        denom = _cross(direction, segment)
        if abs(denom) <= 1e-9:
            continue
        delta = PointYards(a.forward - origin.forward, a.right - origin.right)
        t = _cross(delta, segment) / denom
        u = _cross(delta, direction) / denom
        if t >= -1e-9 and -1e-9 <= u <= 1.0 + 1e-9:
            distance = max(0.0, t)
            if best is None or distance < best:
                best = distance
    return best


def _minimum_hazard_clearance(point: PointYards, hazards: list[HazardBoundary]) -> float | None:
    distances = [
        distance
        for hazard in hazards
        if (distance := point_polyline_distance(point, hazard.points)) is not None
    ]
    return min(distances) if distances else None


def _guidance_confidence(green: GreenSurface | None, hazards: list[HazardBoundary], assumptions: Assumptions) -> float:
    if green is not None and hazards:
        base = float(assumptions.get("short_game.confidence_green_and_hazard"))
    elif green is not None:
        base = float(assumptions.get("short_game.confidence_green_only"))
    elif hazards:
        base = float(assumptions.get("short_game.confidence_hazard_only"))
    else:
        return float(assumptions.get("short_game.confidence_no_geometry"))
    if green is not None and green.confidence > 0:
        base *= max(0.45, min(1.0, float(green.confidence)))
    return max(0.0, min(1.0, base))


def build_short_game_guidance(
    state: LiveShotState,
    hazards: list[HazardBoundary],
    green: GreenSurface | None,
    assumptions: Assumptions,
    *,
    target_distance_yds: float,
) -> ShortGameGuidance:
    """Provide geometry-only short-game perspective without inventing shot physics.

    Red penalty lines currently encode authoritative boundaries but not a usable
    oriented "penalty is on this side" value. Therefore a bare hazard boundary cannot
    decide left-versus-right safety: moving farther from a line could otherwise move
    deeper into the penalty area. When a known green exists, however, candidate points
    are constrained to remain inside that green (known safe terrain), so penalty-line
    clearance can safely help rank those green-side targets.
    """
    base_target = green.pin if green is not None else base_target_for_state(state)
    _, cross = unit_and_cross(base_target)

    # Until HazardBoundary carries actual oriented side semantics, hazards are only
    # directionally usable in conjunction with known-safe green containment.
    usable_hazards = list(hazards) if green is not None else []
    ignored_unknown_side_hazards = len(hazards) - len(usable_hazards)

    green_room_left = green_room_right = None
    if green is not None and point_in_polygon(green.pin, green.polygon):
        green_room_right = _ray_polygon_distance(green.pin, cross, green.polygon)
        green_room_left = _ray_polygon_distance(
            green.pin,
            PointYards(-cross.forward, -cross.right),
            green.polygon,
        )

    offsets = [float(value) for value in assumptions.get("short_game.geometry_aim_offsets_yds")]
    green_reference = max(1e-6, float(assumptions.get("short_game.green_clearance_reference_yds")))
    hazard_reference = max(1e-6, float(assumptions.get("short_game.hazard_clearance_reference_yds")))
    aim_reference = max(1e-6, float(assumptions.get("short_game.aim_offset_reference_yds")))
    weights = assumptions.get("short_game.geometry_scoring")

    rows: list[dict] = []
    for offset in offsets:
        point = PointYards(
            base_target.forward + cross.forward * offset,
            base_target.right + cross.right * offset,
        )
        inside = point_in_polygon(point, green.polygon) if green is not None else None
        if green is not None and inside is False:
            continue

        green_clearance = _polygon_boundary_distance(point, green.polygon) if green is not None else None
        hazard_clearance = _minimum_hazard_clearance(point, usable_hazards)
        green_score = min(1.0, float(green_clearance) / green_reference) if green_clearance is not None else 0.0
        hazard_score = min(1.0, float(hazard_clearance) / hazard_reference) if hazard_clearance is not None else 0.0
        aim_cost = min(1.0, abs(offset) / aim_reference)

        available_weight = 0.0
        total = 0.0
        if green is not None:
            w = float(weights["green_clearance_weight"])
            total += w * green_score
            available_weight += w
        if usable_hazards:
            w = float(weights["hazard_clearance_weight"])
            total += w * hazard_score
            available_weight += w
        w = float(weights["aim_change_weight"])
        total -= w * aim_cost
        available_weight += w
        rows.append({
            "offset": offset,
            "score": total / max(available_weight, 1e-6),
            "green_clearance": green_clearance,
            "hazard_clearance": hazard_clearance,
        })

    notes = [
        "No modeled carry/dispersion is used because the shot is shorter than Looper's supported Stock/Smooth/explicit-variant coverage."
    ]
    if ignored_unknown_side_hazards:
        notes.append(
            f"Ignored {ignored_unknown_side_hazards} bare penalty boundary/boundaries for directional advice because current hazard geometry does not encode which side is penalty."
        )

    if green is None:
        notes.append("No known-safe green geometry is available, so Looper cannot offer a reliable left/right safe-side perspective for this unmodeled partial shot.")
        return ShortGameGuidance(
            guidance_type="geometry-only-short-game",
            target_distance_yds=float(target_distance_yds),
            modeled_club_available=False,
            preferred_side="unknown",
            suggested_safe_offset_yds=None,
            green_room_left_yds=None,
            green_room_right_yds=None,
            selected_green_edge_clearance_yds=None,
            selected_hazard_boundary_clearance_yds=None,
            green_context_available=False,
            hazard_context_available=False,
            confidence=_guidance_confidence(None, [], assumptions),
            notes=notes,
        )

    if not rows:
        notes.append("Known green geometry did not produce a valid target offset; preserve the current target rather than inventing one.")
        return ShortGameGuidance(
            guidance_type="geometry-only-short-game",
            target_distance_yds=float(target_distance_yds),
            modeled_club_available=False,
            preferred_side="center",
            suggested_safe_offset_yds=0.0,
            green_room_left_yds=green_room_left,
            green_room_right_yds=green_room_right,
            selected_green_edge_clearance_yds=None,
            selected_hazard_boundary_clearance_yds=_minimum_hazard_clearance(base_target, usable_hazards),
            green_context_available=True,
            hazard_context_available=bool(usable_hazards),
            confidence=_guidance_confidence(green, usable_hazards, assumptions),
            notes=notes,
        )

    rows.sort(key=lambda row: (row["score"], -abs(row["offset"])), reverse=True)
    best = rows[0]
    center = min(rows, key=lambda row: abs(row["offset"]))
    advantage = float(best["score"]) - float(center["score"])
    minimum_advantage = float(assumptions.get("short_game.minimum_side_advantage_score"))
    if abs(float(best["offset"])) > 1e-9 and advantage < minimum_advantage:
        best = center

    offset = float(best["offset"])
    side: PreferredSide = "center"
    if offset < -1e-9:
        side = "left"
    elif offset > 1e-9:
        side = "right"

    if green_room_left is not None and green_room_right is not None:
        notes.append(
            f"Green room from the pin is approximately {green_room_left:.1f} yd left and {green_room_right:.1f} yd right."
        )
    if best["hazard_clearance"] is not None:
        notes.append(
            f"The selected point remains on the known green and is about {float(best['hazard_clearance']):.1f} yd from the nearest mapped penalty boundary."
        )
    if side == "center":
        notes.append("Available geometry does not justify moving materially away from the current target.")
    else:
        notes.append(f"Favor the {side} side of the target for the safer known-green geometry; this is not an automatic-aim instruction.")

    return ShortGameGuidance(
        guidance_type="geometry-only-short-game",
        target_distance_yds=float(target_distance_yds),
        modeled_club_available=False,
        preferred_side=side,
        suggested_safe_offset_yds=offset,
        green_room_left_yds=green_room_left,
        green_room_right_yds=green_room_right,
        selected_green_edge_clearance_yds=(float(best["green_clearance"]) if best["green_clearance"] is not None else None),
        selected_hazard_boundary_clearance_yds=(float(best["hazard_clearance"]) if best["hazard_clearance"] is not None else None),
        green_context_available=True,
        hazard_context_available=bool(usable_hazards),
        confidence=_guidance_confidence(green, usable_hazards, assumptions),
        notes=notes,
    )
