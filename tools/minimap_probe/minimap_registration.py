#!/usr/bin/env python3
"""Register a later GSPro minimap back into the tee HoleModel coordinate system."""

from __future__ import annotations

from dataclasses import dataclass, asdict
import json
import math
from pathlib import Path

import cv2
import numpy as np


@dataclass
class RegistrationResult:
    matrix_2x3: list[list[float]]
    keypoints_current: int
    keypoints_canonical: int
    good_matches: int
    inliers: int
    inlier_ratio: float
    scale: float
    rotation_deg: float
    median_reprojection_error_px: float
    confidence: float

    def to_dict(self) -> dict:
        return asdict(self)


def _default_config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["screen_detection"]["registration"]


def _play_mask(shape: tuple[int, int], config: dict) -> np.ndarray:
    """Mask out minimap title/footer UI while keeping the course imagery."""
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    y0 = int(round(h * float(config["play_mask_top_fraction"])))
    y1 = int(round(h * float(config["play_mask_bottom_fraction"])))
    cv2.rectangle(mask, (0, y0), (w - 1, max(y0, y1 - 1)), 255, -1)
    return mask


def register_current_to_canonical(
    current_bgr: np.ndarray,
    canonical_bgr: np.ndarray,
    *,
    detector_config: dict | None = None,
    ratio_test: float | None = None,
    ransac_reproj_px: float | None = None,
    min_good_matches: int | None = None,
    min_inliers: int | None = None,
) -> RegistrationResult:
    if current_bgr is None or canonical_bgr is None:
        raise ValueError("registration images are missing")

    config = detector_config or _default_config()
    ratio_test = float(config["ratio_test"] if ratio_test is None else ratio_test)
    ransac_reproj_px = float(config["ransac_reprojection_px"] if ransac_reproj_px is None else ransac_reproj_px)
    min_good_matches = int(config["min_good_matches"] if min_good_matches is None else min_good_matches)
    min_inliers = int(config["min_inliers"] if min_inliers is None else min_inliers)

    current_gray = cv2.cvtColor(current_bgr, cv2.COLOR_BGR2GRAY)
    canonical_gray = cv2.cvtColor(canonical_bgr, cv2.COLOR_BGR2GRAY)

    sift = cv2.SIFT_create()
    kp_cur, des_cur = sift.detectAndCompute(current_gray, _play_mask(current_gray.shape, config))
    kp_can, des_can = sift.detectAndCompute(canonical_gray, _play_mask(canonical_gray.shape, config))
    if des_cur is None or des_can is None:
        raise RuntimeError("Could not compute enough minimap features for registration")

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(des_cur, des_can, k=2)
    good = [m for m, n in pairs if m.distance < ratio_test * n.distance]
    if len(good) < min_good_matches:
        raise RuntimeError(
            f"Minimap registration had only {len(good)} good feature matches "
            f"(need >= {min_good_matches})"
        )

    src = np.float32([kp_cur[m.queryIdx].pt for m in good])
    dst = np.float32([kp_can[m.trainIdx].pt for m in good])
    matrix, inlier_mask = cv2.estimateAffinePartial2D(
        src,
        dst,
        method=cv2.RANSAC,
        ransacReprojThreshold=ransac_reproj_px,
        maxIters=int(config["ransac_max_iters"]),
        confidence=float(config["ransac_confidence"]),
        refineIters=int(config["ransac_refine_iters"]),
    )
    if matrix is None or inlier_mask is None:
        raise RuntimeError("Could not solve minimap similarity transform")

    inliers_bool = inlier_mask.ravel().astype(bool)
    inliers = int(inliers_bool.sum())
    if inliers < min_inliers:
        raise RuntimeError(f"Minimap registration had only {inliers} RANSAC inliers")

    a, b, _tx = [float(v) for v in matrix[0]]
    c, d, _ty = [float(v) for v in matrix[1]]
    scale_x = math.hypot(a, c)
    scale_y = math.hypot(b, d)
    scale = (scale_x + scale_y) / 2.0
    rotation_deg = math.degrees(math.atan2(c, a))

    if not (float(config["min_scale"]) <= scale <= float(config["max_scale"])):
        raise RuntimeError(f"Implausible minimap registration scale {scale:.3f}")
    if abs(rotation_deg) > float(config["max_rotation_deg"]):
        raise RuntimeError(f"Implausible minimap registration rotation {rotation_deg:.1f} deg")

    src_in = src[inliers_bool]
    dst_in = dst[inliers_bool]
    projected = cv2.transform(src_in.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst_in, axis=1)
    median_error = float(np.median(errors)) if len(errors) else 999.0
    inlier_ratio = inliers / max(len(good), 1)

    match_score = min(1.0, inliers / float(config["confidence_match_inliers_full"]))
    ratio_score = min(1.0, inlier_ratio / float(config["confidence_inlier_ratio_full"]))
    error_floor = float(config["confidence_error_zero_px"])
    error_score = max(0.0, min(1.0, 1.0 - median_error / max(error_floor, 1e-6)))
    confidence = float(
        float(config["confidence_match_weight"]) * match_score
        + float(config["confidence_ratio_weight"]) * ratio_score
        + float(config["confidence_error_weight"]) * error_score
    )

    return RegistrationResult(
        matrix_2x3=[[float(v) for v in row] for row in matrix.tolist()],
        keypoints_current=len(kp_cur),
        keypoints_canonical=len(kp_can),
        good_matches=len(good),
        inliers=inliers,
        inlier_ratio=float(inlier_ratio),
        scale=float(scale),
        rotation_deg=float(rotation_deg),
        median_reprojection_error_px=median_error,
        confidence=confidence,
    )


def transform_point(matrix_2x3, x: float, y: float) -> tuple[float, float]:
    m = np.asarray(matrix_2x3, dtype=np.float64).reshape(2, 3)
    out = m @ np.array([float(x), float(y), 1.0], dtype=np.float64)
    return float(out[0]), float(out[1])


def canonical_position_from_hole_model(
    *,
    hole_model: dict,
    current_ball_xy: tuple[float, float],
    registration: RegistrationResult,
) -> dict:
    minimap = hole_model.get("minimap") or {}
    tee_ball = minimap.get("ball_pixel") or {}
    pin = minimap.get("pin_pixel") or {}
    yd_per_px = float(minimap.get("yards_per_pixel") or 0.0)
    if yd_per_px <= 0:
        raise ValueError("HoleModel minimap scale missing")

    cur_x, cur_y = transform_point(
        registration.matrix_2x3,
        float(current_ball_xy[0]),
        float(current_ball_xy[1]),
    )
    tee = np.array([float(tee_ball["x"]), float(tee_ball["y"])], dtype=float)
    target = np.array([float(pin["x"]), float(pin["y"])], dtype=float)
    current = np.array([cur_x, cur_y], dtype=float)

    axis = target - tee
    norm = float(np.linalg.norm(axis))
    if norm < 10.0:
        raise ValueError("Canonical tee/pin axis is invalid")
    forward_unit = axis / norm
    right_unit = np.array([-forward_unit[1], forward_unit[0]], dtype=float)
    delta = current - tee

    forward_yds = float(np.dot(delta, forward_unit) * yd_per_px)
    lateral_yds = float(np.dot(delta, right_unit) * yd_per_px)
    remaining_pin_yds = float(np.linalg.norm(target - current) * yd_per_px)

    return {
        "canonical_pixel": {"x": cur_x, "y": cur_y},
        "tee_relative_forward_yds": forward_yds,
        "tee_relative_lateral_yds": lateral_yds,
        "canonical_remaining_pin_yds": remaining_pin_yds,
    }
