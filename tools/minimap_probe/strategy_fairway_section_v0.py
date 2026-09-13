#!/usr/bin/env python3
"""Geometry-only fairway cross sections for Looper strategy experiments.

Given trusted screenshot->hole-local transform geometry and a shadow fairway
polygon, this module asks one narrow question:

    At a supplied forward landing distance, what lateral fairway spans exist?

It does NOT select a club, rank targets, compensate shot bias, or recommend an
aim point. The widest cross-section is exposed as a convenient primary geometry
span for comparison/rendering only; it has no strategy authority.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-strategy-fairway-section-v0"


def _finite(value: Any, name: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite")
    return out


def clamp01(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except Exception:
        return None
    if not math.isfinite(out):
        return None
    return max(0.0, min(1.0, out))


def fairway_polygon_pixel(payload: dict[str, Any]) -> list[list[float]]:
    if not bool(payload.get("fairway_present")):
        return []
    fairway = payload.get("fairway") or {}
    raw = fairway.get("polygon_minimap_pixel") or fairway.get("polygon_pixel") or []
    out: list[list[float]] = []
    for point in raw:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            return []
        try:
            x, y = float(point[0]), float(point[1])
        except Exception:
            return []
        if not math.isfinite(x) or not math.isfinite(y):
            return []
        out.append([x, y])
    return out if len(out) >= 3 else []


def polygon_to_local(
    geometry_payload: dict[str, Any],
    polygon_pixel: list[list[float]],
) -> list[list[float]]:
    transform = geometry_payload.get("coordinate_transform") or {}
    return [
        list(risk.pixel_to_local(transform, point[0], point[1]))
        for point in polygon_pixel
    ]


def lateral_spans_at_forward(
    polygon_local: list[list[float]],
    forward_yds: float,
) -> list[list[float]]:
    """Even/odd polygon intersections with a constant-forward cross section.

    Returns sorted [left_lateral, right_lateral] intervals in hole-local yards.
    A concave polygon can legitimately produce multiple spans.
    """
    y = _finite(forward_yds, "forward_yds")
    if len(polygon_local) < 3:
        return []
    intersections: list[float] = []
    for index, a in enumerate(polygon_local):
        b = polygon_local[(index + 1) % len(polygon_local)]
        x1, y1 = _finite(a[0], "polygon lateral"), _finite(a[1], "polygon forward")
        x2, y2 = _finite(b[0], "polygon lateral"), _finite(b[1], "polygon forward")
        # Half-open crossing rule prevents double-counting polygon vertices.
        if (y1 > y) == (y2 > y):
            continue
        x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        intersections.append(x)
    intersections.sort()
    if len(intersections) < 2:
        return []
    # Numerical/touching degeneracies can make the count odd. Drop the final
    # unmatched point rather than inventing a span.
    if len(intersections) % 2:
        intersections = intersections[:-1]
    spans = []
    for index in range(0, len(intersections), 2):
        left, right = intersections[index], intersections[index + 1]
        if right - left > 1e-6:
            spans.append([left, right])
    return spans


def section(
    geometry_payload: dict[str, Any],
    fairway_payload: dict[str, Any],
    *,
    forward_yds: float,
) -> dict[str, Any]:
    forward = _finite(forward_yds, "forward_yds")
    polygon_pixel = fairway_polygon_pixel(fairway_payload)
    if not polygon_pixel:
        return {
            "schema_version": SCHEMA_VERSION,
            "available": False,
            "forward_yds": forward,
            "reason": "fairway polygon unavailable",
            "spans": [],
            "primary_span": None,
            "strategy_authority": False,
        }
    polygon_local = polygon_to_local(geometry_payload, polygon_pixel)
    spans = lateral_spans_at_forward(polygon_local, forward)
    fairway = fairway_payload.get("fairway") or {}
    if not spans:
        return {
            "schema_version": SCHEMA_VERSION,
            "available": False,
            "forward_yds": forward,
            "reason": "supplied forward distance does not intersect extracted fairway polygon",
            "spans": [],
            "primary_span": None,
            "fairway_semantic_confidence": clamp01(fairway.get("semantic_confidence")),
            "fairway_segmentation_quality_score": fairway.get("segmentation_quality_score"),
            "strategy_authority": False,
        }

    span_rows = [
        {
            "left_lateral_yds": left,
            "right_lateral_yds": right,
            "width_yds": right - left,
            "center_lateral_yds": (left + right) / 2.0,
        }
        for left, right in spans
    ]
    primary_index = max(range(len(span_rows)), key=lambda i: span_rows[i]["width_yds"])
    return {
        "schema_version": SCHEMA_VERSION,
        "available": True,
        "forward_yds": forward,
        "spans": span_rows,
        "primary_span_index": primary_index,
        "primary_span": span_rows[primary_index],
        "primary_rule": "widest polygon cross-section at supplied forward distance; geometry convenience only",
        "fairway_semantic_confidence": clamp01(fairway.get("semantic_confidence")),
        "fairway_segmentation_quality_score": fairway.get("segmentation_quality_score"),
        "fairway_topology": fairway.get("topology"),
        "strategy_authority": False,
        "recommendation": None,
    }


def comparison_centers(
    section_payload: dict[str, Any],
    *,
    step_yds: float = 10.0,
) -> list[dict[str, Any]]:
    """Return center/left/right geometry probes constrained to the primary span."""
    primary = section_payload.get("primary_span") or {}
    if not section_payload.get("available") or not primary:
        return []
    left = _finite(primary.get("left_lateral_yds"), "left_lateral_yds")
    right = _finite(primary.get("right_lateral_yds"), "right_lateral_yds")
    center = _finite(primary.get("center_lateral_yds"), "center_lateral_yds")
    step = abs(_finite(step_yds, "step_yds"))
    values = [max(left, center - step), center, min(right, center + step)]
    labels = ["fairway-left-comparison", "fairway-center", "fairway-right-comparison"]
    rows = []
    seen = set()
    for label, lateral in zip(labels, values):
        key = round(lateral, 8)
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "label": label,
            "lateral_yds": lateral,
            "forward_yds": _finite(section_payload.get("forward_yds"), "forward_yds"),
            "recommendation": None,
            "strategy_authority": False,
        })
    return rows


def load_fairway(capture: Path) -> dict[str, Any] | None:
    path = capture.expanduser().resolve() / "fairway_surface_shadow_v0.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8-sig"))
