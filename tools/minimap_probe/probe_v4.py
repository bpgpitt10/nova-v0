#!/usr/bin/env python3
"""
GSPro Minimap Hazard Probe v4

Keeps v3's fixed-size/filled-circle player marker detection and v2's
scale/penalty/zoom logic, but makes centerline red-boundary crossings tolerant
of GSPro's white distance labels obscuring part of a red penalty line.

The key idea is deliberately conservative: a true crossing usually leaves red
boundary pixels on BOTH sides of the ball->pin axis at nearly the same forward
distance. We infer a crossing from those nearby left/right fragments even when
the exact center pixels are covered by white text.
"""

from __future__ import annotations

import numpy as np

import probe as base
import probe_v2 as v2
import probe_v3  # noqa: F401  (import applies v3 player-marker patch to v2)

# Allow enough lateral room to see both shoulders of a boundary hidden under a
# white GSPro yardage label, without treating distant parallel red lines as a
# centerline crossing.
INFERENCE_HALF_BAND_YDS = 14.0
INFERENCE_FORWARD_CLUSTER_GAP_YDS = 9.0
OBJECT_BOUNDS_PAD_YDS = 5.0

_original_build_penalty_objects = v2.build_penalty_objects


def _forward_groups(forward: np.ndarray, max_gap: float) -> list[np.ndarray]:
    if forward.size == 0:
        return []
    order = np.argsort(forward)
    values = forward[order]
    groups: list[list[int]] = [[int(order[0])]]
    last = float(values[0])
    for sorted_idx, original_idx in zip(values[1:], order[1:]):
        value = float(sorted_idx)
        if value - last <= max_gap:
            groups[-1].append(int(original_idx))
        else:
            groups.append([int(original_idx)])
        last = value
    return [np.asarray(group, dtype=int) for group in groups]


def _dedupe_distances(values: list[float], max_gap_yds: float = 8.0) -> list[float]:
    if not values:
        return []
    vals = sorted(float(v) for v in values)
    groups: list[list[float]] = [[vals[0]]]
    for value in vals[1:]:
        if value - groups[-1][-1] <= max_gap_yds:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [float(np.median(group)) for group in groups]


def build_penalty_objects_v4(
    roi: np.ndarray,
    ball: base.Point,
    pin: base.Point,
    distance_to_pin_yds: float,
    corridor_half_width_yds: float,
    centerline_band_yds: float,
    merge_gap_yds: float,
):
    objects, pin_pixels, scale = _original_build_penalty_objects(
        roi,
        ball,
        pin,
        distance_to_pin_yds,
        corridor_half_width_yds,
        centerline_band_yds,
        merge_gap_yds,
    )

    if not objects:
        return objects, pin_pixels, scale

    b = np.array([ball.x, ball.y], dtype=float)
    p = np.array([pin.x, pin.y], dtype=float)
    vec = p - b
    if pin_pixels <= 0:
        return objects, pin_pixels, scale

    forward_unit = vec / pin_pixels
    right_unit = np.array([-forward_unit[1], forward_unit[0]])

    # Use the RAW red boundary mask here. We want genuine red evidence on both
    # sides of the axis, not pixels invented by the morphology used for grouping.
    raw = v2.mask_player_marker(base.penalty_mask(roi), ball)
    ys, xs = np.where(raw > 0)
    if xs.size == 0:
        return objects, pin_pixels, scale

    pts = np.column_stack([xs, ys]).astype(float)
    delta = pts - b
    all_forward = (delta @ forward_unit) * scale
    all_lateral = (delta @ right_unit) * scale

    for obj in objects:
        in_object_window = (
            (all_forward >= obj.forward_min_yds - OBJECT_BOUNDS_PAD_YDS)
            & (all_forward <= obj.forward_max_yds + OBJECT_BOUNDS_PAD_YDS)
            & (all_lateral >= obj.lateral_min_yds - OBJECT_BOUNDS_PAD_YDS)
            & (all_lateral <= obj.lateral_max_yds + OBJECT_BOUNDS_PAD_YDS)
            & (all_forward > 0)
        )
        near_axis = in_object_window & (np.abs(all_lateral) <= INFERENCE_HALF_BAND_YDS)
        f = all_forward[near_axis]
        l = all_lateral[near_axis]

        inferred: list[float] = []
        for idxs in _forward_groups(f, INFERENCE_FORWARD_CLUSTER_GAP_YDS):
            gf = f[idxs]
            gl = l[idxs]
            if gf.size < 6:
                continue

            # Require red evidence on both sides of the aim axis. This is what
            # prevents a red line simply running parallel beside the aim line from
            # being called a crossing.
            if float(np.min(gl)) >= -1.0 or float(np.max(gl)) <= 1.0:
                continue

            # Prefer pixels nearest the axis. If white text covers the exact
            # crossing, the surviving left/right shoulders still converge here.
            closest_count = min(12, gf.size)
            closest = np.argsort(np.abs(gl))[:closest_count]
            estimate = float(np.median(gf[closest]))
            inferred.append(estimate)

        obj.centerline_crossings_yds = _dedupe_distances(
            list(obj.centerline_crossings_yds) + inferred,
            max_gap_yds=8.0,
        )

    return objects, pin_pixels, scale


# v2.main() resolves this function from its module globals at runtime.
v2.build_penalty_objects = build_penalty_objects_v4


if __name__ == "__main__":
    raise SystemExit(v2.main())
