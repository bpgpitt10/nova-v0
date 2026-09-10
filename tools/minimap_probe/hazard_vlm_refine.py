#!/usr/bin/env python3
"""Refine VLM hazard boxes into local pixel polygons.

The VLM decides WHAT a region is. Existing inexpensive pixel segmentation is used
only inside/around that VLM region to trace a tighter edge. If refinement fails,
the VLM box is retained as diagnostic geometry rather than becoming authoritative.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import cv2
import numpy as np

import bunker_extractor
import water_extractor
from hazard_vlm_contract import VlmHazard, bbox_px


@dataclass
class RefinedHazard:
    hazard_id: str
    hazard_class: str
    vlm_confidence: float
    bbox_norm: list[float]
    bbox_px: list[int]
    refinement_status: str
    refinement_confidence: float
    polygon_px: list[list[int]]
    polygon_norm: list[list[float]]
    geometry_yards: dict[str, Any] | None
    strategy_authority: bool
    diagnostics: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _largest_local_component(mask: np.ndarray, box: tuple[int, int, int, int], pad: int = 5):
    h, w = mask.shape[:2]
    x1, y1, x2, y2 = box
    rx1, ry1 = max(0, x1-pad), max(0, y1-pad)
    rx2, ry2 = min(w, x2+pad), min(h, y2+pad)
    local = np.zeros_like(mask)
    local[ry1:ry2, rx1:rx2] = mask[ry1:ry2, rx1:rx2]
    count, labels, stats, _ = cv2.connectedComponentsWithStats(local, 8)
    if count <= 1:
        return None, {"components": 0}
    best = None
    best_score = -1.0
    box_area = max(1, (x2-x1)*(y2-y1))
    for label in range(1, count):
        component = labels == label
        area = int(component.sum())
        if area < 5:
            continue
        inside = int(component[y1:y2, x1:x2].sum())
        if inside <= 0:
            continue
        overlap = inside / max(1, area)
        coverage = inside / box_area
        score = inside * (0.65 + 0.35*overlap) * (0.75 + 0.25*min(1.0, coverage*4))
        if score > best_score:
            best_score = score
            best = np.where(component, 255, 0).astype(np.uint8)
    return best, {"components": count-1, "selection_score": best_score}


def _box_polygon(box):
    x1, y1, x2, y2 = box
    return [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]


def _contour_polygon(component: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    epsilon = max(1.0, 0.012 * cv2.arcLength(contour, True))
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    if len(approx) < 3:
        return []
    return [[int(x), int(y)] for x, y in approx]


def _norm_polygon(poly, width, height):
    return [[round(x/width, 5), round(y/height, 5)] for x,y in poly]


def _yard_geometry(poly, *, ball_xy, pin_xy, yards_per_pixel):
    if not poly or ball_xy is None or pin_xy is None or yards_per_pixel is None:
        return None
    def xy(v):
        if isinstance(v, dict):
            return np.array([float(v["x"]), float(v["y"])], dtype=float)
        return np.array([float(v[0]), float(v[1])], dtype=float)
    b, p = xy(ball_xy), xy(pin_xy)
    vec = p-b
    length = float(np.linalg.norm(vec))
    if length < 10:
        return None
    scale = float(yards_per_pixel)
    if not (0.03 <= scale <= 3.0):
        return None
    fwd = vec/length
    right = np.array([-fwd[1], fwd[0]], dtype=float)
    pts = np.array(poly, dtype=float)
    delta = pts-b
    forward = (delta @ fwd)*scale
    lateral = (delta @ right)*scale
    return {
        "polygon": [
            {"forward_yds": float(f), "lateral_yds": float(l)}
            for f,l in zip(forward, lateral)
        ],
        "forward_min_yds": float(np.min(forward)),
        "forward_max_yds": float(np.max(forward)),
        "lateral_min_yds": float(np.min(lateral)),
        "lateral_max_yds": float(np.max(lateral)),
    }


def refine_hazard(image: np.ndarray, hazard: VlmHazard, *, ball_xy=None, pin_xy=None, yards_per_pixel=None) -> RefinedHazard:
    if image is None or image.size == 0:
        raise ValueError("image is empty")
    h, w = image.shape[:2]
    box = bbox_px(hazard, w, h)

    if hazard.hazard_class == "bunker":
        candidate = bunker_extractor.sand_candidate_mask(image)
    elif hazard.hazard_class == "water":
        candidate = water_extractor.water_candidate_mask(image)
    else:
        candidate = np.zeros((h,w), dtype=np.uint8)

    component = None
    component_diag = {"components": 0}
    if hazard.hazard_class in {"bunker", "water"}:
        component, component_diag = _largest_local_component(candidate, box)

    box_area = max(1, (box[2]-box[0])*(box[3]-box[1]))
    if component is not None:
        poly = _contour_polygon(component)
        area = int((component > 0).sum())
        inside = int((component[box[1]:box[3], box[0]:box[2]] > 0).sum())
        coverage = inside / box_area
        refine_conf = max(0.0, min(1.0, 0.45 + 0.35*min(1.0, coverage*3) + 0.20*min(1.0, area/40)))
        status = "pixel-mask-refined" if len(poly) >= 3 else "vlm-box-only"
        if len(poly) < 3:
            poly = _box_polygon(box)
    else:
        poly = _box_polygon(box)
        coverage = 0.0
        refine_conf = 0.0
        status = "vlm-box-only" if hazard.hazard_class != "uncertain" else "uncertain-box-only"

    geom = _yard_geometry(poly, ball_xy=ball_xy, pin_xy=pin_xy, yards_per_pixel=yards_per_pixel)
    return RefinedHazard(
        hazard_id=hazard.hazard_id,
        hazard_class=hazard.hazard_class,
        vlm_confidence=hazard.confidence,
        bbox_norm=list(hazard.bbox_norm),
        bbox_px=list(box),
        refinement_status=status,
        refinement_confidence=float(refine_conf),
        polygon_px=poly,
        polygon_norm=_norm_polygon(poly, w, h),
        geometry_yards=geom,
        strategy_authority=False,
        diagnostics={
            **component_diag,
            "candidate_coverage_of_vlm_box": float(coverage),
            "semantic_source": "VLM",
            "edge_source": "classical-CV-inside-VLM-ROI" if component is not None else "VLM-box",
        },
    )


def refine_all(image, hazards, *, ball_xy=None, pin_xy=None, yards_per_pixel=None):
    return [
        refine_hazard(image, hazard, ball_xy=ball_xy, pin_xy=pin_xy, yards_per_pixel=yards_per_pixel)
        for hazard in hazards
    ]


def draw_overlay(image: np.ndarray, refined: list[RefinedHazard]) -> np.ndarray:
    canvas = image.copy()
    for obj in refined:
        pts = np.array(obj.polygon_px, dtype=np.int32).reshape((-1,1,2))
        if len(pts) >= 3:
            cv2.polylines(canvas, [pts], True, (255,255,255), 2, cv2.LINE_AA)
        x1,y1,_,_ = obj.bbox_px
        label = f"{obj.hazard_class[:1].upper()} {obj.vlm_confidence:.2f} {obj.refinement_status}"
        cv2.putText(canvas, label, (max(2,x1), max(14,y1-4)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0,0,0), 3, cv2.LINE_AA)
        cv2.putText(canvas, label, (max(2,x1), max(14,y1-4)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255,255,255), 1, cv2.LINE_AA)
    return canvas
