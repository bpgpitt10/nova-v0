from __future__ import annotations
import json
from pathlib import Path

from .models import (
    ClubProfile,
    GreenSurface,
    HazardBoundary,
    LiveShotState,
    PointYards,
)


def club_profiles_from_payload(rows: list[dict]) -> list[ClubProfile]:
    profiles: list[ClubProfile] = []
    for row in rows:
        carry = row.get("stock_carry_yds")
        club = row.get("club")
        if club is None or carry is None:
            continue
        profiles.append(ClubProfile(
            club=str(club),
            stock_carry_yds=float(carry),
            carry_sigma_yds=(float(row["carry_sigma_yds"]) if row.get("carry_sigma_yds") is not None else None),
            lateral_bias_yds=float(row.get("lateral_bias_yds") or 0.0),
            lateral_sigma_yds=(float(row["lateral_sigma_yds"]) if row.get("lateral_sigma_yds") is not None else None),
            pure_carry_yds=(float(row["pure_carry_yds"]) if row.get("pure_carry_yds") is not None else None),
            explicit_variants=list(row.get("explicit_variants") or []),
        ))
    return profiles


def _point(row: dict, origin_forward: float = 0.0, origin_right: float = 0.0) -> PointYards:
    return PointYards(
        forward=float(row["forward"]) - float(origin_forward),
        right=float(row["right"]) - float(origin_right),
    )


def current_context_from_canonical(
    canonical_hole: dict,
    *,
    current_ball_forward_yds: float,
    current_ball_right_yds: float,
) -> tuple[list[HazardBoundary], GreenSurface | None]:
    hazards = []
    for row in canonical_hole.get("hazards") or []:
        points = [
            _point(point, current_ball_forward_yds, current_ball_right_yds)
            for point in row.get("points") or []
        ]
        if len(points) < 2:
            continue
        hazards.append(HazardBoundary(
            hazard_id=str(row.get("hazard_id") or f"penalty-{len(hazards)+1}"),
            points=points,
            source=str(row.get("source") or "gspro-red-penalty-boundary"),
            side_semantics_known=bool(row.get("side_semantics_known", False)),
        ))

    green_row = canonical_hole.get("green_surface") or {}
    polygon = [
        _point(point, current_ball_forward_yds, current_ball_right_yds)
        for point in green_row.get("polygon") or []
    ]
    pin_row = green_row.get("pin")
    green = None
    if len(polygon) >= 3 and pin_row:
        green = GreenSurface(
            polygon=polygon,
            pin=_point(pin_row, current_ball_forward_yds, current_ball_right_yds),
            heatmap_samples=list(green_row.get("heatmap_samples") or []),
            confidence=float(green_row.get("confidence") or 0.0),
            source=str(green_row.get("source") or "gspro-tee-heatmap"),
        )
    return hazards, green


def live_state_from_probe(
    shot_state: dict,
    canonical_hole: dict,
    *,
    mode: str,
    external_carry_adjustment_yds: float = 0.0,
    external_lateral_adjustment_yds: float = 0.0,
) -> tuple[LiveShotState, list[HazardBoundary], GreenSurface | None]:
    geometry = shot_state.get("canonical_geometry") or {}
    position = geometry.get("canonical_position") or {}
    ball_forward = float(position.get("tee_relative_forward_yds") or 0.0)
    ball_right = float(position.get("tee_relative_lateral_yds") or 0.0)
    hazards, green = current_context_from_canonical(
        canonical_hole,
        current_ball_forward_yds=ball_forward,
        current_ball_right_yds=ball_right,
    )

    pin = shot_state.get("pin") or {}
    lie = shot_state.get("lie_slope") or {}
    registration = geometry.get("registration") or {}
    crosscheck = geometry.get("pin_distance_crosscheck") or {}

    pin_forward = green.pin.forward if green is not None else None
    pin_right = green.pin.right if green is not None else 0.0
    aim_context = shot_state.get("aim_context") or {}

    state = LiveShotState(
        mode=mode,  # type: ignore[arg-type]
        pin_distance_yds=float(pin.get("distance_yds") or 0.0),
        pin_elevation_delta_yds=float(pin.get("elevation_delta_yds") or 0.0),
        pin_forward_yds=pin_forward,
        pin_right_yds=pin_right,
        gspro_aim_forward_yds=(float(aim_context["forward_yds"]) if aim_context.get("forward_yds") is not None else None),
        gspro_aim_right_yds=(float(aim_context["right_yds"]) if aim_context.get("right_yds") is not None else None),
        external_carry_adjustment_yds=float(external_carry_adjustment_yds),
        external_lateral_adjustment_yds=float(external_lateral_adjustment_yds),
        lie_up_down_deg=(float(lie.get("signed_up_down_deg")) if lie.get("signed_up_down_deg") is not None else None),
        lie_left_right_deg=(float(lie.get("signed_left_right_deg")) if lie.get("signed_left_right_deg") is not None else None),
        registration_confidence=(float(registration.get("confidence")) if registration.get("confidence") is not None else None),
        pin_crosscheck_error_yds=(float(crosscheck.get("error_yds")) if crosscheck.get("error_yds") is not None else None),
    )
    return state, hazards, green


def load_json(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
