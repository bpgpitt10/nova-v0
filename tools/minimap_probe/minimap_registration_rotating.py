#!/usr/bin/env python3
"""Field-safe registration wrapper for large GSPro minimap rotations.

Step 11 upload review proved the late-approach ~141 degree transform was not a false
texture match. The player had finished beyond/left of the pin, and GSPro rotated the
minimap to keep the target ahead. Warping the saved approach back with that transform
aligns the green/bunker and maps the ball to a physically plausible point ~21 yd
beyond/left of the canonical pin.

The base registrar remains first choice. This wrapper only adds a large-rotation
fallback when a shared PIN anchor is available and descriptor evidence is unusually
strong: >=12 strict-ratio inliers, >=0.60 inlier ratio, <=1.25 px median reprojection
error, <=3 px PIN-anchor error, and plausible scale. Strategy authority is unchanged;
the caller still performs its independent PIN-distance cross-check.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

import minimap_registration as base

RegistrationResult = base.RegistrationResult
canonical_position_from_hole_model = base.canonical_position_from_hole_model
transform_point = base.transform_point


def _wide_rotation_fallback(
    current_bgr: np.ndarray,
    canonical_bgr: np.ndarray,
    *,
    ratio_test: float,
    ransac_reproj_px: float,
    current_anchor_xy: tuple[float, float],
    canonical_anchor_xy: tuple[float, float],
) -> RegistrationResult:
    current_gray = cv2.cvtColor(current_bgr, cv2.COLOR_BGR2GRAY)
    canonical_gray = cv2.cvtColor(canonical_bgr, cv2.COLOR_BGR2GRAY)

    sift = cv2.SIFT_create()
    kp_cur, des_cur = sift.detectAndCompute(current_gray, base._play_mask(current_gray.shape))
    kp_can, des_can = sift.detectAndCompute(canonical_gray, base._play_mask(canonical_gray.shape))
    if des_cur is None or des_can is None:
        raise RuntimeError("Could not compute enough minimap features for wide-rotation registration")

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(des_cur, des_can, k=2)
    good = base._good_matches(pairs, ratio_test)
    if len(good) < 12:
        raise RuntimeError(
            f"Wide-rotation registration had only {len(good)} strict feature matches (need >=12)"
        )

    src = np.float32([kp_cur[m.queryIdx].pt for m in good])
    dst = np.float32([kp_can[m.trainIdx].pt for m in good])
    matrix, inlier_mask = cv2.estimateAffinePartial2D(
        src,
        dst,
        method=cv2.RANSAC,
        ransacReprojThreshold=float(ransac_reproj_px),
        maxIters=4000,
        confidence=0.997,
        refineIters=25,
    )
    if matrix is None or inlier_mask is None:
        raise RuntimeError("Could not solve wide-rotation minimap similarity transform")

    inliers_bool = inlier_mask.ravel().astype(bool)
    inliers = int(inliers_bool.sum())
    inlier_ratio = inliers / max(len(good), 1)
    if inliers < 12:
        raise RuntimeError(f"Wide-rotation registration had only {inliers} RANSAC inliers (need >=12)")
    if inlier_ratio < 0.60:
        raise RuntimeError(
            f"Wide-rotation registration inlier ratio {inlier_ratio:.2f} below 0.60"
        )

    a, b, _tx = [float(v) for v in matrix[0]]
    c, d, _ty = [float(v) for v in matrix[1]]
    scale = (math.hypot(a, c) + math.hypot(b, d)) / 2.0
    rotation_deg = math.degrees(math.atan2(c, a))
    if not (0.15 <= scale <= 4.0):
        raise RuntimeError(f"Implausible wide-rotation minimap scale {scale:.3f}")

    src_in = src[inliers_bool]
    dst_in = dst[inliers_bool]
    projected = cv2.transform(src_in.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst_in, axis=1)
    median_error = float(np.median(errors)) if len(errors) else 999.0
    if median_error > 1.25:
        raise RuntimeError(
            f"Wide-rotation median reprojection error {median_error:.2f}px exceeds 1.25px"
        )

    cur_anchor = np.array(
        [[[float(current_anchor_xy[0]), float(current_anchor_xy[1])]]],
        dtype=np.float32,
    )
    projected_anchor = cv2.transform(cur_anchor, matrix).reshape(2)
    target_anchor = np.asarray(canonical_anchor_xy, dtype=float)
    anchor_error = float(np.linalg.norm(projected_anchor - target_anchor))
    if anchor_error > 3.0:
        raise RuntimeError(
            f"Wide-rotation PIN-anchor error {anchor_error:.2f}px exceeds 3.00px"
        )

    match_score = min(1.0, inliers / 30.0)
    ratio_score = min(1.0, inlier_ratio / 0.75)
    error_score = max(0.0, min(1.0, 1.0 - median_error / 1.25))
    anchor_score = max(0.0, min(1.0, 1.0 - anchor_error / 3.0))
    confidence = float(
        0.25 * match_score + 0.30 * ratio_score + 0.25 * error_score + 0.20 * anchor_score
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
        ratio_test_used=float(ratio_test),
        acceptance_mode="pin-anchored-wide-rotation",
        anchor_error_px=anchor_error,
    )


def register_current_to_canonical(
    current_bgr: np.ndarray,
    canonical_bgr: np.ndarray,
    *,
    ratio_test: float = 0.72,
    relaxed_ratio_test: float = 0.78,
    ransac_reproj_px: float = 3.0,
    min_good_matches: int = 30,
    min_inliers: int = 20,
    min_inlier_ratio: float = 0.42,
    max_median_reprojection_error_px: float = 2.75,
    current_anchor_xy: tuple[float, float] | None = None,
    canonical_anchor_xy: tuple[float, float] | None = None,
) -> RegistrationResult:
    try:
        return base.register_current_to_canonical(
            current_bgr,
            canonical_bgr,
            ratio_test=ratio_test,
            relaxed_ratio_test=relaxed_ratio_test,
            ransac_reproj_px=ransac_reproj_px,
            min_good_matches=min_good_matches,
            min_inliers=min_inliers,
            min_inlier_ratio=min_inlier_ratio,
            max_median_reprojection_error_px=max_median_reprojection_error_px,
            current_anchor_xy=current_anchor_xy,
            canonical_anchor_xy=canonical_anchor_xy,
        )
    except Exception as base_error:
        if current_anchor_xy is None or canonical_anchor_xy is None:
            raise
        try:
            return _wide_rotation_fallback(
                current_bgr,
                canonical_bgr,
                ratio_test=ratio_test,
                ransac_reproj_px=ransac_reproj_px,
                current_anchor_xy=current_anchor_xy,
                canonical_anchor_xy=canonical_anchor_xy,
            )
        except Exception as wide_error:
            raise RuntimeError(
                f"Base registration failed: {base_error}; wide-rotation fallback failed: {wide_error}"
            ) from wide_error
