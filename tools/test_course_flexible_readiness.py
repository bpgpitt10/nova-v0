#!/usr/bin/env python3
"""No-network tests: mapped hole != verified named tee; ball pixel != OSM XY."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_course_flexible_readiness import audit


def package():
    holes = {}
    for n in range(1, 19):
        holes[str(n)] = {
            "coordinateFrame": {
                "origin": "osm-hole-route-start",
                "anchorLatLon": [35, -81],
                "targetGreenLatLon": [35.001, -81.002],
                "headingDegreesTrue": 80,
            },
            "terrain": {"source": "lidar-dem", "valuesBase64": "AQ=="},
            "surfaces": {"green": [[[0, 0], [1, 0], [1, 1]]], "fairway": [],
                         "tee": [], "bunker": [], "water": []},
            "teeCandidates": [],
        }
    return {
        "schemaVersion": "looper-static-course-package-v1",
        "courseId": "test-course", "courseName": "Test Course", "holes": holes,
    }


def run():
    pkg = package()
    map_receipt = {"courseId": "test-course", "mapReady": True, "runtimeReady": False}
    result = audit(pkg, map_receipt=map_receipt)
    assert result["mode"] == "map_review_only_companion_calibration_candidate"
    assert result["summary"]["mappedHoles"] == 18
    assert result["summary"]["holesWithOwnedMappedTeeCandidates"] == 0
    assert result["summary"]["namedTeeSetsApproved"] == 0
    assert result["publicReady"] is False and result["autoPublish"] is False
    assert all(h["recommendationHazardCompleteness"] == "unknown_not_established_by_osm"
               for h in result["holes"])
    assert all(h["companionCalibration"] == "awaiting_current_sim_observation" for h in result["holes"])

    pkg["holes"]["1"]["teeCandidates"] = [{
        "coursePoint": [0, 0], "osmId": 23,
        "polygons": [[[0, 0], [1, 0], [1, 1]]],
        "teeSet": "Tee 1", "teeAliases": ["Tee 1"],
    }]
    pkg["holes"]["1"]["surfaces"]["tee"] = [[[0, 0], [1, 0], [1, 1]]]
    result = audit(pkg, map_receipt=map_receipt)
    assert result["summary"]["holesWithOwnedMappedTeeCandidates"] == 1
    assert result["summary"]["namedTeeSetsApproved"] == 0, "Inferred Tee 1 must not become verified"

    # Seeing a fresh native pixel ball and pin does not register OSM XY.
    observation = {
        "1": {"currentHoleMatches": True, "currentBallFresh": True,
              "ballPixel": [125, 430], "pinPixel": [128, 38],
              "sameRoundSameHole": True}
    }
    result = audit(pkg, map_receipt=map_receipt, live_evidence=observation)
    assert result["holes"][0]["companionCalibration"] == "native_ball_detected_unregistered"
    assert result["mode"] == "map_review_only_companion_calibration_candidate"
    assert result["publicReady"] is False

    # Even if a future independently proven cross-frame transform is supplied
    # with 2 landmarks and low ball residual, this AUDIT does not publish.
    observation["1"].update({
        "courseFrameRegistrationVerified": True, "independentAnchors": 2,
        "ballResidualYds": 1.3
    })
    result = audit(pkg, map_receipt=map_receipt, live_evidence=observation)
    assert result["holes"][0]["companionCalibration"] == "registered_candidate_research_only"
    assert result["publicReady"] is False and result["allowNativeAim"] is False
    observation["1"]["ballResidualYds"] = 9
    assert audit(pkg, map_receipt=map_receipt,
                 live_evidence=observation)["holes"][0]["companionCalibration"] == "native_ball_detected_unregistered"

    # Incomplete geometry may be displayed in an audit, not silently approved.
    pkg["holes"]["17"]["terrain"]["valuesBase64"] = ""
    result = audit(pkg, map_receipt=map_receipt)
    assert result["summary"]["mappedHoles"] == 17
    assert result["mode"] == "incomplete_source_or_receipt"
    assert result["publicReady"] is False

    # Existing runtime completion is identified separately from official
    # named tee accuracy and does not create a new route into the registry.
    pkg["holes"]["17"]["terrain"]["valuesBase64"] = "AQ=="
    result = audit(pkg, runtime_receipt={"courseId": "test-course", "runtimeReady": True})
    assert result["mode"] == "existing_runtime_ready_not_scorecard_audited"
    assert result["summary"]["namedTeeSetsApproved"] == 0

    # A mismatched receipt, 17-hole package, or malformed identity fails closed.
    assert audit(pkg, map_receipt={"courseId": "other", "mapReady": True})["mode"] == "incomplete_source_or_receipt"
    pkg["holes"].pop("18")
    assert audit(pkg, map_receipt=map_receipt)["mode"] == "unusable"
    print("PASS flexible readiness: per-hole map inventory, missing tees, native ball registration gates, no promotion")


if __name__ == "__main__":
    run()
