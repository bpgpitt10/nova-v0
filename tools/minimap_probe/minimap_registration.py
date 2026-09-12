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

Field note: Step 11 exposed two distinct failure modes. A hard 30-match pre-gate
rejected good 20s-match captures, and one later capture produced a visually
self-consistent but impossible ~141-degree transform from repeated course texture.
The adaptive path therefore remains RANSAC-gated, while an optional shared PIN
anchor can now reject/redirect geometrically wrong descriptor consensus. Geometry
still cannot become trusted until the caller's independent PIN-distance cross-check
also passes.
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
    anchor_error_px: float | None = None

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


def _wrapped_deg(value: float) -> float:
    return (float(value) + 180.0) % 360.0 - 180.0


def _anchor_prefilter(
    good,
    kp_cur,
    kp_can,
    *,
    current_anchor_xy: tuple[float, float],
    canonical_anchor_xy: tuple[float, float],
    max_rotation_deg: float = 35.0,
):
    """Keep descriptor matches whose geometry around the shared PIN is plausible.

    For the same physical PIN in both minimaps, a correct feature match implies the
    same similarity transform when each feature is expressed as a vector from PIN.
    Repeated course texture that wants to rotate the hole ~140 degrees is removed
    before RANSAC rather than being allowed to dominate it.
    """
    cur_anchor = np.asarray(current_anchor_xy, dtype=float)
    can_anchor = np.asarray(canonical_anchor_xy, dtype=float)
    kept = []
    for match in good:
        cur = np.asarray(kp_cur[match.queryIdx].pt, dtype=float) - cur_anchor
        can = np.asarray(kp_can[match.trainIdx].pt, dtype=float) - can_anchor
        cur_norm = float(np.linalg.norm(cur))
        can_norm = float(np.linalg.norm(can))
        if cur_norm < 8.0 or can_norm < 8.0:
            continue
        scale = can_norm / cur_norm
        if not (0.15 <= scale <= 4.0):
            continue
        cur_angle = math.degrees(math.atan2(cur[1], cur[0]))
        can_angle = math.degrees(math.atan2(can[1], can[0]))
        rotation = _wrapped_deg(can_angle - cur_angle)
        if abs(rotation) <= float(max_rotation_deg):
            kept.append(match)
    return kept


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
    current_anchor_xy: tuple[float, float] | None = None,
    canonical_anchor_xy: tuple[float, float] | None = None,
    max_anchor_error_px: float = 7.0,
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

    anchor_error = None
    if current_anchor_xy is not None and canonical_anchor_xy is not None:
        cur_anchor = np.array(
            [[[float(current_anchor_xy[0]), float(current_anchor_xy[1])]]],
            dtype=np.float32,
        )
        projected_anchor = cv2.transform(cur_anchor, matrix).reshape(2)
        target_anchor = np.asarray(canonical_anchor_xy, dtype=float)
        anchor_error = float(np.linalg.norm(projected_anchor - target_anchor))
        if anchor_error > float(max_anchor_error_px):
            raise RuntimeError(
                f"Minimap registration PIN-anchor error {anchor_error:.2f}px exceeds "
                f"{float(max_anchor_error_px):.2f}px"
            )

    match_score = min(1.0, inliers / 100.0)
    ratio_score = min(1.0, inlier_ratio / 0.65)
    error_score = max(0.0, min(1.0, 1.0 - median_error / 4.0))
    anchor_score = 1.0 if anchor_error is None else max(0.0, min(1.0, 1.0 - anchor_error / max(max_anchor_error_px, 1.0)))
    confidence = float(0.30 * match_score + 0.30 * ratio_score + 0.25 * error_score + 0.15 * anchor_score)

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

    adaptive_good_floor = max(12, int(math.ceil(float(min_good_matches) * 0.60)))
    adaptive_inlier_floor = max(8, int(math.ceil(float(min_inliers) * 0.60)))
    errors: list[str] = []

    solve_common = {
        "kp_cur": kp_cur,
        "kp_can": kp_can,
        "ransac_reproj_px": ransac_reproj_px,
        "current_anchor_xy": current_anchor_xy,
        "canonical_anchor_xy": canonical_anchor_xy,
    }

    if len(strict_good) >= int(min_good_matches):
        try:
            return _solve_candidate(
                good=strict_good,
                ratio_used=ratio_test,
                mode="strict",
                min_inliers=min_inliers,
                min_inlier_ratio=min_inlier_ratio,
                max_median_reprojection_error_px=max_median_reprojection_error_px,
                **solve_common,
            )
        except Exception as exc:
            errors.append(f"strict: {exc}")

    if adaptive_good_floor <= len(strict_good) < int(min_good_matches):
        try:
            return _solve_candidate(
                good=strict_good,
                ratio_used=ratio_test,
                mode="adaptive-strict-ratio",
                min_inliers=adaptive_inlier_floor,
                min_inlier_ratio=min_inlier_ratio,
                max_median_reprojection_error_px=max_median_reprojection_error_px,
                **solve_common,
            )
        except Exception as exc:
            errors.append(f"adaptive strict-ratio: {exc}")

    relaxed_good = _good_matches(pairs, relaxed_ratio_test)
    if len(relaxed_good) >= adaptive_good_floor:
        try:
            return _solve_candidate(
                good=relaxed_good,
                ratio_used=relaxed_ratio_test,
                mode="adaptive-relaxed-ratio",
                min_inliers=adaptive_inlier_floor,
                min_inlier_ratio=max(min_inlier_ratio, 0.46),
                max_median_reprojection_error_px=max_median_reprojection_error_px,
                **solve_common,
            )
        except Exception as exc:
            errors.append(f"adaptive relaxed-ratio: {exc}")

    # Last field-safe fallback: use the shared PIN as a semantic anchor to remove
    # descriptor matches that imply impossible hole rotation around that same point.
    if current_anchor_xy is not None and canonical_anchor_xy is not None:
        anchored = _anchor_prefilter(
            relaxed_good,
            kp_cur,
            kp_can,
            current_anchor_xy=current_anchor_xy,
            canonical_anchor_xy=canonical_anchor_xy,
        )
        anchored_floor = max(9, int(math.ceil(float(min_good_matches) * 0.30)))
        anchored_inlier_floor = max(6, int(math.ceil(float(min_inliers) * 0.30)))
        if len(anchored) >= anchored_floor:
            try:
                return _solve_candidate(
                    good=anchored,
                    ratio_used=relaxed_ratio_test,
                    mode="pin-anchored-adaptive",
                    min_inliers=anchored_inlier_floor,
                    min_inlier_ratio=max(min_inlier_ratio, 0.52),
                    max_median_reprojection_error_px=min(max_median_reprojection_error_px, 2.25),
                    max_anchor_error_px=5.0,
                    **solve_common,
                )
            except Exception as exc:
                errors.append(f"pin-anchored: {exc}")
        else:
            errors.append(f"pin-anchored: only {len(anchored)} plausible matches (need {anchored_floor})")

    detail = "; ".join(errors[-4:]) if errors else "no candidate reached the adaptive floor"
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
