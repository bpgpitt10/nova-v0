#!/usr/bin/env python3
"""Conservative GSPro minimap bunker segmentation.

This module is intentionally independent of live GSPro actuation. It consumes a
saved/canonical minimap plus the already-proven ball/pin transform and returns
filled bunker objects in the same forward/lateral yard coordinate system used by
penalty-area geometry.

V0 philosophy:
- prefer precision over recall;
- use the rendered sand surface (pale tan / warm gray), not semantic AI;
- reject thin white UI/text/OB-line shapes with fill, chroma, geometry and local
  contrast checks;
- expose confidence diagnostics instead of pretending uncertain shapes are
  authoritative.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math

import cv2
import numpy as np


@dataclass
class BunkerObject:
    object_id: int
    confidence: float
    area_px: int
    centroid_pixel: dict[str, float]
    bbox_pixel: list[int]
    polygon_pixel: list[list[int]]
    polygon_yards: list[dict[str, float]]
    nearest_yds: float
    farthest_yds: float
    forward_min_yds: float
    forward_max_yds: float
    lateral_min_yds: float
    lateral_max_yds: float
    median_lateral_yds: float
    corridor_entry_yds: float | None
    corridor_exit_yds: float | None
    source: str
    diagnostics: dict[str, float | bool]


@dataclass
class BunkerExtractionResult:
    objects: list[BunkerObject]
    candidate_count: int
    accepted_count: int
    mask: np.ndarray
    candidate_mask: np.ndarray
    diagnostics: list[dict]

    def to_dict(self) -> dict:
        return {
            "schema_version": "gspro-bunkers-v0",
            "candidate_count": self.candidate_count,
            "accepted_count": self.accepted_count,
            "bunker_objects": [asdict(obj) for obj in self.objects],
            "candidate_diagnostics": self.diagnostics,
            "source": "GSPro minimap pale-sand visual segmentation v0",
        }


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _parse_xy(value) -> np.ndarray:
    if hasattr(value, "x") and hasattr(value, "y"):
        return np.array([float(value.x), float(value.y)], dtype=float)
    if isinstance(value, dict):
        return np.array([float(value["x"]), float(value["y"])], dtype=float)
    return np.array([float(value[0]), float(value[1])], dtype=float)


def sand_candidate_mask(image: np.ndarray) -> np.ndarray:
    """Return a permissive pale-sand candidate mask.

    GSPro bunkers in the screenshots observed so far are light tan / warm gray.
    The mask deliberately permits both clearly tan sand and nearly-white sand,
    then relies on component-level shape/local-contrast scoring to reject labels,
    white course boundaries and other UI artifacts.
    """
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)

    h = hsv[:, :, 0]
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]
    l = lab[:, :, 0]
    b = lab[:, :, 2]

    warm_tan = (
        (l >= 118)
        & (v >= 118)
        & (s <= 150)
        & (h >= 5)
        & (h <= 42)
        & (b >= 130)
    )
    pale_warm = (
        (l >= 145)
        & (v >= 145)
        & (s <= 78)
        & (b >= 132)
    )

    # Pure UI white is typically very bright, almost zero saturation and close to
    # neutral Lab-b. Keep warm off-white sand but remove the cleanest white pixels.
    pure_white = (v >= 238) & (s <= 24) & (b <= 133)
    mask = (warm_tan | pale_warm) & (~pure_white)

    out = (mask.astype(np.uint8) * 255)
    # One light close reconnects anti-aliased bunker fill without fusing nearby
    # objects. Opening removes isolated bright turf specks.
    out = cv2.morphologyEx(
        out,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    out = cv2.morphologyEx(
        out,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    return out


def _local_ring(component_mask: np.ndarray, radius: int = 5) -> np.ndarray:
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (radius * 2 + 1, radius * 2 + 1),
    )
    dilated = cv2.dilate(component_mask, kernel)
    return cv2.subtract(dilated, component_mask)


def _component_metrics(
    image: np.ndarray,
    labels: np.ndarray,
    label: int,
    stats: np.ndarray,
) -> tuple[dict, np.ndarray, np.ndarray]:
    component = np.where(labels == label, 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)

    area = int(stats[label, cv2.CC_STAT_AREA])
    x = int(stats[label, cv2.CC_STAT_LEFT])
    y = int(stats[label, cv2.CC_STAT_TOP])
    w = int(stats[label, cv2.CC_STAT_WIDTH])
    h = int(stats[label, cv2.CC_STAT_HEIGHT])
    bbox_area = max(1, w * h)
    fill_ratio = area / bbox_area

    hull = cv2.convexHull(contour)
    hull_area = max(float(cv2.contourArea(hull)), 1.0)
    contour_area = max(float(cv2.contourArea(contour)), 1.0)
    solidity = min(1.0, contour_area / hull_area)
    perimeter = max(float(cv2.arcLength(contour, True)), 1.0)
    compactness = min(1.0, (4.0 * math.pi * contour_area) / (perimeter * perimeter))
    aspect = max(w, h) / max(1.0, min(w, h))

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    idx = component > 0
    mean_sat = float(hsv[:, :, 1][idx].mean())
    mean_val = float(hsv[:, :, 2][idx].mean())
    mean_l = float(lab[:, :, 0][idx].mean())
    mean_b = float(lab[:, :, 2][idx].mean())

    ring = _local_ring(component)
    ring_idx = ring > 0
    if int(ring_idx.sum()) >= 8:
        ring_l = float(lab[:, :, 0][ring_idx].mean())
        local_lift = mean_l - ring_l
    else:
        ring_l = mean_l
        local_lift = 0.0

    metrics = {
        "area_px": area,
        "bbox_x": x,
        "bbox_y": y,
        "bbox_w": w,
        "bbox_h": h,
        "fill_ratio": float(fill_ratio),
        "solidity": float(solidity),
        "compactness": float(compactness),
        "aspect_ratio": float(aspect),
        "mean_saturation": mean_sat,
        "mean_value": mean_val,
        "mean_lab_l": mean_l,
        "mean_lab_b": mean_b,
        "local_ring_lab_l": ring_l,
        "local_lightness_lift": float(local_lift),
    }
    return metrics, component, contour


def _confidence(metrics: dict, scale: float) -> tuple[float, dict[str, float | bool]]:
    area = float(metrics["area_px"])
    fill = float(metrics["fill_ratio"])
    solidity = float(metrics["solidity"])
    compactness = float(metrics["compactness"])
    aspect = float(metrics["aspect_ratio"])
    sat = float(metrics["mean_saturation"])
    lab_b = float(metrics["mean_lab_b"])
    lift = float(metrics["local_lightness_lift"])

    # A tee-view bunker may only be a few dozen pixels. Let physical area help,
    # but do not require a large pixel blob.
    area_yd2 = area * scale * scale
    area_score = _clip01((math.log1p(max(area_yd2, 0.0)) - 0.3) / 3.2)
    fill_score = _clip01((fill - 0.18) / 0.52)
    solidity_score = _clip01((solidity - 0.42) / 0.48)
    compact_score = _clip01((compactness - 0.05) / 0.42)
    warm_score = _clip01((lab_b - 128.5) / 15.0)
    saturation_score = 1.0 - _clip01((sat - 115.0) / 70.0)
    contrast_score = _clip01((lift + 2.0) / 20.0)
    aspect_score = 1.0 if aspect <= 4.5 else _clip01((8.0 - aspect) / 3.5)

    score = (
        0.16 * area_score
        + 0.16 * fill_score
        + 0.14 * solidity_score
        + 0.08 * compact_score
        + 0.18 * warm_score
        + 0.08 * saturation_score
        + 0.15 * contrast_score
        + 0.05 * aspect_score
    )

    thin_or_textlike = bool(
        (min(metrics["bbox_w"], metrics["bbox_h"]) <= 3 and aspect >= 3.0)
        or (aspect >= 8.0)
        or (fill < 0.10)
    )
    neutral_white_line = bool(lab_b < 131.0 and sat < 30.0 and aspect > 3.5)
    if thin_or_textlike:
        score *= 0.35
    if neutral_white_line:
        score *= 0.25

    details = {
        "area_yd2": float(area_yd2),
        "area_score": area_score,
        "fill_score": fill_score,
        "solidity_score": solidity_score,
        "compactness_score": compact_score,
        "warm_score": warm_score,
        "saturation_score": saturation_score,
        "local_contrast_score": contrast_score,
        "aspect_score": aspect_score,
        "thin_or_textlike": thin_or_textlike,
        "neutral_white_line": neutral_white_line,
    }
    return _clip01(score), details


def _geometry_from_component(
    component: np.ndarray,
    contour: np.ndarray,
    *,
    ball_xy,
    pin_xy,
    yards_per_pixel: float,
    corridor_half_width_yds: float,
) -> dict:
    b = _parse_xy(ball_xy)
    p = _parse_xy(pin_xy)
    vec = p - b
    length = float(np.linalg.norm(vec))
    if length < 10:
        raise RuntimeError("Ball/pin geometry too small for bunker coordinate transform")
    forward_unit = vec / length
    right_unit = np.array([-forward_unit[1], forward_unit[0]], dtype=float)

    ys, xs = np.where(component > 0)
    pts = np.column_stack([xs, ys]).astype(float)
    delta = pts - b
    forward = (delta @ forward_unit) * yards_per_pixel
    lateral = (delta @ right_unit) * yards_per_pixel
    euclidean = np.linalg.norm(delta, axis=1) * yards_per_pixel

    ahead = forward >= -2.0
    if int(ahead.sum()) < 1:
        ahead = np.ones_like(forward, dtype=bool)
    corridor = ahead & (np.abs(lateral) <= corridor_half_width_yds)

    moments = cv2.moments(contour)
    if moments["m00"]:
        cx = float(moments["m10"] / moments["m00"])
        cy = float(moments["m01"] / moments["m00"])
    else:
        cx = float(xs.mean())
        cy = float(ys.mean())

    epsilon = max(1.0, 0.012 * cv2.arcLength(contour, True))
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    polygon_pixel = [[int(x), int(y)] for x, y in approx]
    polygon_yards = []
    for x, y in approx.astype(float):
        d = np.array([x, y], dtype=float) - b
        polygon_yards.append({
            "forward_yds": float((d @ forward_unit) * yards_per_pixel),
            "lateral_yds": float((d @ right_unit) * yards_per_pixel),
        })

    return {
        "centroid_pixel": {"x": cx, "y": cy},
        "polygon_pixel": polygon_pixel,
        "polygon_yards": polygon_yards,
        "nearest_yds": float(np.min(euclidean[ahead])),
        "farthest_yds": float(np.max(euclidean[ahead])),
        "forward_min_yds": float(np.min(forward[ahead])),
        "forward_max_yds": float(np.max(forward[ahead])),
        "lateral_min_yds": float(np.min(lateral[ahead])),
        "lateral_max_yds": float(np.max(lateral[ahead])),
        "median_lateral_yds": float(np.median(lateral[ahead])),
        "corridor_entry_yds": float(np.min(forward[corridor])) if np.any(corridor) else None,
        "corridor_exit_yds": float(np.max(forward[corridor])) if np.any(corridor) else None,
    }


def extract_bunkers(
    image: np.ndarray,
    *,
    ball_xy,
    pin_xy,
    yards_per_pixel: float,
    corridor_half_width_yds: float = 40.0,
    min_confidence: float = 0.45,
    min_area_px: int = 12,
) -> BunkerExtractionResult:
    if image is None or image.size == 0:
        raise ValueError("image is empty")
    scale = float(yards_per_pixel)
    if not (0.03 <= scale <= 3.0):
        raise ValueError(f"implausible yards_per_pixel {scale:.4f}")

    candidates = sand_candidate_mask(image)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidates, 8)

    accepted_mask = np.zeros(candidates.shape, dtype=np.uint8)
    objects: list[BunkerObject] = []
    diagnostics: list[dict] = []

    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < int(min_area_px):
            continue

        metrics, component, contour = _component_metrics(image, labels, label, stats)
        confidence, score_details = _confidence(metrics, scale)
        accepted = confidence >= float(min_confidence)
        diag = {
            "candidate_id": len(diagnostics) + 1,
            "accepted": accepted,
            "confidence": confidence,
            **metrics,
            **score_details,
        }
        diagnostics.append(diag)
        if not accepted:
            continue

        geometry = _geometry_from_component(
            component,
            contour,
            ball_xy=ball_xy,
            pin_xy=pin_xy,
            yards_per_pixel=scale,
            corridor_half_width_yds=float(corridor_half_width_yds),
        )
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])

        obj = BunkerObject(
            object_id=len(objects) + 1,
            confidence=confidence,
            area_px=area,
            centroid_pixel=geometry["centroid_pixel"],
            bbox_pixel=[x, y, w, h],
            polygon_pixel=geometry["polygon_pixel"],
            polygon_yards=geometry["polygon_yards"],
            nearest_yds=geometry["nearest_yds"],
            farthest_yds=geometry["farthest_yds"],
            forward_min_yds=geometry["forward_min_yds"],
            forward_max_yds=geometry["forward_max_yds"],
            lateral_min_yds=geometry["lateral_min_yds"],
            lateral_max_yds=geometry["lateral_max_yds"],
            median_lateral_yds=geometry["median_lateral_yds"],
            corridor_entry_yds=geometry["corridor_entry_yds"],
            corridor_exit_yds=geometry["corridor_exit_yds"],
            source="visual-segmentation:sand-fill-v0",
            diagnostics={
                "fill_ratio": metrics["fill_ratio"],
                "solidity": metrics["solidity"],
                "compactness": metrics["compactness"],
                "mean_saturation": metrics["mean_saturation"],
                "mean_lab_b": metrics["mean_lab_b"],
                "local_lightness_lift": metrics["local_lightness_lift"],
            },
        )
        objects.append(obj)
        accepted_mask[component > 0] = 255

    objects.sort(key=lambda obj: (obj.forward_min_yds, obj.nearest_yds))
    for i, obj in enumerate(objects, start=1):
        obj.object_id = i

    return BunkerExtractionResult(
        objects=objects,
        candidate_count=len(diagnostics),
        accepted_count=len(objects),
        mask=accepted_mask,
        candidate_mask=candidates,
        diagnostics=diagnostics,
    )


def draw_debug_overlay(
    image: np.ndarray,
    result: BunkerExtractionResult,
    *,
    ball_xy=None,
    pin_xy=None,
) -> np.ndarray:
    canvas = image.copy()
    overlay = canvas.copy()
    overlay[result.mask > 0] = (0, 220, 255)
    canvas = cv2.addWeighted(canvas, 0.72, overlay, 0.28, 0)

    for obj in result.objects:
        pts = np.array(obj.polygon_pixel, dtype=np.int32).reshape(-1, 1, 2)
        if len(pts) >= 3:
            cv2.polylines(canvas, [pts], True, (0, 255, 255), 2, cv2.LINE_AA)
        cx = int(round(obj.centroid_pixel["x"]))
        cy = int(round(obj.centroid_pixel["y"]))
        label = f"B{obj.object_id} {obj.confidence:.2f}"
        cv2.putText(
            canvas,
            label,
            (max(2, cx - 20), max(14, cy - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (0, 0, 0),
            3,
            cv2.LINE_AA,
        )
        cv2.putText(
            canvas,
            label,
            (max(2, cx - 20), max(14, cy - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (0, 255, 255),
            1,
            cv2.LINE_AA,
        )

    if ball_xy is not None:
        b = _parse_xy(ball_xy)
        cv2.circle(canvas, (round(b[0]), round(b[1])), 7, (255, 0, 255), 2)
    if pin_xy is not None:
        p = _parse_xy(pin_xy)
        cv2.circle(canvas, (round(p[0]), round(p[1])), 7, (255, 255, 255), 2)
    if ball_xy is not None and pin_xy is not None:
        b = _parse_xy(ball_xy)
        p = _parse_xy(pin_xy)
        cv2.line(
            canvas,
            (round(b[0]), round(b[1])),
            (round(p[0]), round(p[1])),
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return canvas


def synthetic_self_test() -> dict:
    """Mechanical regression test; not a substitute for real GSPro validation."""
    img = np.zeros((520, 280, 3), dtype=np.uint8)
    img[:] = (55, 105, 62)
    cv2.rectangle(img, (105, 20), (180, 500), (72, 135, 78), -1)
    cv2.ellipse(img, (92, 165), (18, 30), 24, 0, 360, (185, 205, 220), -1)
    cv2.ellipse(img, (205, 315), (24, 14), -18, 0, 360, (175, 198, 218), -1)
    cv2.line(img, (5, 30), (5, 490), (250, 250, 250), 3)
    cv2.putText(img, "223", (110, 255), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (245, 245, 245), 2)
    cv2.line(img, (20, 80), (80, 90), (0, 0, 240), 4)

    result = extract_bunkers(
        img,
        ball_xy=(140, 480),
        pin_xy=(145, 50),
        yards_per_pixel=0.75,
        min_confidence=0.35,
        min_area_px=10,
    )
    return {
        "accepted": result.accepted_count,
        "candidate_count": result.candidate_count,
        "pass": result.accepted_count == 2,
        "objects": [asdict(x) for x in result.objects],
    }
