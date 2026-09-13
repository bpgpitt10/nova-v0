#!/usr/bin/env python3
"""Render fairway-cross-section landing comparisons on the original GSPro minimap.

This is a review harness, not a live-caddie decision engine.  It takes a supplied
shot spread and a supplied forward landing distance, finds the extracted fairway
cross-section there, and compares expected landing centers at the section center
and up to `step` yards left/right while remaining inside that extracted span.

Nothing is ranked. Nothing is called an aim point. The fairway surface itself is
still shadow geometry and therefore cannot grant strategy authority.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import strategy_fairway_section_v0 as fairway_section
import strategy_risk_overlay_v0 as overlay_v0
import strategy_risk_overlay_v1 as overlay_v1
import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-strategy-fairway-risk-overlay-v0"


def build(
    capture: Path,
    *,
    forward_yds: float,
    shot_profile: dict[str, Any],
    comparison_step_yds: float = 10.0,
    sample_count: int = risk.DEFAULT_SAMPLE_COUNT,
    force_geometry: bool = False,
) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    geometry = overlay_v0._load_geometry(capture, force_geometry=force_geometry)
    fairway = fairway_section.load_fairway(capture)
    if fairway is None:
        raise RuntimeError("fairway_surface_shadow_v0.json unavailable")
    section = fairway_section.section(geometry, fairway, forward_yds=forward_yds)
    if not section.get("available"):
        raise RuntimeError(f"fairway cross-section unavailable: {section.get('reason')}")
    probes = fairway_section.comparison_centers(section, step_yds=comparison_step_yds)
    if not probes:
        raise RuntimeError("fairway cross-section produced no comparison centers")

    visual = geometry.get("visual_truth") or {}
    image_path = capture / str(visual.get("source_image") or "")
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read visual truth image {image_path}")
    transform = geometry.get("coordinate_transform") or {}

    fairway_poly = fairway_section.fairway_polygon_pixel(fairway)
    if fairway_poly:
        cv2.polylines(
            image,
            [np.asarray(fairway_poly, dtype=np.int32).reshape((-1, 1, 2))],
            True,
            (120, 255, 120),
            2,
            cv2.LINE_AA,
        )
    overlay_v0._draw_hazards(image, geometry)

    primary = section["primary_span"]
    left_px = overlay_v0.local_to_pixel(transform, primary["left_lateral_yds"], forward_yds)
    right_px = overlay_v0.local_to_pixel(transform, primary["right_lateral_yds"], forward_yds)
    cv2.line(
        image,
        (round(left_px[0]), round(left_px[1])),
        (round(right_px[0]), round(right_px[1])),
        (0, 255, 255),
        3,
        cv2.LINE_AA,
    )

    colors = [(255, 170, 0), (255, 255, 255), (0, 170, 255)]
    candidates = []
    for index, probe in enumerate(probes):
        lateral = float(probe["lateral_yds"])
        forward = float(probe["forward_yds"])
        covariance = overlay_v1.oriented_covariance(
            shot_profile,
            landing_lateral_yds=lateral,
            landing_forward_yds=forward,
        )
        result = risk.evaluate_target(
            geometry,
            center_lateral_yds=lateral,
            center_forward_yds=forward,
            shot_profile={"covariance": [list(covariance[0]), list(covariance[1])]},
            sample_count=sample_count,
        )
        summary = overlay_v0.summarize_candidate(
            result,
            label=str(probe["label"]),
            offset_yds=lateral - float(primary["center_lateral_yds"]),
        )
        summary["landing_center_local_yards"] = {"lateral": lateral, "forward": forward}
        summary["dispersion_basis"] = overlay_v1.heading_basis_metadata(
            shot_profile,
            landing_lateral_yds=lateral,
            landing_forward_yds=forward,
        )
        summary["covariance_local_yards2"] = [list(covariance[0]), list(covariance[1])]

        color = colors[index % len(colors)]
        center_px = overlay_v0.local_to_pixel(transform, lateral, forward)
        cx, cy = round(center_px[0]), round(center_px[1])
        cv2.drawMarker(image, (cx, cy), color, cv2.MARKER_CROSS, 12, 2, cv2.LINE_AA)
        contours = {}
        for probability in (0.80, 0.95):
            points = overlay_v0.ellipse_pixel_points(
                transform,
                (lateral, forward),
                covariance,
                probability,
            )
            contours[f"{int(round(probability * 100))}pct"] = points
            cv2.polylines(
                image,
                [np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))],
                True,
                color,
                1 if probability < 0.9 else 2,
                cv2.LINE_AA,
            )
        overlay_v0._put_label(image, str(probe["label"]), cx, cy, color)
        candidates.append({
            **summary,
            "landing_center_pixel": {"x": center_px[0], "y": center_px[1]},
            "dispersion_contours_pixel": contours,
        })

    output_name = "strategy_fairway_risk_overlay_v0.png"
    cv2.imwrite(str(capture / output_name), image)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": geometry.get("identity") or {"capture_id": capture.name},
        "fairway_section": section,
        "shot_profile": shot_profile,
        "candidates": candidates,
        "overlay_artifact": output_name,
        "interpretation": {
            "yellow_cross_section": "widest extracted fairway span at supplied forward distance; geometry convenience only",
            "candidate_points": "expected landing centers, not GSPro aim/reticle positions",
            "candidate_ranking": "none",
            "fairway_authority": "shadow only",
            "penalty_and_ob_probability": "not claimed until unsafe-side orientation is known",
        },
        "strategy_authority": False,
        "recommendation": None,
    }
    overlay_v0.write_json(capture / "strategy_fairway_risk_overlay_v0.json", payload)
    return payload


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render fairway-centered landing-distribution comparisons")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--profile-json")
    p.add_argument("--center-forward", type=float)
    p.add_argument("--sigma-lateral", type=float)
    p.add_argument("--sigma-forward", type=float)
    p.add_argument("--correlation", type=float)
    p.add_argument("--comparison-step", type=float, default=10.0)
    p.add_argument("--sample-count", type=int, default=risk.DEFAULT_SAMPLE_COUNT)
    p.add_argument("--force-geometry", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    shot_profile, carry_mean, _ = overlay_v0._profile_from_args(args)
    forward = args.center_forward if args.center_forward is not None else carry_mean
    if forward is None:
        raise ValueError("landing forward distance unavailable; provide --center-forward or profile carryMeanYards")
    payload = build(
        Path(args.capture_dir),
        forward_yds=float(forward),
        shot_profile=shot_profile,
        comparison_step_yds=float(args.comparison_step),
        sample_count=int(args.sample_count),
        force_geometry=bool(args.force_geometry),
    )
    hole = (payload.get("identity") or {}).get("hole_display", "?")
    span = payload["fairway_section"]["primary_span"]
    print(
        f"H{hole} fairway risk overlay | forward={float(forward):.1f} yd | "
        f"fairway_width={float(span['width_yds']):.1f} yd | candidates={len(payload['candidates'])}"
    )
    for candidate in payload["candidates"]:
        print(
            f"  {candidate['label']}: bunker={candidate['estimated_any_bunker_probability']:.3f} "
            f"red95={candidate['penalty_area']['any_95pct_intersection']} "
            f"ob95={candidate['out_of_bounds']['any_95pct_intersection']}"
        )
    print("Comparison only. No target ranking. No GSPro aim actuation. Strategy authority: OFF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
