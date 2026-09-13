#!/usr/bin/env python3
"""Strategy risk overlay v1: orient carry/offline dispersion to shot direction.

v0 proved the screenshot-first rendering/risk pipeline. v1 fixes an important
coordinate issue: Looper's carry sigma is ALONG the shot and lateral sigma is
ACROSS the shot. Those axes are not necessarily the hole's tee-to-pin axes.

The marked point remains an expected landing center, NOT a GSPro aim point.
If an explicit shot heading is unavailable, v1 uses tee->landing-center direction
as a shadow approximation and records that assumption in the output.

Offline/read-only. No API calls. No GSPro input. No recommendation authority.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np

import strategy_risk_v0 as risk
import strategy_risk_overlay_v0 as v0

SCHEMA_VERSION = "looper-strategy-risk-overlay-v1"
DEFAULT_CONTOURS = (0.80, 0.95)


def _finite(value: Any, name: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite")
    return out


def _explicit_heading(profile: dict[str, Any]) -> tuple[float, float] | None:
    raw = profile.get("shot_heading_local_yards")
    if isinstance(raw, dict):
        lateral = raw.get("lateral")
        forward = raw.get("forward")
    elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
        lateral, forward = raw[0], raw[1]
    else:
        return None
    lateral = _finite(lateral, "shot heading lateral")
    forward = _finite(forward, "shot heading forward")
    if math.hypot(lateral, forward) <= 1e-9:
        raise ValueError("explicit shot heading is too small")
    return lateral, forward


def oriented_covariance(
    shot_profile: dict[str, Any],
    *,
    landing_lateral_yds: float,
    landing_forward_yds: float,
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Rotate shot-axis covariance into hole-local [lateral, forward] axes.

    Input sigma_lateral is right/left of the SHOT direction.
    Input sigma_forward is short/long ALONG the SHOT direction.
    """
    # Explicit local covariance is already in the geometry coordinate frame.
    if isinstance(shot_profile.get("covariance_local_yards2"), (list, tuple)):
        return risk.covariance_from_profile({"covariance": shot_profile["covariance_local_yards2"]})

    axis_cov = risk.covariance_from_profile(shot_profile)
    heading = _explicit_heading(shot_profile)
    if heading is None:
        heading = (float(landing_lateral_yds), float(landing_forward_yds))
    norm = math.hypot(heading[0], heading[1])
    if norm <= 1e-9:
        raise ValueError("cannot infer shot direction from a zero landing vector")

    # In local coordinate order [lateral/right, forward]:
    # along = unit shot direction
    # cross = golfer-right of shot direction
    along_lat, along_fwd = heading[0] / norm, heading[1] / norm
    cross_lat, cross_fwd = along_fwd, -along_lat

    # axis_cov is ordered [cross/lateral-of-shot, along/forward-of-shot].
    a, b = axis_cov[0]
    _, d = axis_cov[1]

    # B has basis vectors [cross, along] as columns; local_cov = B C B^T.
    m00 = cross_lat * cross_lat * a + 2.0 * cross_lat * along_lat * b + along_lat * along_lat * d
    m01 = cross_lat * cross_fwd * a + (cross_lat * along_fwd + along_lat * cross_fwd) * b + along_lat * along_fwd * d
    m11 = cross_fwd * cross_fwd * a + 2.0 * cross_fwd * along_fwd * b + along_fwd * along_fwd * d
    return ((m00, m01), (m01, m11))


def heading_basis_metadata(
    shot_profile: dict[str, Any],
    *,
    landing_lateral_yds: float,
    landing_forward_yds: float,
) -> dict[str, Any]:
    explicit = _explicit_heading(shot_profile)
    heading = explicit or (float(landing_lateral_yds), float(landing_forward_yds))
    norm = math.hypot(heading[0], heading[1])
    if norm <= 1e-9:
        raise ValueError("shot heading is too small")
    return {
        "source": "explicit-shot-heading" if explicit is not None else "tee-to-landing-center-shadow-approximation",
        "unit_local": {
            "lateral": heading[0] / norm,
            "forward": heading[1] / norm,
        },
    }


def compare_landing_centers(
    geometry_payload: dict[str, Any],
    *,
    base_lateral_yds: float,
    base_forward_yds: float,
    lateral_offsets_yds: Iterable[float],
    shot_profile: dict[str, Any],
    sample_count: int = risk.DEFAULT_SAMPLE_COUNT,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for offset in lateral_offsets_yds:
        offset = float(offset)
        lateral = float(base_lateral_yds) + offset
        forward = float(base_forward_yds)
        covariance = oriented_covariance(
            shot_profile,
            landing_lateral_yds=lateral,
            landing_forward_yds=forward,
        )
        result = risk.evaluate_target(
            geometry_payload,
            center_lateral_yds=lateral,
            center_forward_yds=forward,
            shot_profile={"covariance": [list(covariance[0]), list(covariance[1])]},
            sample_count=sample_count,
        )
        summary = v0.summarize_candidate(
            result,
            label=v0.candidate_label(offset),
            offset_yds=offset,
        )
        summary["dispersion_basis"] = heading_basis_metadata(
            shot_profile,
            landing_lateral_yds=lateral,
            landing_forward_yds=forward,
        )
        summary["covariance_local_yards2"] = [list(covariance[0]), list(covariance[1])]
        rows.append(summary)
    return rows


def build_overlay(
    capture: Path,
    *,
    base_lateral_yds: float,
    base_forward_yds: float,
    lateral_offsets_yds: Iterable[float],
    shot_profile: dict[str, Any],
    sample_count: int = risk.DEFAULT_SAMPLE_COUNT,
    force_geometry: bool = False,
) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    geometry = v0._load_geometry(capture, force_geometry=force_geometry)
    visual = geometry.get("visual_truth") or {}
    image_path = capture / str(visual.get("source_image") or "")
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read visual truth image {image_path}")

    transform = geometry.get("coordinate_transform") or {}
    offsets = [float(value) for value in lateral_offsets_yds]
    comparisons = compare_landing_centers(
        geometry,
        base_lateral_yds=base_lateral_yds,
        base_forward_yds=base_forward_yds,
        lateral_offsets_yds=offsets,
        shot_profile=shot_profile,
        sample_count=sample_count,
    )

    overlay = image.copy()
    v0._draw_hazards(overlay, geometry)
    candidate_colors = [
        (255, 170, 0),
        (255, 255, 255),
        (0, 170, 255),
        (255, 0, 255),
        (0, 255, 0),
    ]
    rendered: list[dict[str, Any]] = []
    for index, (offset, summary) in enumerate(zip(offsets, comparisons)):
        mean = (float(base_lateral_yds) + offset, float(base_forward_yds))
        covariance = (
            tuple(float(v) for v in summary["covariance_local_yards2"][0]),
            tuple(float(v) for v in summary["covariance_local_yards2"][1]),
        )
        color = candidate_colors[index % len(candidate_colors)]
        center_px = v0.local_to_pixel(transform, mean[0], mean[1])
        cx, cy = round(center_px[0]), round(center_px[1])
        cv2.drawMarker(overlay, (cx, cy), color, cv2.MARKER_CROSS, 12, 2, cv2.LINE_AA)
        contour_pixels: dict[str, list[list[int]]] = {}
        for probability in DEFAULT_CONTOURS:
            points = v0.ellipse_pixel_points(transform, mean, covariance, probability)
            contour_pixels[f"{int(round(probability * 100))}pct"] = points
            pts = np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(
                overlay,
                [pts],
                True,
                color,
                1 if probability < 0.9 else 2,
                cv2.LINE_AA,
            )
        v0._put_label(overlay, str(summary["label"]), cx, cy, color)
        rendered.append({
            **summary,
            "landing_center_pixel": {"x": center_px[0], "y": center_px[1]},
            "dispersion_contours_pixel": contour_pixels,
        })

    overlay_name = "strategy_risk_overlay_v1.png"
    cv2.imwrite(str(capture / overlay_name), overlay)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": geometry.get("identity") or {"capture_id": capture.name},
        "visual_truth": visual,
        "input": {
            "base_expected_landing_center_local_yards": {
                "lateral": float(base_lateral_yds),
                "forward": float(base_forward_yds),
            },
            "lateral_comparison_offsets_yds": offsets,
            "shot_profile": shot_profile,
            "sample_count": int(sample_count),
        },
        "candidates": rendered,
        "overlay_artifact": overlay_name,
        "interpretation": {
            "marked_point": "expected landing center, not GSPro aim/reticle",
            "dispersion_axes": "carry sigma along shot direction; lateral sigma across shot direction",
            "heading_fallback": "tee-to-landing-center direction when explicit heading is unavailable",
            "contours": "80% and 95% bivariate-normal landing contours",
            "bunker_probability": "estimated from deterministic low-discrepancy samples",
            "penalty_and_ob_probability": "unavailable until unsafe-side orientation is known",
            "comparison_only": True,
        },
        "strategy_authority": False,
        "recommendation": None,
    }
    v0.write_json(capture / "strategy_risk_overlay_v1.json", payload)
    return payload


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render direction-oriented Looper landing risk")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--profile-json")
    p.add_argument("--center-forward", type=float)
    p.add_argument("--center-lateral", type=float)
    p.add_argument("--sigma-lateral", type=float)
    p.add_argument("--sigma-forward", type=float)
    p.add_argument("--correlation", type=float)
    p.add_argument("--heading-lateral", type=float)
    p.add_argument("--heading-forward", type=float)
    p.add_argument("--comparison-step", type=float, default=10.0)
    p.add_argument("--sample-count", type=int, default=risk.DEFAULT_SAMPLE_COUNT)
    p.add_argument("--force-geometry", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    shot_profile, carry_mean, lateral_mean = v0._profile_from_args(args)
    forward = args.center_forward if args.center_forward is not None else carry_mean
    lateral = args.center_lateral if args.center_lateral is not None else (lateral_mean if lateral_mean is not None else 0.0)
    if forward is None:
        raise ValueError("expected landing forward distance unavailable; provide --center-forward or a profile with carryMeanYards")
    if (args.heading_lateral is None) != (args.heading_forward is None):
        raise ValueError("provide both --heading-lateral and --heading-forward")
    if args.heading_lateral is not None:
        shot_profile["shot_heading_local_yards"] = {
            "lateral": float(args.heading_lateral),
            "forward": float(args.heading_forward),
        }

    step = abs(float(args.comparison_step))
    offsets = [-step, 0.0, step] if step > 0 else [0.0]
    payload = build_overlay(
        Path(args.capture_dir),
        base_lateral_yds=float(lateral),
        base_forward_yds=float(forward),
        lateral_offsets_yds=offsets,
        shot_profile=shot_profile,
        sample_count=int(args.sample_count),
        force_geometry=bool(args.force_geometry),
    )
    hole = (payload.get("identity") or {}).get("hole_display", "?")
    print(f"H{hole} strategy risk overlay v1 | candidates={len(payload['candidates'])} | {payload['overlay_artifact']}")
    for row in payload["candidates"]:
        print(
            f"  {row['label']}: bunker={row['estimated_any_bunker_probability']:.3f} "
            f"red95={row['penalty_area']['any_95pct_intersection']} "
            f"ob95={row['out_of_bounds']['any_95pct_intersection']} "
            f"basis={row['dispersion_basis']['source']}"
        )
    print("Comparison only. Landing centers are NOT GSPro aim points. Strategy authority: OFF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
