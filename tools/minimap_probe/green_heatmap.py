#!/usr/bin/env python3
"""GSPro tee green-heatmap frame classification + target-green isolation.

The tee capture orchestrator already has an initial screen for PIN/lie state. It
briefly toggles GSPro's green heatmap and captures a second screen at the exact same
minimap zoom. We use the pair only as a transient registration aid:

- determine which frame is heatmap-on;
- derive the pixels that changed because of the heatmap;
- select the changed green region associated with the current white pin marker;
- preserve one canonical HEATMAP-ON minimap for the HoleModel.

The normal frame is not a second hole model and does not need to be persisted.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

import probe as base
import probe_v2 as v2


@dataclass
class GreenHeatmapResult:
    heatmap_is_initial: bool
    confidence: float
    changed_pixel_ratio: float
    target_green_area_px: int
    target_green_bbox: tuple[int, int, int, int]
    pin_distance_to_mask_px: float
    heatmap_roi: np.ndarray
    normal_roi: np.ndarray
    target_green_mask: np.ndarray
    changed_mask: np.ndarray


def _heatmap_color_score(roi: np.ndarray, pin: base.Point) -> float:
    """Score vivid red/yellow/green fill around the current pin.

    This is deliberately used only to decide which of two registered frames is the
    heatmap frame. The actual target-green mask comes from frame differencing.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, W = roi.shape[:2]
    yy, xx = np.ogrid[:H, :W]
    radius = max(18.0, min(H, W) * 0.11)
    near = (xx - pin.x) ** 2 + (yy - pin.y) ** 2 <= radius ** 2

    h = hsv[:, :, 0]
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]
    vivid = (s >= 115) & (v >= 105)
    hue = (
        (h <= 12)                       # red
        | ((h >= 15) & (h <= 42))      # orange/yellow
        | ((h >= 43) & (h <= 95))      # green
        | (h >= 172)                    # red wrap
    )
    mask = near & vivid & hue
    # Count plus a small saturation-weighted term so a filled heatmap wins over a
    # thin red penalty line passing near the pin.
    return float(mask.sum()) + float(s[mask].sum()) / 255.0 if mask.any() else 0.0


def _difference_mask(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    diff = cv2.absdiff(a, b)
    # Require a material color/intensity change. Anti-alias shimmer should not be
    # enough to become a green candidate.
    max_diff = diff.max(axis=2)
    mean_diff = diff.mean(axis=2)
    mask = ((max_diff >= 30) & (mean_diff >= 12)).astype(np.uint8) * 255

    # Registered GSPro frames should differ primarily on heatmapped greens. Close
    # small internal gaps but avoid giant dilation that could merge neighboring holes.
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
    )
    return mask


def _point_to_component_distance(mask: np.ndarray, pin: base.Point) -> float:
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return 1e9
    d2 = (xs.astype(float) - pin.x) ** 2 + (ys.astype(float) - pin.y) ** 2
    return float(np.sqrt(d2.min()))


def _select_target_green(changed: np.ndarray, pin: base.Point) -> tuple[np.ndarray, tuple[int, int, int, int], float]:
    # A light dilation joins heatmap transition bands belonging to the same green.
    joined = cv2.dilate(
        changed,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        iterations=1,
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, 8)

    candidates: list[tuple[float, int, float, int]] = []
    H, W = changed.shape[:2]
    max_pin_distance = max(16.0, min(H, W) * 0.10)

    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < 18:
            continue
        component = (labels == label).astype(np.uint8) * 255
        distance = _point_to_component_distance(component, pin)
        if distance > max_pin_distance:
            continue
        # Prefer components close to the pin, then larger coherent regions.
        score = 120.0 / (1.0 + distance) + min(area, 2000) / 80.0
        candidates.append((score, label, distance, area))

    if not candidates:
        raise RuntimeError("Could not isolate a heatmap-changed green region near the current pin.")

    _score, label, distance, _area = max(candidates, key=lambda item: item[0])
    selected_joined = (labels == label).astype(np.uint8) * 255

    # Return only genuinely changed pixels inside the selected component. Then close
    # tiny holes so the mask can safely exclude heatmap fill from hazard-red CV.
    selected = cv2.bitwise_and(changed, selected_joined)
    selected = cv2.morphologyEx(
        selected,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
    )

    ys, xs = np.where(selected > 0)
    if xs.size == 0:
        raise RuntimeError("Selected target-green component contained no changed pixels.")
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    return selected, (x1, y1, x2 - x1 + 1, y2 - y1 + 1), distance


def classify_and_extract(
    initial_screen: np.ndarray,
    toggled_screen: np.ndarray,
    roi_override: str | None = None,
    debug_dir: Path | None = None,
) -> GreenHeatmapResult:
    initial_roi, _ = base.crop_minimap(initial_screen, roi_override)
    toggled_roi, _ = base.crop_minimap(toggled_screen, roi_override)
    if initial_roi.shape != toggled_roi.shape:
        raise RuntimeError("Initial/toggled minimap crops do not share identical geometry.")

    # The pin must be in the same place in both frames. Use both reads as a sanity
    # check that Y did not alter minimap camera/zoom state.
    pin_initial = v2.detect_pin_marker(initial_roi)
    pin_toggled = v2.detect_pin_marker(toggled_roi)
    pin_shift = float(np.hypot(pin_initial.x - pin_toggled.x, pin_initial.y - pin_toggled.y))
    if pin_shift > 3.0:
        raise RuntimeError(f"Minimap moved during heatmap toggle (pin shifted {pin_shift:.1f}px).")

    score_initial = _heatmap_color_score(initial_roi, pin_initial)
    score_toggled = _heatmap_color_score(toggled_roi, pin_toggled)
    total_score = score_initial + score_toggled
    if total_score <= 1.0:
        raise RuntimeError("Neither registered minimap frame looked heatmap-like near the pin.")

    heatmap_is_initial = score_initial > score_toggled
    heatmap_roi = initial_roi if heatmap_is_initial else toggled_roi
    normal_roi = toggled_roi if heatmap_is_initial else initial_roi
    pin = pin_initial if heatmap_is_initial else pin_toggled

    changed = _difference_mask(initial_roi, toggled_roi)
    changed_ratio = float((changed > 0).mean())
    if changed_ratio < 0.0005:
        raise RuntimeError("Y toggle produced too little minimap change to identify a heatmap frame.")
    if changed_ratio > 0.35:
        raise RuntimeError(
            f"Y toggle changed {changed_ratio:.1%} of minimap pixels; frames may not be registered."
        )

    green_mask, bbox, pin_distance = _select_target_green(changed, pin)
    area = int((green_mask > 0).sum())

    # Confidence combines heatmap-state separation, pin association, and enough
    # changed area to be useful. It is intentionally conservative for the first POC.
    score_sep = abs(score_initial - score_toggled) / max(total_score, 1.0)
    pin_term = max(0.0, 1.0 - pin_distance / max(18.0, min(changed.shape) * 0.10))
    area_term = min(1.0, area / 140.0)
    confidence = float(max(0.0, min(1.0, 0.45 * score_sep + 0.35 * pin_term + 0.20 * area_term)))

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "tee_heatmap_minimap.png"), heatmap_roi)
        cv2.imwrite(str(debug_dir / "tee_green_changed_mask.png"), changed)
        cv2.imwrite(str(debug_dir / "tee_target_green_mask.png"), green_mask)

        overlay = heatmap_roi.copy()
        contours, _ = cv2.findContours(green_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, (255, 255, 255), 2)
        cv2.circle(overlay, (round(pin.x), round(pin.y)), 6, (255, 255, 255), 2)
        x, y, w, h = bbox
        cv2.rectangle(overlay, (x, y), (x + w, y + h), (255, 255, 255), 1)
        cv2.imwrite(str(debug_dir / "tee_green_debug_overlay.png"), overlay)

    return GreenHeatmapResult(
        heatmap_is_initial=heatmap_is_initial,
        confidence=confidence,
        changed_pixel_ratio=changed_ratio,
        target_green_area_px=area,
        target_green_bbox=bbox,
        pin_distance_to_mask_px=pin_distance,
        heatmap_roi=heatmap_roi,
        normal_roi=normal_roi,
        target_green_mask=green_mask,
        changed_mask=changed,
    )


def hazard_safe_roi(result: GreenHeatmapResult, margin_px: int = 4) -> np.ndarray:
    """Keep canonical heatmap frame but restore normal pixels only under target green.

    This prevents red heatmap fill from becoming a fake red-stake penalty boundary
    while still letting hazards be extracted from the same registered tee geometry.
    """
    mask = result.target_green_mask
    if margin_px > 0:
        k = margin_px * 2 + 1
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    out = result.heatmap_roi.copy()
    out[mask > 0] = result.normal_roi[mask > 0]
    return out
