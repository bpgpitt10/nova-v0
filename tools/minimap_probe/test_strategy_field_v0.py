#!/usr/bin/env python3
import math
import sys
import types

try:
    import strategy_risk_v0  # noqa: F401
except ModuleNotFoundError:
    # Local artifact-only fallback. In the repo this test uses the real risk module.
    risk = types.ModuleType("strategy_risk_v0")

    def covariance_from_profile(p):
        if "covariance" in p:
            c = p["covariance"]
            return ((float(c[0][0]), float(c[0][1])), (float(c[1][0]), float(c[1][1])))
        sl = float(p["sigma_lateral_yds"])
        sf = float(p["sigma_forward_yds"])
        rho = float(p.get("correlation", 0))
        return ((sl * sl, rho * sl * sf), (rho * sl * sf, sf * sf))

    def evaluate_target(geometry_payload, **kwargs):
        return {
            "target_center_local_yards": {
                "lateral": kwargs["center_lateral_yds"],
                "forward": kwargs["center_forward_yds"],
            },
            "shot_profile": kwargs["shot_profile"],
            "aggregate": {},
            "strategy_authority": False,
            "recommendation": None,
        }

    risk.covariance_from_profile = covariance_from_profile
    risk.evaluate_target = evaluate_target
    sys.modules["strategy_risk_v0"] = risk

import strategy_field_v0 as sf


def close(a, b, tol=1e-7):
    assert abs(a - b) < tol, (a, b)


def test_rotation():
    # Aim 90deg right: shot-forward becomes hole-right; shot-right becomes hole-backward.
    x, y = sf._shot_to_hole_vector(2, 3, math.pi / 2)
    close(x, 3)
    close(y, -2)
    cov = sf._rotate_covariance(((4, 0), (0, 9)), math.pi / 2)
    close(cov[0][0], 9)
    close(cov[1][1], 4)


def test_bias_separate_from_aim():
    p = {
        "carry_mean_yds": 200,
        "carry_sigma_yds": 10,
        "lateral_sigma_yds": 15,
        "mean_lateral_bias_yds": 10,
    }
    d = sf.player_distribution_for_aim(p, 0)
    close(d["intended_aim_center_local_yards"]["lateral"], 0)
    close(d["intended_aim_center_local_yards"]["forward"], 200)
    close(d["expected_landing_mean_local_yards"]["lateral"], 10)
    close(d["expected_landing_mean_local_yards"]["forward"], 200)


def test_surface_slice_support_and_candidates():
    def arc(carry, left_deg, right_deg):
        def pt(deg):
            a = math.radians(deg)
            return {"lateral": carry * math.sin(a), "forward": carry * math.cos(a)}

        return {
            "schema_version": "x",
            "carry_yds": carry,
            "spans": [{
                "span_id": 1,
                "accepted": True,
                "left_local_yards": pt(left_deg),
                "right_local_yards": pt(right_deg),
            }],
        }

    slices = [sf.normalize_arc_slice(arc(190, -10, 10)), sf.normalize_arc_slice(arc(210, -8, 12))]
    support = sf.surface_support(slices, math.radians(5))
    assert support["slice_support_count"] == 2
    source, candidates = sf.candidate_angles(slices, 200, [.2, .5, .8])
    assert source in {190, 210}
    assert len(candidates) == 3


def test_field_keeps_context_unapplied():
    def pt(r, deg):
        a = math.radians(deg)
        return {"lateral": r * math.sin(a), "forward": r * math.cos(a)}

    arcs = [{
        "carry_yds": 200,
        "spans": [{
            "span_id": 1,
            "accepted": True,
            "left_local_yards": pt(200, -10),
            "right_local_yards": pt(200, 10),
        }],
    }]
    profile = {
        "club": "Driver",
        "carry_mean_yds": 200,
        "carry_sigma_yds": 10,
        "lateral_sigma_yds": 15,
        "mean_lateral_bias_yds": 5,
    }
    out = sf.build_strategy_field(
        {"identity": {"hole_display": 1}, "schema_version": "geom"},
        arcs,
        profile,
        gameplay_context={"wind_mph": 12},
    )
    assert len(out["candidate_evidence"]) == 3
    assert out["gameplay_context"]["applied_to_distribution"] == []
    assert out["gameplay_context"]["unapplied_keys"] == ["wind_mph"]
    assert out["recommendation"] is None


def test_probe_carries_follow_player_longitudinal_sigma():
    profile = {"carry_mean_yds": 240, "carry_sigma_yds": 8, "lateral_sigma_yds": 15}
    assert sf.recommended_probe_carries(profile) == [224, 232, 240, 248, 256]


if __name__ == "__main__":
    tests = [
        test_rotation,
        test_bias_separate_from_aim,
        test_surface_slice_support_and_candidates,
        test_field_keeps_context_unapplied,
        test_probe_carries_follow_player_longitudinal_sigma,
    ]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
