#!/usr/bin/env python3
"""Register a later GSPro minimap back into the tee HoleModel coordinate system.

GSPro's minimap behaves like a 2D map that is translated, scaled, and can rotate a
few degrees as the player advances. That means a post-tee minimap can be aligned to
the cached tee minimap using image features and a similarity transform
(scale + rotation + translation).

Why this matters:
- the tee HoleModel already owns hazards + target-green geometry in canonical pixels;
- after registration, the current ball can be expressed in those same pixels;
- downstream recommendation logic can then reason about hazards relative to the
  *current* ball without re-extracting the whole hole every shot.

The implementation deliberately uses estimateAffinePartial2D rather than a free
homography because the observed GSPro geometry is a scaled/rotated 2D map. A more
flexible projective transform could overfit dynamic UI/markers.

Field note: a hard 30-match pre-gate rejected otherwise promising live captures.
Registration now has an adaptive low-match path, but it is still gated by RANSAC
inlier ratio/reprojection quality and the caller's independent PIN-distance
cross-check before geometry can become trusted.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import math

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
    ratio_test_used: float
    acceptance_mode: str

    def to_dict(self) -> dict:
        return asdict(self)


def _play_mask(shape: tuple[int, int]) -> np.ndarray:
    """Mask out minimap title/footer UI while keeping the course imagery."""
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    y0 = int(round(h * 0.105))
    y1 = int(round(h * 0.945))
    cv2.rectangle(mask, (0, y0), (w - 1, max(y0, y1 - 1)), 255, -1)
    return mask


def _good_matches(pairs, ratio: float):
    return [m for m, n in pairs if m.distance < float(ratio) * n.distance]


def _solve_candidate(
    *,
    good,
    kp_cur,
    kp_can,
    ratio_used: float,
    mode: str,
    ransac_reproj_px: float,
    min_inliers: int,
    min_inlier_ratio: float,
    max_median_reprojection_error_px: float,
):
    src = np.float32([kp_cur[m.queryIdx].pt for m in good])
    dst = np.float32([kp_can[m.trainIdx].pt for m in good])
    matrix, inlier_mask = cv2.estimateAffinePartial2D(
        src,
        dst,
        method=cv2.RANSAC,
        ransacReprojThreshold=float(ransac_reproj_px),
        maxIters=3000,
        confidence=0.995,
        refineIters=20,
    )
    if matrix is None or inlier_mask is None:
        raise RuntimeError("Could not solve minimap similarity transform")

    inliers_bool = inlier_mask.ravel().astype(bool)
    inliers = int(inliers_bool.sum())
    inlier_ratio = inliers / max(len(good), 1)
    if inliers < int(min_inliers):
        raise RuntimeError(
            f"Minimap registration had only {inliers} RANSAC inliers "
            f"from {len(good)} matches"
        )
    if inlier_ratio < float(min_inlier_ratio):
        raise RuntimeError(
            f"Minimap registration inlier ratio {inlier_ratio:.2f} below "
            f"{float(min_inlier_ratio):.2f}"
        )

    a, b, _tx = [float(v) for v in matrix[0]]
    c, d, _ty = [float(v) for v in matrix[1]]
    # estimateAffinePartial2D should produce [[s cos,-s sin],[s sin,s cos]].
    scale_x = math.hypot(a, c)
    scale_y = math.hypot(b, d)
    scale = (scale_x + scale_y) / 2.0
    rotation_deg = math.degrees(math.atan2(c, a))

    if not (0.15 <= scale <= 4.0):
        raise RuntimeError(f"Implausible minimap registration scale {scale:.3f}")
    if abs(rotation_deg) > 30.0:
        raise RuntimeError(f"Implausible minimap registration rotation {rotation_deg:.1f} deg")

    src_in = src[inliers_bool]
    dst_in = dst[inliers_bool]
    projected = cv2.transform(src_in.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst_in, axis=1)
    median_error = float(np.median(errors)) if len(errors) else 999.0
    if median_error > float(max_median_reprojection_error_px):
        raise RuntimeError(
            f"Minimap registration median reprojection error {median_error:.2f}px exceeds "
            f"{float(max_median_reprojection_error_px):.2f}px"
        )

    # A simple bounded confidence score for debug/gating, not a probabilistic claim.
    match_score = min(1.0, inliers / 100.0)
    ratio_score = min(1.0, inlier_ratio / 0.65)
    error_score = max(0.0, min(1.0, 1.0 - median_error / 4.0))
    confidence = float(0.35 * match_score + 0.35 * ratio_score + 0.30 * error_score)

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
        ratio_test_used=float(ratio_used),
        acceptance_mode=mode,
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
) -> RegistrationResult:
    if current_bgr is None or canonical_bgr is None:
        raise ValueError("registration images are missing")

    current_gray = cv2.cvtColor(current_bgr, cv2.COLOR_BGR2GRAY)
    canonical_gray = cv2.cvtColor(canonical_bgr, cv2.COLOR_BGR2GRAY)

    sift = cv2.SIFT_create()
    kp_cur, des_cur = sift.detectAndCompute(current_gray, _play_mask(current_gray.shape))
    kp_can, des_can = sift.detectAndCompute(canonical_gray, _play_mask(canonical_gray.shape))
    if des_cur is None or des_can is None:
        raise RuntimeError("Could not compute enough minimap features for registration")

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(des_cur, des_can, k=2)
    strict_good = _good_matches(pairs, ratio_test)

    # Default live threshold remains the preferred path. The adaptive floor exists
    # specifically for the 20s-match regime observed in Step 11 field evidence.
    adaptive_good_floor = max(12, int(math.ceil(float(min_good_matches) * 0.60)))
    adaptive_inlier_floor = max(8, int(math.ceil(float(min_inliers) * 0.60)))
    errors: list[str] = []

    if len(strict_good) >= int(min_good_matches):
        try:
            return _solve_candidate(
                good=strict_good,
                kp_cur=kp_cur,
                kp_can=kp_can,
                ratio_used=ratio_test,
                mode="strict",
                ransac_reproj_px=ransac_reproj_px,
                min_inliers=min_inliers,
                min_inlier_ratio=min_inlier_ratio,
                max_median_reprojection_error_px=max_median_reprojection_error_px,
            )
        except Exception as exc:
            errors.append(f"strict: {exc}")

    # If the strict ratio found a useful but sub-30 set, try it first with stronger
    # transform-quality gates instead of discarding it before RANSAC.
    if adaptive_good_floor <= len(strict_good) < int(min_good_matches):
        try:
            return _solve_candidate(
                good=strict_good,
                kp_cur=kp_cur,
                kp_can=kp_can,
                ratio_used=ratio_test,
                mode="adaptive-strict-ratio",
                ransac_reproj_px=ransac_reproj_px,
                min_inliers=adaptive_inlier_floor,
                min_inlier_ratio=min_inlier_ratio,
                max_median_reprojection_error_px=max_median_reprojection_error_px,
            )
        except Exception as exc:
            errors.append(f"adaptive strict-ratio: {exc}")

    relaxed_good = _good_matches(pairs, relaxed_ratio_test)
    if len(relaxed_good) >= adaptive_good_floor:
        try:
            return _solve_candidate(
                good=relaxed_good,
                kp_cur=kp_cur,
                kp_can=kp_can,
                ratio_used=relaxed_ratio_test,
                mode="adaptive-relaxed-ratio",
                ransac_reproj_px=ransac_reproj_px,
                min_inliers=adaptive_inlier_floor,
                min_inlier_ratio=max(min_inlier_ratio, 0.46),
                max_median_reprojection_error_px=max_median_reprojection_error_px,
            )
        except Exception as exc:
            errors.append(f"adaptive relaxed-ratio: {exc}")

    detail = "; ".join(errors[-3:]) if errors else "no candidate reached the adaptive floor"
    raise RuntimeError(
        f"Minimap registration could not validate a transform: "
        f"strict_matches={len(strict_good)}, relaxed_matches={len(relaxed_good)}, "
        f"adaptive_floor={adaptive_good_floor}; {detail}"
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
    """Express the current ball in canonical pixels and tee-relative yards."""
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
    # Screen-space vector pointing to the player's right when tee->pin is forward.
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
