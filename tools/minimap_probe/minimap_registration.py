#!/usr/bin/env python3
"""Register a later GSPro minimap back into the calibrated tee coordinate system.

GSPro's minimap behaves like a 2D map that is translated, scaled, and can rotate as
the player advances. A post-tee minimap can therefore be aligned to the cached tee
minimap with a similarity transform (scale + rotation + translation).

The calibrated tee frame is authoritative. Post-shot zoom does not need a new yard
ruler if the current minimap can be registered back to that frame. For automatic
aiming, use ``register_current_to_canonical_verified`` so the transform is also
checked against the independently detected white pin marker before any click.
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

    def to_dict(self) -> dict:
        return asdict(self)


def _play_mask(shape: tuple[int, int]) -> np.ndarray:
    """Mask title/footer UI while retaining the course imagery."""
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    y0 = int(round(h * 0.105))
    y1 = int(round(h * 0.945))
    cv2.rectangle(mask, (0, y0), (w - 1, max(y0, y1 - 1)), 255, -1)
    return mask


def register_current_to_canonical(
    current_bgr: np.ndarray,
    canonical_bgr: np.ndarray,
    *,
    ratio_test: float = 0.72,
    ransac_reproj_px: float = 3.0,
    min_good_matches: int = 30,
    min_inliers: int = 20,
    max_rotation_deg: float = 40.0,
) -> RegistrationResult:
    """Solve current-minimap pixels -> canonical-tee pixels.

    The default evidence thresholds remain conservative. The verified wrapper below
    deliberately allows fewer feature matches because its pin-marker cross-check is
    a second independent acceptance gate.
    """
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
    good = [m for m, n in pairs if m.distance < float(ratio_test) * n.distance]
    if len(good) < int(min_good_matches):
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
        ransacReprojThreshold=float(ransac_reproj_px),
        maxIters=3000,
        confidence=0.995,
        refineIters=20,
    )
    if matrix is None or inlier_mask is None:
        raise RuntimeError("Could not solve minimap similarity transform")

    inliers_bool = inlier_mask.ravel().astype(bool)
    inliers = int(inliers_bool.sum())
    if inliers < int(min_inliers):
        raise RuntimeError(f"Minimap registration had only {inliers} RANSAC inliers")

    a, b, _tx = [float(v) for v in matrix[0]]
    c, d, _ty = [float(v) for v in matrix[1]]
    scale_x = math.hypot(a, c)
    scale_y = math.hypot(b, d)
    scale = (scale_x + scale_y) / 2.0
    rotation_deg = math.degrees(math.atan2(c, a))

    if not (0.15 <= scale <= 4.0):
        raise RuntimeError(f"Implausible minimap registration scale {scale:.3f}")
    if abs(rotation_deg) > float(max_rotation_deg):
        raise RuntimeError(
            f"Implausible minimap registration rotation {rotation_deg:.1f} deg "
            f"(limit {max_rotation_deg:.1f})"
        )

    src_in = src[inliers_bool]
    dst_in = dst[inliers_bool]
    projected = cv2.transform(src_in.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst_in, axis=1)
    median_error = float(np.median(errors)) if len(errors) else 999.0
    inlier_ratio = inliers / max(len(good), 1)

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
    )


def transform_point(matrix_2x3, x: float, y: float) -> tuple[float, float]:
    m = np.asarray(matrix_2x3, dtype=np.float64).reshape(2, 3)
    out = m @ np.array([float(x), float(y), 1.0], dtype=np.float64)
    return float(out[0]), float(out[1])


def verify_registration_pin(
    registration: RegistrationResult,
    *,
    current_pin_xy: tuple[float, float],
    canonical_pin_xy: tuple[float, float],
    max_pin_error_px: float = 5.0,
) -> float:
    """Cross-check a solved transform using the independent white pin marker."""
    mapped = transform_point(
        registration.matrix_2x3,
        float(current_pin_xy[0]),
        float(current_pin_xy[1]),
    )
    error_px = math.hypot(
        mapped[0] - float(canonical_pin_xy[0]),
        mapped[1] - float(canonical_pin_xy[1]),
    )
    if error_px > float(max_pin_error_px):
        raise RuntimeError(
            f"Minimap registration pin cross-check missed by {error_px:.1f}px "
            f"(limit {max_pin_error_px:.1f}px)"
        )
    return float(error_px)


def register_current_to_canonical_verified(
    current_bgr: np.ndarray,
    canonical_bgr: np.ndarray,
    *,
    current_pin_xy: tuple[float, float],
    canonical_pin_xy: tuple[float, float],
    ratio_test: float = 0.72,
    ransac_reproj_px: float = 3.0,
    min_good_matches: int = 10,
    min_inliers: int = 8,
    max_rotation_deg: float = 40.0,
    max_pin_error_px: float = 5.0,
) -> tuple[RegistrationResult, float]:
    """Solve a zoom transform and fail closed unless the pin lands correctly.

    This is the preferred Auto Aim path. The independent pin check allows valid
    strongly-zoomed frames with relatively few shared visual features to pass while
    rejecting visually plausible but wrong-hole/wrong-region registrations.
    """
    registration = register_current_to_canonical(
        current_bgr,
        canonical_bgr,
        ratio_test=ratio_test,
        ransac_reproj_px=ransac_reproj_px,
        min_good_matches=min_good_matches,
        min_inliers=min_inliers,
        max_rotation_deg=max_rotation_deg,
    )
    pin_error_px = verify_registration_pin(
        registration,
        current_pin_xy=current_pin_xy,
        canonical_pin_xy=canonical_pin_xy,
        max_pin_error_px=max_pin_error_px,
    )
    return registration, pin_error_px


def canonical_position_from_hole_model(
    *,
    hole_model: dict,
    current_ball_xy: tuple[float, float],
    registration: RegistrationResult,
    canonical_yards_per_pixel: float | None = None,
) -> dict:
    """Express current ball in canonical pixels and calibrated tee-frame yards.

    ``canonical_yards_per_pixel`` should be the waypoint/par-3 scale resolved from
    the tee screenshot. The old HoleModel value is retained only as a compatibility
    fallback for callers that have not yet adopted waypoint calibration.
    """
    minimap = hole_model.get("minimap") or {}
    tee_ball = minimap.get("ball_pixel") or {}
    pin = minimap.get("pin_pixel") or {}
    yd_per_px = (
        float(canonical_yards_per_pixel)
        if canonical_yards_per_pixel is not None
        else float(minimap.get("yards_per_pixel") or 0.0)
    )
    if yd_per_px <= 0:
        raise ValueError("Calibrated canonical minimap scale missing")

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
        "canonical_yards_per_pixel": yd_per_px,
    }
