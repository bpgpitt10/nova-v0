#!/usr/bin/env python3
"""Strategy-field composition for Looper screenshot-first course management.

This module sits ABOVE carry-arc surface extraction and ABOVE trusted screenshot
hazard geometry, but BELOW the eventual recommendation/aim engine.

It deliberately does not pick a club or aim point.  Its job is to convert:
  * course evidence: radial current-hole fairway slices + known hazards;
  * player evidence: carry/bias/dispersion in shot-aligned coordinates;
  * gameplay context: wind/lie/elevation metadata (passed through, not yet applied)
into candidate aim-direction evidence that a later decision engine can score.

Important architectural rule: an aim target and an expected landing mean are NOT the
same thing. Player bias is rotated with the chosen aim direction before risk is
evaluated in hole-local coordinates.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable

import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-strategy-field-v0"
DEFAULT_AIM_GRID = tuple(i / 8 for i in range(9))
AIM_DOMAIN_SIGMAS = 2.0
DEFAULT_SAMPLE_COUNT = 2048


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


def _wrap_angle(value: float) -> float:
    while value <= -math.pi:
        value += 2.0 * math.pi
    while value > math.pi:
        value -= 2.0 * math.pi
    return value


def _angle_delta(target: float, reference: float) -> float:
    return _wrap_angle(target - reference)


def _local_angle(lateral: float, forward: float) -> float:
    """Angle from hole-local forward axis; golfer-right is positive."""
    return math.atan2(float(lateral), float(forward))


def _point_on_radius(radius_yds: float, angle_rad: float) -> tuple[float, float]:
    return radius_yds * math.sin(angle_rad), radius_yds * math.cos(angle_rad)


def _shot_to_hole_vector(lateral: float, forward: float, aim_angle_rad: float) -> tuple[float, float]:
    """Rotate a shot-aligned [right, downrange] vector into hole-local coordinates."""
    c = math.cos(aim_angle_rad)
    s = math.sin(aim_angle_rad)
    return lateral * c + forward * s, -lateral * s + forward * c


def _rotate_covariance(cov: tuple[tuple[float, float], tuple[float, float]], angle_rad: float) -> list[list[float]]:
    """Rotate shot-frame covariance into hole-local [lateral, forward] coordinates."""
    c = math.cos(angle_rad)
    s = math.sin(angle_rad)
    # M maps [shot lateral, shot forward] -> [hole lateral, hole forward].
    m00, m01 = c, s
    m10, m11 = -s, c
    a, b = cov[0]
    _, d = cov[1]
    # M C M^T for symmetric C=[[a,b],[b,d]].
    r00 = m00 * (a * m00 + b * m01) + m01 * (b * m00 + d * m01)
    r01 = m00 * (a * m10 + b * m11) + m01 * (b * m10 + d * m11)
    r11 = m10 * (a * m10 + b * m11) + m11 * (b * m10 + d * m11)
    return [[r00, r01], [r01, r11]]


def normalize_player_profile(profile: dict[str, Any]) -> dict[str, Any]:
    carry = _finite(profile.get("carry_mean_yds"), "carry_mean_yds")
    if carry <= 0:
        raise ValueError("carry_mean_yds must be > 0")
    carry_sigma = _finite(profile.get("carry_sigma_yds"), "carry_sigma_yds")
    lateral_sigma = _finite(profile.get("lateral_sigma_yds"), "lateral_sigma_yds")
    if carry_sigma <= 0 or lateral_sigma <= 0:
        raise ValueError("carry_sigma_yds and lateral_sigma_yds must be > 0")
    rho = _finite(profile.get("correlation", 0.0), "correlation")
    if not -0.999 < rho < 0.999:
        raise ValueError("correlation must be between -0.999 and 0.999")
    lateral_bias = _finite(profile.get("mean_lateral_bias_yds", 0.0), "mean_lateral_bias_yds")
    forward_bias = _finite(profile.get("mean_forward_bias_yds", 0.0), "mean_forward_bias_yds")
    return {
        "club": profile.get("club"),
        "variant": profile.get("variant", "stock"),
        "carry_mean_yds": carry,
        "carry_sigma_yds": carry_sigma,
        "lateral_sigma_yds": lateral_sigma,
        "correlation": rho,
        "mean_lateral_bias_yds": lateral_bias,
        "mean_forward_bias_yds": forward_bias,
        "source": profile.get("source"),
    }


def _span_interval(span: dict[str, Any]) -> dict[str, Any] | None:
    if not span.get("accepted"):
        return None
    left = span.get("left_local_yards") or {}
    right = span.get("right_local_yards") or {}
    try:
        a = _local_angle(_finite(left.get("lateral"), "left.lateral"), _finite(left.get("forward"), "left.forward"))
        b = _local_angle(_finite(right.get("lateral"), "right.lateral"), _finite(right.get("forward"), "right.forward"))
    except Exception:
        return None
    delta = _wrap_angle(b - a)
    center = _wrap_angle(a + 0.5 * delta)
    half = abs(delta) * 0.5
    return {
        "span_id": span.get("span_id"),
        "surface_class": span.get("surface_class", "fairway"),
        "angle_a_rad": a,
        "angle_b_rad": b,
        "center_angle_rad": center,
        "half_width_rad": half,
        "semantic_confidence": span.get("semantic_confidence"),
    }


def normalize_arc_slice(payload: dict[str, Any]) -> dict[str, Any]:
    carry = _finite(payload.get("carry_yds"), "carry_yds")
    intervals = []
    for span in payload.get("spans") or []:
        row = _span_interval(span)
        if row is not None:
            intervals.append(row)
    return {
        "carry_yds": carry,
        "accepted_span_count": len(intervals),
        "intervals": intervals,
        "source_schema_version": payload.get("schema_version"),
        "source_prompt_revision": payload.get("prompt_revision"),
        "overlay_artifact": payload.get("overlay_artifact"),
        "strategy_authority": False,
    }


def _contains(interval: dict[str, Any], angle_rad: float) -> bool:
    return abs(_angle_delta(angle_rad, float(interval["center_angle_rad"]))) <= float(interval["half_width_rad"]) + 1e-9


def _angular_edge_margin(interval: dict[str, Any], angle_rad: float) -> float:
    return float(interval["half_width_rad"]) - abs(_angle_delta(angle_rad, float(interval["center_angle_rad"])))


def surface_support(slices: list[dict[str, Any]], angle_rad: float) -> dict[str, Any]:
    rows = []
    supported = 0
    for sl in slices:
        matches = [interval for interval in sl["intervals"] if _contains(interval, angle_rad)]
        best = max(matches, key=lambda x: _angular_edge_margin(x, angle_rad)) if matches else None
        if best is not None:
            supported += 1
        rows.append({
            "carry_yds": sl["carry_yds"],
            "on_current_hole_fairway": best is not None,
            "matched_span_id": best.get("span_id") if best else None,
            "angular_edge_margin_deg": math.degrees(_angular_edge_margin(best, angle_rad)) if best else None,
            "approx_lateral_edge_margin_yds": (sl["carry_yds"] * _angular_edge_margin(best, angle_rad)) if best else None,
        })
    return {
        "slice_support_count": supported,
        "slice_count": len(slices),
        "slice_support_fraction": (supported / len(slices)) if slices else None,
        "note": "Discrete radial-slice support proxy; this is not a fairway landing probability.",
        "slices": rows,
    }


def _fraction_angle(interval: dict[str, Any], fraction: float) -> float:
    f = max(0.0, min(1.0, float(fraction)))
    a = float(interval["angle_a_rad"])
    delta = _wrap_angle(float(interval["angle_b_rad"]) - a)
    return _wrap_angle(a + f * delta)


def recommended_probe_carries(player_profile: dict[str, Any], sigmas: Iterable[float] = (-2, -1, 0, 1, 2)) -> list[float]:
    """Carry radii that expose the longitudinal shape of this player's landing distribution.

    These are extraction/query distances only, never club or aim recommendations.
    """
    p = normalize_player_profile(player_profile)
    values = {max(1.0, p["carry_mean_yds"] + float(z) * p["carry_sigma_yds"]) for z in sigmas}
    return sorted(values)


def candidate_angles(slices: list[dict[str, Any]], player_profile: dict[str, Any],
                     fractions: Iterable[float] = DEFAULT_AIM_GRID,
                     domain_sigmas: float = AIM_DOMAIN_SIGMAS) -> tuple[float | None, list[dict[str, Any]]]:
    """Seed an aim-search domain around the current-hole route, not merely inside fairway.

    The nearest fairway interval supplies route geometry.  We then expand each side by
    the player's absolute stock bias plus ``domain_sigmas`` lateral sigmas.  This is a
    search domain only: candidates may intentionally lie outside the fairway.
    """
    p = normalize_player_profile(player_profile)
    eligible = [sl for sl in slices if sl["intervals"]]
    if not eligible:
        return None, []
    source = min(eligible, key=lambda sl: abs(sl["carry_yds"] - p["carry_mean_yds"]))
    buffer_yds = abs(p["mean_lateral_bias_yds"]) + float(domain_sigmas) * p["lateral_sigma_yds"]
    buffer_angle = math.atan2(buffer_yds, max(1.0, p["carry_mean_yds"]))
    rows = []
    seen = set()
    candidate_id = 0
    for interval in source["intervals"]:
        center = float(interval["center_angle_rad"])
        half = float(interval["half_width_rad"])
        domain_half = min(math.pi * 0.49, half + buffer_angle)
        for fraction in fractions:
            f = max(0.0, min(1.0, float(fraction)))
            angle = _wrap_angle(center + (2.0 * f - 1.0) * domain_half)
            key = round(angle, 8)
            if key in seen:
                continue
            seen.add(key)
            candidate_id += 1
            rows.append({
                "candidate_id": candidate_id,
                "source_carry_yds": source["carry_yds"],
                "source_span_id": interval.get("span_id"),
                "fraction_across_search_domain": f,
                "aim_angle_rad": angle,
                "inside_source_fairway": _contains(interval, angle),
                "search_domain": {
                    "basis": "source fairway interval expanded by player bias + lateral dispersion",
                    "lateral_buffer_yds": buffer_yds,
                    "domain_sigmas": float(domain_sigmas),
                    "angular_buffer_deg": math.degrees(buffer_angle),
                },
            })
    return source["carry_yds"], rows


def player_distribution_for_aim(profile: dict[str, Any], aim_angle_rad: float) -> dict[str, Any]:
    p = normalize_player_profile(profile)
    aim_center = _point_on_radius(p["carry_mean_yds"], aim_angle_rad)
    bias_local = _shot_to_hole_vector(
        p["mean_lateral_bias_yds"],
        p["mean_forward_bias_yds"],
        aim_angle_rad,
    )
    mean = (aim_center[0] + bias_local[0], aim_center[1] + bias_local[1])
    cov_shot = risk.covariance_from_profile({
        "sigma_lateral_yds": p["lateral_sigma_yds"],
        "sigma_forward_yds": p["carry_sigma_yds"],
        "correlation": p["correlation"],
    })
    covariance_local = _rotate_covariance(cov_shot, aim_angle_rad)
    return {
        "intended_aim_center_local_yards": {"lateral": aim_center[0], "forward": aim_center[1]},
        "expected_landing_mean_local_yards": {"lateral": mean[0], "forward": mean[1]},
        "expected_mean_angle_rad": _local_angle(mean[0], mean[1]),
        "player_bias_shot_frame_yds": {
            "lateral": p["mean_lateral_bias_yds"],
            "forward": p["mean_forward_bias_yds"],
        },
        "covariance_hole_local_yards2": covariance_local,
    }


def evaluate_candidate(geometry_payload: dict[str, Any], slices: list[dict[str, Any]],
                       player_profile: dict[str, Any], candidate: dict[str, Any],
                       sample_count: int = DEFAULT_SAMPLE_COUNT) -> dict[str, Any]:
    angle = float(candidate["aim_angle_rad"])
    distribution = player_distribution_for_aim(player_profile, angle)
    mean = distribution["expected_landing_mean_local_yards"]
    hazard = risk.evaluate_target(
        geometry_payload,
        center_lateral_yds=float(mean["lateral"]),
        center_forward_yds=float(mean["forward"]),
        shot_profile={"covariance": distribution["covariance_hole_local_yards2"]},
        sample_count=int(sample_count),
    )
    return {
        **candidate,
        "aim_angle_deg": math.degrees(angle),
        "distribution": distribution,
        "course_surface_evidence": {
            "intended_aim_ray": surface_support(slices, angle),
            "expected_mean_ray": surface_support(slices, float(distribution["expected_mean_angle_rad"])),
        },
        "hazard_evidence": hazard,
        "decision_score": None,
        "recommendation": None,
        "strategy_authority": False,
    }


def build_strategy_field(geometry_payload: dict[str, Any], arc_payloads: Iterable[dict[str, Any]],
                         player_profile: dict[str, Any], *, gameplay_context: dict[str, Any] | None = None,
                         fractions: Iterable[float] = DEFAULT_AIM_GRID,
                         sample_count: int = DEFAULT_SAMPLE_COUNT) -> dict[str, Any]:
    profile = normalize_player_profile(player_profile)
    slices = sorted((normalize_arc_slice(p) for p in arc_payloads), key=lambda row: row["carry_yds"])
    source_carry, seeds = candidate_angles(slices, profile, fractions)
    candidates = [
        evaluate_candidate(geometry_payload, slices, profile, seed, sample_count=sample_count)
        for seed in seeds
    ]
    context = dict(gameplay_context or {})
    identity = geometry_payload.get("identity") or {}
    return {
        "schema_version": SCHEMA_VERSION,
        "identity": identity,
        "player_profile": profile,
        "course_field": {
            "representation": "radial current-hole surface slices (fairway supplied by Carry Arc v1) + trusted hazard geometry",
            "radial_slices": slices,
            "candidate_source_carry_yds": source_carry,
            "hazard_geometry_source_schema": geometry_payload.get("schema_version"),
        },
        "gameplay_context": {
            "supplied": context,
            "applied_to_distribution": [],
            "unapplied_keys": sorted(context.keys()),
            "note": "Wind, lie, elevation, temperature and other live modifiers stay separate until explicit models are wired; none are silently baked into course extraction.",
        },
        "candidate_evidence": candidates,
        "limitations": [
            "Fairway evidence is discrete radial-slice support, not a reconstructed fairway polygon or fairway probability.",
            "Carry Arc v1 currently supplies fairway intervals only; the field schema preserves surface_class so rough/deep_rough/green slices can be added without changing the player-distribution layer.",
            "Penalty-area and OB boundaries do not yet expose unsafe-side orientation, so boundary probability remains unavailable in strategy_risk_v0.",
            "No decision weights, strokes-gained values, club choice, or aim recommendation are applied in this layer.",
        ],
        "strategy_authority": False,
        "recommendation": None,
    }


def discover_arc_payloads(capture: Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(capture.glob("strategy_carry_arc_[0-9][0-9][0-9][0-9]_v1.json")):
        try:
            rows.append(read_json(path))
        except Exception:
            continue
    return rows


def main() -> int:
    p = argparse.ArgumentParser(description="Compose Looper strategy-field evidence from carry arcs + player distribution")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--player-profile-json", required=True)
    p.add_argument("--gameplay-context-json")
    p.add_argument("--sample-count", type=int, default=DEFAULT_SAMPLE_COUNT)
    p.add_argument("--output", default="strategy_field_v0.json")
    args = p.parse_args()

    capture = Path(args.capture_dir).expanduser().resolve()
    geometry_path = capture / "screenshot_strategy_geometry_v2.json"
    if not geometry_path.is_file():
        raise SystemExit(f"Missing strategy geometry: {geometry_path}")
    geometry = read_json(geometry_path)
    arcs = discover_arc_payloads(capture)
    if not arcs:
        raise SystemExit("No strategy_carry_arc_####_v1.json files found in capture directory")
    profile = read_json(Path(args.player_profile_json).expanduser().resolve())
    context = read_json(Path(args.gameplay_context_json).expanduser().resolve()) if args.gameplay_context_json else {}
    payload = build_strategy_field(geometry, arcs, profile, gameplay_context=context, sample_count=args.sample_count)
    output_path = capture / args.output
    write_json(output_path, payload)
    print(f"Wrote {output_path}")
    print(f"Candidates={len(payload['candidate_evidence'])} | strategy authority OFF | recommendation NONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
