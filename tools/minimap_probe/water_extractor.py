#!/usr/bin/env python3
"""Conservative GSPro minimap water segmentation v0.

Consumes a saved/canonical minimap plus the proven ball/pin transform. Water is
kept separate from penalty-area boundaries: red lines remain the high-confidence
penalty cue; this module estimates the actual rendered water surface.

V0 philosophy:
- prefer precision over recall;
- support bright blue/cyan and darker teal-blue water;
- do not assume water is compact (streams/long ponds are valid);
- reject only tiny / ultra-thin UI-like components aggressively;
- expose confidence diagnostics so thresholds can be tuned from live captures.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math

import cv2
import numpy as np


@dataclass
class WaterObject:
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
class WaterExtractionResult:
    objects: list[WaterObject]
    candidate_count: int
    accepted_count: int
    mask: np.ndarray
    candidate_mask: np.ndarray
    diagnostics: list[dict]

    def to_dict(self) -> dict:
        return {
            "schema_version": "gspro-water-v0",
            "candidate_count": self.candidate_count,
            "accepted_count": self.accepted_count,
            "water_objects": [asdict(obj) for obj in self.objects],
            "candidate_diagnostics": self.diagnostics,
            "source": "GSPro minimap cool-water visual segmentation v0",
        }


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _parse_xy(value) -> np.ndarray:
    if hasattr(value, "x") and hasattr(value, "y"):
        return np.array([float(value.x), float(value.y)], dtype=float)
    if isinstance(value, dict):
        return np.array([float(value["x"]), float(value["y"])], dtype=float)
    return np.array([float(value[0]), float(value[1])], dtype=float)


def water_candidate_mask(image: np.ndarray) -> np.ndarray:
    """Permissive candidate mask for blue/cyan and darker teal-blue water."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h = hsv[:, :, 0]
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]

    bgr = image.astype(np.int16)
    b = bgr[:, :, 0]
    g = bgr[:, :, 1]
    r = bgr[:, :, 2]

    # OpenCV hue: roughly 80-140 spans cyan through blue. Keep this broad because
    # community courses vary materially in water palette and brightness.
    hue_water = (h >= 78) & (h <= 142) & (s >= 42) & (v >= 32)

    # Darker/desaturated water can fall outside the strongest hue thresholds. A
    # modest blue-channel dominance gives it another route into the candidate set.
    cool_dominant = (
        (v >= 24)
        & (s >= 30)
        & ((b - r) >= 16)
        & ((b - g) >= 5)
    )

    # Remove clean UI white/gray and extremely bright cyan UI-like pixels. Real
    # water can contain highlights, but the connected body should survive.
    clean_neutral = (s <= 18) & (v >= 185)
    neon_cyan = (h >= 82) & (h <= 98) & (s >= 210) & (v >= 245)

    mask = (hue_water | cool_dominant) & (~clean_neutral) & (~neon_cyan)
    out = (mask.astype(np.uint8) * 255)

    # Reconnect texture/highlight holes while avoiding aggressive expansion into
    # surrounding turf. Small opening removes isolated anti-aliased specks.
    out = cv2.morphologyEx(
        out,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
    )
    out = cv2.morphologyEx(
        out,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    return out


def _component_metrics(image: np.ndarray, labels: np.ndarray, label: int, stats: np.ndarray):
    component = np.where(labels == label, 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)

    area = int(stats[label, cv2.CC_STAT_AREA])
    x = int(stats[label, cv2.CC_STAT_LEFT])
    y = int(stats[label, cv2.CC_STAT_TOP])
    w = int(stats[label, cv2.CC_STAT_WIDTH])
    hh = int(stats[label, cv2.CC_STAT_HEIGHT])
    bbox_area = max(1, w * hh)
    fill_ratio = area / bbox_area
    aspect = max(w, hh) / max(1.0, min(w, hh))

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    idx = component > 0
    mean_h = float(hsv[:, :, 0][idx].mean())
    mean_s = float(hsv[:, :, 1][idx].mean())
    mean_v = float(hsv[:, :, 2][idx].mean())

    pix = image[idx].astype(np.float32)
    mean_b = float(pix[:, 0].mean())
    mean_g = float(pix[:, 1].mean())
    mean_r = float(pix[:, 2].mean())
    blue_dom = mean_b - max(mean_g, mean_r)

    contour_area = max(float(cv2.contourArea(contour)), 1.0)
    hull = cv2.convexHull(contour)
    hull_area = max(float(cv2.contourArea(hull)), 1.0)
    solidity = min(1.0, contour_area / hull_area)
    perimeter = max(float(cv2.arcLength(contour, True)), 1.0)
    compactness = min(1.0, (4.0 * math.pi * contour_area) / (perimeter * perimeter))

    metrics = {
        "area_px": area,
        "bbox_x": x,
        "bbox_y": y,
        "bbox_w": w,
        "bbox_h": hh,
        "fill_ratio": float(fill_ratio),
        "aspect_ratio": float(aspect),
        "mean_hue": mean_h,
        "mean_saturation": mean_s,
        "mean_value": mean_v,
        "mean_b": mean_b,
        "mean_g": mean_g,
        "mean_r": mean_r,
        "blue_dominance": float(blue_dom),
        "solidity": float(solidity),
        "compactness": float(compactness),
    }
    return metrics, component, contour


def _confidence(metrics: dict, scale: float):
    area = float(metrics["area_px"])
    min_dim = float(min(metrics["bbox_w"], metrics["bbox_h"]))
    aspect = float(metrics["aspect_ratio"])
    sat = float(metrics["mean_saturation"])
    hue = float(metrics["mean_hue"])
    blue_dom = float(metrics["blue_dominance"])
    fill = float(metrics["fill_ratio"])
    solidity = float(metrics["solidity"])

    area_yd2 = area * scale * scale
    area_score = _clip01((math.log1p(max(area_yd2, 0.0)) - 0.2) / 3.4)
    hue_score = 1.0 if 82 <= hue <= 132 else _clip01(1.0 - min(abs(hue - 82), abs(hue - 132)) / 28.0)
    saturation_score = _clip01((sat - 28.0) / 90.0)
    blue_score = _clip01((blue_dom + 4.0) / 38.0)
    fill_score = _clip01((fill - 0.10) / 0.55)
    solidity_score = _clip01((solidity - 0.20) / 0.60)

    # Do not punish long shapes: streams and shoreline ponds are legitimate. Only
    # reject components that are so thin they are much more likely to be lines/UI.
    ultra_thin = bool(min_dim <= 2.0 and aspect >= 5.0)
    tiny = bool(area < 9)

    score = (
        0.18 * area_score
        + 0.25 * hue_score
        + 0.18 * saturation_score
        + 0.24 * blue_score
        + 0.08 * fill_score
        + 0.07 * solidity_score
    )
    if ultra_thin:
        score *= 0.25
    if tiny:
        score *= 0.35

    return _clip01(score), {
        "area_yd2": float(area_yd2),
        "area_score": area_score,
        "hue_score": hue_score,
        "saturation_score": saturation_score,
        "blue_score": blue_score,
        "fill_score": fill_score,
        "solidity_score": solidity_score,
        "ultra_thin": ultra_thin,
        "tiny": tiny,
    }


def _geometry(component, contour, *, ball_xy, pin_xy, yards_per_pixel, corridor_half_width_yds):
    b = _parse_xy(ball_xy)
    p = _parse_xy(pin_xy)
    vec = p - b
    length = float(np.linalg.norm(vec))
    if length < 10:
        raise RuntimeError("Ball/pin geometry too small for water coordinate transform")
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


def extract_water(image: np.ndarray, *, ball_xy, pin_xy, yards_per_pixel: float,
                  corridor_half_width_yds: float = 40.0,
                  min_confidence: float = 0.48,
                  min_area_px: int = 12) -> WaterExtractionResult:
    if image is None or image.size == 0:
        raise ValueError("image is empty")
    scale = float(yards_per_pixel)
    if not (0.03 <= scale <= 3.0):
        raise ValueError(f"implausible yards_per_pixel {scale:.4f}")

    candidates = water_candidate_mask(image)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidates, 8)
    accepted_mask = np.zeros(candidates.shape, dtype=np.uint8)
    objects: list[WaterObject] = []
    diagnostics: list[dict] = []

    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < int(min_area_px):
            continue
        metrics, component, contour = _component_metrics(image, labels, label, stats)
        confidence, details = _confidence(metrics, scale)
        accepted = confidence >= float(min_confidence)
        diagnostics.append({
            "candidate_id": len(diagnostics) + 1,
            "accepted": accepted,
            "confidence": confidence,
            **metrics,
            **details,
        })
        if not accepted:
            continue

        geom = _geometry(
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
        hh = int(stats[label, cv2.CC_STAT_HEIGHT])
        obj = WaterObject(
            object_id=len(objects) + 1,
            confidence=confidence,
            area_px=area,
            centroid_pixel=geom["centroid_pixel"],
            bbox_pixel=[x, y, w, hh],
            polygon_pixel=geom["polygon_pixel"],
            polygon_yards=geom["polygon_yards"],
            nearest_yds=geom["nearest_yds"],
            farthest_yds=geom["farthest_yds"],
            forward_min_yds=geom["forward_min_yds"],
            forward_max_yds=geom["forward_max_yds"],
            lateral_min_yds=geom["lateral_min_yds"],
            lateral_max_yds=geom["lateral_max_yds"],
            median_lateral_yds=geom["median_lateral_yds"],
            corridor_entry_yds=geom["corridor_entry_yds"],
            corridor_exit_yds=geom["corridor_exit_yds"],
            source="visual-segmentation:cool-water-v0",
            diagnostics={**metrics, **details},
        )
        objects.append(obj)
        accepted_mask[component > 0] = 255

    objects.sort(key=lambda o: o.nearest_yds)
    for idx, obj in enumerate(objects, 1):
        obj.object_id = idx
    return WaterExtractionResult(
        objects=objects,
        candidate_count=len(diagnostics),
        accepted_count=len(objects),
        mask=accepted_mask,
        candidate_mask=candidates,
        diagnostics=diagnostics,
    )


def draw_debug_overlay(image: np.ndarray, result: WaterExtractionResult, *, ball_xy=None, pin_xy=None) -> np.ndarray:
    canvas = image.copy()
    for obj in result.objects:
        pts = np.array(obj.polygon_pixel, dtype=np.int32).reshape((-1, 1, 2))
        cv2.polylines(canvas, [pts], True, (255, 255, 255), 2)
        cx = int(round(obj.centroid_pixel["x"]))
        cy = int(round(obj.centroid_pixel["y"]))
        cv2.putText(canvas, f"W{obj.object_id} {obj.confidence:.2f}", (cx + 4, cy - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    if ball_xy is not None:
        b = _parse_xy(ball_xy)
        cv2.circle(canvas, (round(b[0]), round(b[1])), 6, (255, 255, 255), 1)
    if pin_xy is not None:
        p = _parse_xy(pin_xy)
        cv2.circle(canvas, (round(p[0]), round(p[1])), 6, (255, 255, 255), 1)
    return canvas


def synthetic_self_test() -> dict:
    image = np.zeros((260, 360, 3), dtype=np.uint8)
    image[:] = (70, 125, 65)  # turf
    cv2.ellipse(image, (92, 88), (45, 25), 10, 0, 360, (180, 125, 45), -1)  # blue lake
    pts = np.array([[205, 35], [221, 40], [250, 160], [238, 190], [221, 125]], np.int32)
    cv2.fillPoly(image, [pts], (115, 85, 42))  # dark blue/teal stream
    cv2.ellipse(image, (295, 80), (24, 13), 0, 0, 360, (175, 190, 205), -1)  # tan bunker
    cv2.line(image, (10, 220), (345, 220), (0, 0, 255), 3)  # red penalty line
    cv2.putText(image, "245", (275, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (245, 245, 245), 2)

    result = extract_water(
        image,
        ball_xy={"x": 180, "y": 245},
        pin_xy={"x": 180, "y": 20},
        yards_per_pixel=0.7,
        min_confidence=0.45,
        min_area_px=10,
    )
    centroids = [(o.centroid_pixel["x"], o.centroid_pixel["y"]) for o in result.objects]
    bunker_false_positive = any(abs(x - 295) < 35 and abs(y - 80) < 25 for x, y in centroids)
    passed = result.accepted_count >= 2 and not bunker_false_positive
    return {
        "pass": passed,
        "accepted_count": result.accepted_count,
        "candidate_count": result.candidate_count,
        "bunker_false_positive": bunker_false_positive,
        "objects": [asdict(o) for o in result.objects],
    }
