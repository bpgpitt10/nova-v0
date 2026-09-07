#!/usr/bin/env python3
"""Determine whether the cached target green should fit in the current GSPro minimap."""

from __future__ import annotations

from dataclasses import dataclass, asdict
import json
from pathlib import Path


@dataclass
class GreenExtentsYards:
    left: float
    right: float
    top: float
    bottom: float


@dataclass
class GreenVisibilityResult:
    visible: bool
    reason: str
    current_yards_per_pixel: float
    projected_bbox_px: tuple[float, float, float, float]
    content_bbox_px: tuple[float, float, float, float]
    green_extents_yds: GreenExtentsYards
    minimum_clearance_px: float

    def to_dict(self) -> dict:
        d = asdict(self)
        d["projected_bbox_px"] = list(self.projected_bbox_px)
        d["content_bbox_px"] = list(self.content_bbox_px)
        return d


def _default_config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["screen_detection"]["green_visibility"]


def extents_from_hole_model(hole_model: dict) -> GreenExtentsYards:
    minimap = hole_model.get("minimap") or {}
    green = hole_model.get("green_surface") or {}
    pin = minimap.get("pin_pixel") or {}
    bbox = green.get("target_green_bbox")
    scale = float(minimap.get("yards_per_pixel") or 0.0)

    if not bbox or len(bbox) != 4 or scale <= 0:
        raise ValueError("HoleModel is missing target green bbox / minimap scale")

    pin_x = float(pin.get("x"))
    pin_y = float(pin.get("y"))
    x, y, w, h = [float(v) for v in bbox]
    x2 = x + w
    y2 = y + h

    return GreenExtentsYards(
        left=max(0.0, (pin_x - x) * scale),
        right=max(0.0, (x2 - pin_x) * scale),
        top=max(0.0, (pin_y - y) * scale),
        bottom=max(0.0, (y2 - pin_y) * scale),
    )


def current_scale_yd_per_px(
    *,
    ball_x: float,
    ball_y: float,
    pin_x: float,
    pin_y: float,
    pin_distance_yds: float,
    detector_config: dict | None = None,
) -> float:
    config = detector_config or _default_config()
    dx = float(pin_x) - float(ball_x)
    dy = float(pin_y) - float(ball_y)
    pixels = (dx * dx + dy * dy) ** 0.5
    if pixels < float(config["min_ball_pin_separation_px"]):
        raise ValueError("Ball/pin separation too small for current minimap scale")
    scale = float(pin_distance_yds) / pixels
    if not (float(config["min_yards_per_pixel"]) <= scale <= float(config["max_yards_per_pixel"])):
        raise ValueError(f"Implausible current minimap scale {scale:.4f} yd/px")
    return scale


def evaluate_visibility(
    *,
    hole_model: dict,
    minimap_width: int,
    minimap_height: int,
    ball_x: float,
    ball_y: float,
    pin_x: float,
    pin_y: float,
    pin_distance_yds: float,
    detector_config: dict | None = None,
    content_top_fraction: float | None = None,
    content_bottom_fraction: float | None = None,
    content_side_inset_px: float | None = None,
    safety_margin_px: float | None = None,
) -> GreenVisibilityResult:
    config = detector_config or _default_config()
    top_fraction = float(config["content_top_fraction"] if content_top_fraction is None else content_top_fraction)
    bottom_fraction = float(config["content_bottom_fraction"] if content_bottom_fraction is None else content_bottom_fraction)
    side_inset = float(config["content_side_inset_px"] if content_side_inset_px is None else content_side_inset_px)
    safety_margin = float(config["safety_margin_px"] if safety_margin_px is None else safety_margin_px)

    ext = extents_from_hole_model(hole_model)
    scale = current_scale_yd_per_px(
        ball_x=ball_x,
        ball_y=ball_y,
        pin_x=pin_x,
        pin_y=pin_y,
        pin_distance_yds=pin_distance_yds,
        detector_config=config,
    )

    left_px = float(pin_x) - ext.left / scale
    right_px = float(pin_x) + ext.right / scale
    top_px = float(pin_y) - ext.top / scale
    bottom_px = float(pin_y) + ext.bottom / scale

    content_left = side_inset
    content_right = float(minimap_width) - side_inset
    content_top = float(minimap_height) * top_fraction
    content_bottom = float(minimap_height) * bottom_fraction

    clearances = (
        left_px - content_left,
        content_right - right_px,
        top_px - content_top,
        content_bottom - bottom_px,
    )
    minimum_clearance = min(clearances)
    visible = minimum_clearance >= safety_margin

    if visible:
        reason = "cached target-green footprint fits inside current minimap viewport"
    else:
        names = ("left", "right", "top", "bottom")
        worst = names[clearances.index(minimum_clearance)]
        reason = f"cached target-green footprint is clipped/too close at {worst} edge"

    return GreenVisibilityResult(
        visible=visible,
        reason=reason,
        current_yards_per_pixel=scale,
        projected_bbox_px=(left_px, top_px, right_px, bottom_px),
        content_bbox_px=(content_left, content_top, content_right, content_bottom),
        green_extents_yds=ext,
        minimum_clearance_px=minimum_clearance,
    )
