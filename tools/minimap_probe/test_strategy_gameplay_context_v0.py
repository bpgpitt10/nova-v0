#!/usr/bin/env python3
import strategy_gameplay_context_v0 as gc


def test_preserves_scoped_elevation_and_sign():
    shot = {
        "schema_version": "post-tee-shot-state-v1",
        "capture_mode": "post-tee",
        "pin": {
            "distance_yds": 151,
            "elevation_raw": "5y",
            "elevation_direction": "up",
            "elevation_delta_ft": 15.0,
            "elevation_delta_yds": 5.0,
            "source": "gspro-screen-pin-card",
        },
        "aim": {
            "distance_yds": 143,
            "elevation_raw": "9'0\"",
            "elevation_direction": "down",
            "elevation_delta_ft": -9.0,
            "elevation_delta_yds": -3.0,
            "source": "gspro-screen-aim-card",
        },
        "lie_slope": {"signed_up_down_deg": 1.2, "signed_left_right_deg": -0.7},
        "wind": None,
    }
    out = gc.build_gameplay_context(shot, source_path="shot_state.json")
    pin = out["target_measurements"]["pin"]
    aim = out["target_measurements"]["gspro_aim"]
    assert pin["elevation"]["delta_ft"] == 15.0
    assert pin["elevation"]["delta_yds"] == 5.0
    assert pin["elevation"]["sign_direction_consistency_ok"] is True
    assert aim["elevation"]["delta_ft"] == -9.0
    assert aim["elevation"]["delta_yds"] == -3.0
    assert aim["elevation"]["sign_direction_consistency_ok"] is True
    assert out["application"]["elevation_adjustment_model_applied"] is False


def test_does_not_invent_confidence():
    out = gc.build_gameplay_context({
        "pin": {
            "distance_yds": 200,
            "elevation_direction": "up",
            "elevation_delta_ft": 3.0,
            "elevation_delta_yds": 1.0,
            "elevation_raw": "1y",
        }
    })
    ocr = out["target_measurements"]["pin"]["ocr"]
    assert ocr["confidence"] is None
    assert ocr["confidence_status"] == "not-calibrated-by-current-target-card-reader"


def test_flags_inconsistent_units_without_rewriting():
    out = gc.build_gameplay_context({
        "pin": {
            "distance_yds": 200,
            "elevation_direction": "up",
            "elevation_delta_ft": 12.0,
            "elevation_delta_yds": 3.0,
        }
    })
    elev = out["target_measurements"]["pin"]["elevation"]
    assert elev["delta_ft"] == 12.0
    assert elev["delta_yds"] == 3.0
    assert elev["unit_consistency_ok"] is False


def test_supplemental_context_stays_separate():
    out = gc.build_gameplay_context(
        {"capture_mode": "tee", "pin": None, "aim": None},
        supplemental={"temperature_f": 72, "wind_mph": 11},
    )
    assert out["supplemental"] == {"temperature_f": 72, "wind_mph": 11}
    assert out["wind"] is None
    assert out["elevation_contract"]["scope"] == gc.ELEVATION_SCOPE


def test_v1_elevation_policy_is_locked_and_not_a_blocker():
    out = gc.build_gameplay_context({"capture_mode": "tee", "pin": None, "aim": None})
    policy = out["elevation_contract"]
    assert policy["policy_version"] == "looper-elevation-policy-v1"
    assert policy["tee"]["preferred_source"] == "gspro_aim"
    assert policy["approach_to_green"]["preferred_source"] == "pin"
    assert policy["other_post_tee"]["preferred_source"] == "gspro_aim"
    assert policy["candidate_specific_terrain_elevation_required"] is False
    assert policy["candidate_specific_terrain_elevation_deferred"] is True
    assert policy["strategy_blocker"] is False
    assert out["application"]["shot_level_elevation_policy_locked"] is True


if __name__ == "__main__":
    tests = [
        test_preserves_scoped_elevation_and_sign,
        test_does_not_invent_confidence,
        test_flags_inconsistent_units_without_rewriting,
        test_supplemental_context_stays_separate,
        test_v1_elevation_policy_is_locked_and_not_a_blocker,
    ]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
