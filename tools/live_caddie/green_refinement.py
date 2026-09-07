from __future__ import annotations
import copy
import math
from dataclasses import dataclass, asdict
from pathlib import Path
import sys

import cv2
import numpy as np

from .assumptions import Assumptions

MINIMAP_DIR = Path(__file__).resolve().parents[1] / "minimap_probe"
if str(MINIMAP_DIR) not in sys.path:
    sys.path.insert(0, str(MINIMAP_DIR))
import minimap_registration  # noqa: E402


@dataclass
class GreenRefinement:
    polygon: list[dict]
    pin: dict
    heatmap_samples: list[dict]
    confidence: float
    registration_confidence: float
    heatmap_confidence: float
    pin_alignment_error_yds: float
    source_area_px: int
    source: str = "gspro-approach-heatmap-refinement"

    def to_dict(self) -> dict:
        return asdict(self)


def _tee_axis(tee_hole_model: dict):
    minimap = tee_hole_model.get("minimap") or {}
    ball = minimap.get("ball_pixel") or {}
    pin = minimap.get("pin_pixel") or {}
    tee = np.array([float(ball["x"]), float(ball["y"])], dtype=float)
    target = np.array([float(pin["x"]), float(pin["y"])], dtype=float)
    scale = float(minimap.get("yards_per_pixel") or 0.0)
    axis = target - tee
    length = float(np.linalg.norm(axis))
    if length < 10 or scale <= 0:
        raise ValueError("invalid tee HoleModel axis/scale")
    forward = axis / length
    right = np.array([-forward[1], forward[0]], dtype=float)
    return tee, forward, right, scale


def _canonical_pixel_to_yards(tee_hole_model: dict, x: float, y: float) -> dict:
    tee, forward, right, scale = _tee_axis(tee_hole_model)
    delta = np.array([float(x), float(y)], dtype=float) - tee
    return {
        "forward": float(np.dot(delta, forward) * scale),
        "right": float(np.dot(delta, right) * scale),
    }


def _current_to_yards(tee_hole_model: dict, registration_matrix, x: float, y: float) -> dict:
    cx, cy = minimap_registration.transform_point(registration_matrix, x, y)
    return _canonical_pixel_to_yards(tee_hole_model, cx, cy)


def build_refinement(
    *,
    tee_hole_model: dict,
    canonical_hole: dict,
    current_green_mask,
    current_heatmap,
    current_pin_xy: tuple[float, float],
    registration_matrix,
    registration_confidence: float,
    heatmap_confidence: float,
    assumptions: Assumptions | None = None,
) -> GreenRefinement:
    assumptions = assumptions or Assumptions.load()
    config = assumptions.get("green_refinement")
    if current_green_mask is None or current_heatmap is None:
        raise ValueError("green refinement requires mask and heatmap image")
    if current_green_mask.shape[:2] != current_heatmap.shape[:2]:
        raise ValueError("green refinement mask/heatmap shapes differ")

    contours, _ = cv2.findContours(current_green_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise RuntimeError("refined target-green mask has no contour")
    contour = max(contours, key=cv2.contourArea)
    area_px = int(round(cv2.contourArea(contour)))
    if area_px < int(config["minimum_source_area_px"]):
        raise RuntimeError(f"refined target-green mask area {area_px}px is below configured minimum")

    simplified = cv2.approxPolyDP(
        contour,
        float(config["polygon_simplify_epsilon_px"]),
        True,
    )
    polygon = [
        _current_to_yards(
            tee_hole_model,
            registration_matrix,
            float(point[0][0]),
            float(point[0][1]),
        )
        for point in simplified
    ]
    if len(polygon) < 3:
        raise RuntimeError("refined target-green polygon has fewer than three points")

    refined_pin = _current_to_yards(
        tee_hole_model,
        registration_matrix,
        float(current_pin_xy[0]),
        float(current_pin_xy[1]),
    )
    canonical_pin = (canonical_hole.get("green_surface") or {}).get("pin") or {}
    if "forward" not in canonical_pin or "right" not in canonical_pin:
        raise RuntimeError("canonical green has no pin anchor")
    pin_error = math.hypot(
        float(refined_pin["forward"]) - float(canonical_pin["forward"]),
        float(refined_pin["right"]) - float(canonical_pin["right"]),
    )
    if pin_error > float(config["maximum_pin_alignment_error_yds"]):
        raise RuntimeError(
            f"refined green pin maps {pin_error:.1f} yd from canonical pin; refusing merge"
        )

    hsv = cv2.cvtColor(current_heatmap, cv2.COLOR_BGR2HSV)
    ys, xs = np.where(current_green_mask > 0)
    stride = max(1, int(config["heatmap_sample_stride_px"]))
    samples = []
    for index in range(0, len(xs), stride):
        x, y = int(xs[index]), int(ys[index])
        sample = _current_to_yards(tee_hole_model, registration_matrix, x, y)
        sample["hsv"] = [int(value) for value in hsv[y, x]]
        samples.append(sample)

    confidence = min(float(registration_confidence), float(heatmap_confidence))
    return GreenRefinement(
        polygon=polygon,
        pin=refined_pin,
        heatmap_samples=samples,
        confidence=confidence,
        registration_confidence=float(registration_confidence),
        heatmap_confidence=float(heatmap_confidence),
        pin_alignment_error_yds=pin_error,
        source_area_px=area_px,
    )


def merge_refinement(
    canonical_hole: dict,
    refinement: GreenRefinement,
    *,
    assumptions: Assumptions | None = None,
) -> tuple[dict, dict]:
    """Return updated canonical HoleModel plus transparent merge decision metadata."""
    assumptions = assumptions or Assumptions.load()
    config = assumptions.get("green_refinement")
    updated = copy.deepcopy(canonical_hole)
    green = updated.get("green_surface") or {}
    history = list(updated.get("green_surface_history") or [])

    decision = {
        "accepted": False,
        "activated": False,
        "reason": "",
        "incoming_confidence": refinement.confidence,
        "previous_confidence": float(green.get("confidence") or 0.0),
        "pin_alignment_error_yds": refinement.pin_alignment_error_yds,
    }

    if refinement.registration_confidence < float(config["minimum_registration_confidence"]):
        decision["reason"] = "registration confidence below merge threshold"
        return updated, decision
    if refinement.heatmap_confidence < float(config["minimum_heatmap_confidence"]):
        decision["reason"] = "heatmap confidence below merge threshold"
        return updated, decision

    decision["accepted"] = True
    history.append({
        "green_surface": copy.deepcopy(green),
        "replaced_by": refinement.source,
    })
    updated["green_surface_history"] = history[-int(config["maximum_history_entries"]):]

    previous_confidence = float(green.get("confidence") or 0.0)
    activate = (
        bool(config["prefer_refinement_when_valid"])
        or refinement.confidence >= previous_confidence + float(config["minimum_confidence_gain_to_replace"])
    )
    if activate:
        updated["green_surface"] = {
            "polygon": refinement.polygon,
            "pin": refinement.pin,
            "heatmap_samples": refinement.heatmap_samples,
            "confidence": refinement.confidence,
            "source": refinement.source,
            "refinement_meta": refinement.to_dict(),
        }
        decision["activated"] = True
        decision["reason"] = "valid approach refinement activated"
    else:
        green.setdefault("refinements", []).append(refinement.to_dict())
        updated["green_surface"] = green
        decision["reason"] = "refinement retained as evidence but base green stayed active"

    updated["assumption_version"] = assumptions.version
    return updated, decision
