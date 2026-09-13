#!/usr/bin/env python3
"""Render landing-distribution risk on the original GSPro tee minimap.

This is an offline evaluation harness, not a caddie recommendation engine.
The marked point is an EXPECTED LANDING CENTER, not a GSPro aim/reticle point.
That distinction is intentional: converting a desired landing center into an aim
heading must later account for shot bias/shape and live actuation.

Inputs:
- screenshot_strategy_geometry_v2.json (or buildable v2 geometry)
- a supplied 2-D shot spread (lateral/forward sigmas + optional correlation)
- one expected landing center plus optional left/right comparison offsets

Outputs per capture:
- strategy_risk_overlay_v0.png
- strategy_risk_overlay_v0.json

No API calls. No GSPro input. No club selection. No target recommendation.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np

import screenshot_strategy_geometry_v2 as geometry_v2
import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-strategy-risk-overlay-v0"
DEFAULT_CONTOURS = (0.80, 0.95)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def _finite(value: Any, name: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite")
    return out


def local_to_pixel(transform: dict[str, Any], lateral_yds: float, forward_yds: float) -> tuple[float, float]:
    """Inverse of strategy_risk_v0.pixel_to_local for the v2 transform contract."""
    tee = transform.get("tee_pixel") or {}
    pin = transform.get("pin_pixel") or {}
    scale = _finite(transform.get("yards_per_pixel"), "yards_per_pixel")
    if scale <= 0:
        raise ValueError("yards_per_pixel must be > 0")
    tx, ty = _finite(tee.get("x"), "tee.x"), _finite(tee.get("y"), "tee.y")
    px, py = _finite(pin.get("x"), "pin.x"), _finite(pin.get("y"), "pin.y")
    dx, dy = px - tx, py - ty
    dist = math.hypot(dx, dy)
    if dist <= 1e-9:
        raise ValueError("tee and pin pixels coincide")
    fx, fy = dx / dist, dy / dist
    rx, ry = -fy, fx
    return (
        tx + (forward_yds * fx + lateral_yds * rx) / scale,
        ty + (forward_yds * fy + lateral_yds * ry) / scale,
    )


def _cholesky_2x2(cov: tuple[tuple[float, float], tuple[float, float]]):
    a, b = cov[0]
    _, d = cov[1]
    l11 = math.sqrt(a)
    l21 = b / l11
    l22_sq = d - l21 * l21
    if l22_sq <= 0:
        raise ValueError("covariance is not positive definite")
    return ((l11, 0.0), (l21, math.sqrt(l22_sq)))


def ellipse_local_points(
    mean: tuple[float, float],
    covariance: tuple[tuple[float, float], tuple[float, float]],
    probability: float,
    *,
    count: int = 180,
) -> list[tuple[float, float]]:
    if count < 24:
        raise ValueError("ellipse point count must be >= 24")
    radius = math.sqrt(risk.contour_radius_sq(probability))
    chol = _cholesky_2x2(covariance)
    out: list[tuple[float, float]] = []
    for i in range(count):
        theta = 2.0 * math.pi * i / count
        ux, uy = radius * math.cos(theta), radius * math.sin(theta)
        lateral = mean[0] + chol[0][0] * ux
        forward = mean[1] + chol[1][0] * ux + chol[1][1] * uy
        out.append((lateral, forward))
    return out


def ellipse_pixel_points(
    transform: dict[str, Any],
    mean: tuple[float, float],
    covariance: tuple[tuple[float, float], tuple[float, float]],
    probability: float,
) -> list[list[int]]:
    return [
        [round(x), round(y)]
        for x, y in (
            local_to_pixel(transform, lateral, forward)
            for lateral, forward in ellipse_local_points(mean, covariance, probability)
        )
    ]


def candidate_label(offset_yds: float) -> str:
    if abs(offset_yds) < 1e-9:
        return "center"
    side = "right" if offset_yds > 0 else "left"
    value = abs(offset_yds)
    amount = f"{value:.0f}" if abs(value - round(value)) < 1e-9 else f"{value:.1f}"
    return f"{amount} yd {side}"


def _class_summary(hazards: list[dict[str, Any]], hazard_class: str) -> dict[str, Any]:
    rows = [row for row in hazards if row.get("hazard_class") == hazard_class]
    clearances = [float(row["center_clearance_yds"]) for row in rows if row.get("center_clearance_yds") is not None]
    sigmas = [float(row["mahalanobis_clearance_sigma"]) for row in rows if row.get("mahalanobis_clearance_sigma") is not None]
    probabilities = [float(row["estimated_landing_probability"]) for row in rows if row.get("estimated_landing_probability") is not None]
    return {
        "object_count": len(rows),
        "minimum_center_clearance_yds": min(clearances) if clearances else None,
        "minimum_mahalanobis_clearance_sigma": min(sigmas) if sigmas else None,
        "maximum_estimated_landing_probability": max(probabilities) if probabilities else None,
        "any_80pct_intersection": any(bool((row.get("ellipse_intersects_boundary") or {}).get("80pct")) for row in rows),
        "any_95pct_intersection": any(bool((row.get("ellipse_intersects_boundary") or {}).get("95pct")) for row in rows),
    }


def summarize_candidate(result: dict[str, Any], *, label: str, offset_yds: float) -> dict[str, Any]:
    hazards = list(result.get("hazard_evidence") or [])
    aggregate = result.get("aggregate") or {}
    return {
        "label": label,
        "lateral_offset_from_base_yds": float(offset_yds),
        "landing_center_local_yards": result.get("target_center_local_yards"),
        "estimated_any_bunker_probability": aggregate.get("estimated_any_bunker_probability"),
        "bunker": _class_summary(hazards, "bunker"),
        "penalty_area": _class_summary(hazards, "penalty_area"),
        "out_of_bounds": _class_summary(hazards, "out_of_bounds"),
        "boundary_probability_available": False,
        "recommendation": None,
        "strategy_authority": False,
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
        result = risk.evaluate_target(
            geometry_payload,
            center_lateral_yds=float(base_lateral_yds) + offset,
            center_forward_yds=float(base_forward_yds),
            shot_profile=shot_profile,
            sample_count=sample_count,
        )
        rows.append(summarize_candidate(result, label=candidate_label(offset), offset_yds=offset))
    return rows


def _load_geometry(capture: Path, *, force_geometry: bool = False) -> dict[str, Any]:
    path = capture / "screenshot_strategy_geometry_v2.json"
    if path.is_file() and not force_geometry:
        return read_json(path)
    return geometry_v2.build(capture, force_red=force_geometry)


def _draw_hazards(image: np.ndarray, payload: dict[str, Any]) -> None:
    colors = {
        "bunker": (255, 255, 0),
        "penalty_area": (0, 220, 255),
        "out_of_bounds": (80, 255, 80),
    }
    for row in payload.get("precise_pixel_geometry") or []:
        cls = str(row.get("hazard_class") or "")
        if cls not in colors:
            continue
        points = row.get("polygon_pixel") or []
        if len(points) < 2:
            continue
        pts = np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))
        cv2.polylines(image, [pts], cls == "bunker", colors[cls], 1, cv2.LINE_AA)


def _put_label(image: np.ndarray, text: str, x: int, y: int, color: tuple[int, int, int]) -> None:
    cv2.putText(image, text, (x + 5, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(image, text, (x + 5, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)


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
    geometry = _load_geometry(capture, force_geometry=force_geometry)
    visual = geometry.get("visual_truth") or {}
    image_path = capture / str(visual.get("source_image") or "")
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read visual truth image {image_path}")

    transform = geometry.get("coordinate_transform") or {}
    covariance = risk.covariance_from_profile(shot_profile)
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
    _draw_hazards(overlay, geometry)
    candidate_colors = [
        (255, 170, 0),
        (255, 255, 255),
        (0, 170, 255),
        (255, 0, 255),
        (0, 255, 0),
    ]
    rendered_candidates: list[dict[str, Any]] = []
    for index, (offset, summary) in enumerate(zip(offsets, comparisons)):
        mean = (float(base_lateral_yds) + offset, float(base_forward_yds))
        color = candidate_colors[index % len(candidate_colors)]
        center_px = local_to_pixel(transform, mean[0], mean[1])
        cx, cy = round(center_px[0]), round(center_px[1])
        cv2.drawMarker(overlay, (cx, cy), color, cv2.MARKER_CROSS, 12, 2, cv2.LINE_AA)
        contour_pixels: dict[str, list[list[int]]] = {}
        for probability in DEFAULT_CONTOURS:
            points = ellipse_pixel_points(transform, mean, covariance, probability)
            contour_pixels[f"{int(round(probability * 100))}pct"] = points
            pts = np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))
            thickness = 1 if probability < 0.9 else 2
            cv2.polylines(overlay, [pts], True, color, thickness, cv2.LINE_AA)
        _put_label(overlay, str(summary["label"]), cx, cy, color)
        rendered_candidates.append({
            **summary,
            "landing_center_pixel": {"x": center_px[0], "y": center_px[1]},
            "dispersion_contours_pixel": contour_pixels,
        })

    overlay_name = "strategy_risk_overlay_v0.png"
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
        "candidates": rendered_candidates,
        "overlay_artifact": overlay_name,
        "interpretation": {
            "marked_point": "expected landing center, not GSPro aim/reticle",
            "contours": "80% and 95% bivariate-normal landing contours",
            "bunker_probability": "estimated from deterministic low-discrepancy samples",
            "penalty_and_ob_probability": "unavailable until unsafe-side orientation is known",
            "comparison_only": True,
        },
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(capture / "strategy_risk_overlay_v0.json", payload)
    return payload


def _profile_from_args(args: argparse.Namespace) -> tuple[dict[str, Any], float | None, float | None]:
    profile_data: dict[str, Any] = {}
    carry_mean = None
    lateral_mean = None
    if args.profile_json:
        raw = read_json(Path(args.profile_json).expanduser().resolve())
        if isinstance(raw.get("distribution"), dict):
            raw = raw["distribution"]
        if not isinstance(raw, dict):
            raise ValueError("profile JSON must contain an object")
        profile_data = raw
        carry_mean = raw.get("carryMeanYards", raw.get("carry_mean_yards"))
        lateral_mean = raw.get("lateralMeanYards", raw.get("lateral_mean_yards"))

    sigma_lateral = args.sigma_lateral
    if sigma_lateral is None:
        sigma_lateral = profile_data.get("sigmaLateralYards", profile_data.get("sigma_lateral_yds"))
    sigma_forward = args.sigma_forward
    if sigma_forward is None:
        sigma_forward = profile_data.get("sigmaForwardYards", profile_data.get("sigma_forward_yds"))
    correlation = args.correlation
    if correlation is None:
        correlation = profile_data.get("correlation", 0.0)
    if sigma_lateral is None or sigma_forward is None:
        raise ValueError("shot spread unavailable; provide --sigma-lateral/--sigma-forward or --profile-json")
    return {
        "sigma_lateral_yds": float(sigma_lateral),
        "sigma_forward_yds": float(sigma_forward),
        "correlation": float(correlation),
    }, (float(carry_mean) if carry_mean is not None else None), (float(lateral_mean) if lateral_mean is not None else None)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render Looper landing-center risk on a saved GSPro minimap")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--profile-json")
    p.add_argument("--center-forward", type=float)
    p.add_argument("--center-lateral", type=float)
    p.add_argument("--sigma-lateral", type=float)
    p.add_argument("--sigma-forward", type=float)
    p.add_argument("--correlation", type=float)
    p.add_argument("--comparison-step", type=float, default=10.0)
    p.add_argument("--sample-count", type=int, default=risk.DEFAULT_SAMPLE_COUNT)
    p.add_argument("--force-geometry", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    shot_profile, carry_mean, lateral_mean = _profile_from_args(args)
    forward = args.center_forward if args.center_forward is not None else carry_mean
    lateral = args.center_lateral if args.center_lateral is not None else (lateral_mean if lateral_mean is not None else 0.0)
    if forward is None:
        raise ValueError("expected landing forward distance unavailable; provide --center-forward or a profile with carryMeanYards")
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
    print(f"H{hole} strategy risk overlay | candidates={len(payload['candidates'])} | {payload['overlay_artifact']}")
    for row in payload["candidates"]:
        print(
            f"  {row['label']}: bunker={row['estimated_any_bunker_probability']:.3f} "
            f"red95={row['penalty_area']['any_95pct_intersection']} "
            f"ob95={row['out_of_bounds']['any_95pct_intersection']}"
        )
    print("Comparison only. Expected landing centers are NOT GSPro aim points. Strategy authority: OFF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
