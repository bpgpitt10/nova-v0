#!/usr/bin/env python3
"""Offline, evidence-only quality matrix for partially mapped GSPro courses.

Does NOT modify import acceptance, course registry, Round Setup, or allow clicks.
A native ball pixel is not a latitude/longitude or trusted course-local point.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def record(x):
    return x if isinstance(x, dict) else {}


def valid_local(x):
    return isinstance(x, (list, tuple)) and len(x) >= 2 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        for v in x[:2]
    )


def count_surfaces(hole, kind):
    features = record(hole.get("surfaces")).get(kind)
    return len(features) if isinstance(features, list) else 0


def _candidate(x):
    return record(x)


def audit(package, *, map_receipt=None, runtime_receipt=None, live_evidence=None):
    """Generate explanation-only tiers; no live approval is ever written.

    Even a CURRENT native ball coordinate is insufficient to register Looper
    course XY. A separately validated 2D transform must match independent
    landmarks, fresh round/hole and the ball with residual checks.
    """
    pkg = record(package)
    holes = record(pkg.get("holes"))
    result = {
        "schemaVersion": "looper-flexible-readiness-research-v1",
        "courseId": pkg.get("courseId"),
        "courseName": pkg.get("courseName"),
        "stateAuthority": "offline-inventory-only",
        "autoPublish": False,
        "allowNativeAim": False,
        "publicReady": False,
        "releaseChange": "none",
        "mode": "unusable",
        "holes": [],
        "summary": {},
    }
    if not isinstance(pkg.get("courseId"), str) or set(holes) != {str(n) for n in range(1, 19)}:
        result["reason"] = "No valid 18-hole course identity/package; cannot claim playable coverage."
        return result
    valid_map_receipt = (
        record(map_receipt).get("mapReady") is True
        and record(map_receipt).get("courseId") == pkg["courseId"]
        and record(map_receipt).get("runtimeReady") is False
    )
    valid_runtime_receipt = (
        record(runtime_receipt).get("runtimeReady") is True
        and record(runtime_receipt).get("courseId") == pkg["courseId"]
    )
    for number in range(1, 19):
        hole = record(holes[str(number)])
        frame = record(hole.get("coordinateFrame"))
        terrain = record(hole.get("terrain"))
        candidates = [_candidate(c) for c in hole.get("teeCandidates", [])
                      if isinstance(c, dict)] if isinstance(hole.get("teeCandidates"), list) else []
        mapped = [
            c for c in candidates
            if c.get("osmId") is not None and valid_local(c.get("coursePoint"))
            and isinstance(c.get("polygons"), list) and len(c["polygons"]) > 0
        ]
        greens = count_surfaces(hole, "green")
        fairways = count_surfaces(hole, "fairway")
        bunkers = count_surfaces(hole, "bunker")
        water = count_surfaces(hole, "water")
        has_reference = (
            frame.get("origin") in ("selected-tee", "osm-hole-route-start")
            and frame.get("anchorLatLon") is not None
            and frame.get("targetGreenLatLon") is not None
            and isinstance(frame.get("headingDegreesTrue"), (int, float))
        )
        map_evidence = bool(has_reference and greens and terrain.get("valuesBase64")
                            and terrain.get("source") == "lidar-dem")
        concerns = []
        if not has_reference: concerns.append("no_georeferenced_hole_axis")
        if not greens: concerns.append("no_green_polygon")
        if not terrain.get("valuesBase64"): concerns.append("no_runtime_terrain")
        # A par-3 can legitimately have no fairway polygon at all.
        if not fairways and hole.get("par") in (4, 5):
            concerns.append("missing_mapped_fairway_on_par4_or_par5")
        if not mapped: concerns.append("no_owned_mapped_tee_polygon")
        # This only means one *physical* pad is present, NOT a real scorecard
        # tee name. Inferred generic "Tee 1" is NOT verified.
        named_tee_verified = False
        observation = record(record(live_evidence).get(str(number)))
        has_native_ball = (
            observation.get("currentHoleMatches") is True
            and observation.get("currentBallFresh") is True
            and valid_local(observation.get("ballPixel"))
            and valid_local(observation.get("pinPixel"))
        )
        independently_registered = (
            has_native_ball and observation.get("courseFrameRegistrationVerified") is True
            and observation.get("independentAnchors") is not None
            and isinstance(observation.get("independentAnchors"), int)
            and observation["independentAnchors"] >= 2
            and isinstance(observation.get("ballResidualYds"), (int, float))
            and 0 <= observation["ballResidualYds"] <= 3
            and observation.get("sameRoundSameHole") is True
        )
        # Deliberately research-only: even independently aligned observations
        # cannot promote runtime or infer named tees from this audit.
        companion_state = ("registered_candidate_research_only" if independently_registered
                           else "native_ball_detected_unregistered" if has_native_ball
                           else "awaiting_current_sim_observation")
        if not independently_registered: concerns.append("gspro_to_osm_alignment_not_verified")
        result["holes"].append({
            "hole": number,
            "mapEvidence": "present" if map_evidence else "incomplete",
            "physicalTeePolygons": count_surfaces(hole, "tee"),
            "ownedMappedTeeCandidates": len(mapped),
            "namedTeeVerified": named_tee_verified,
            "fairwayPolygons": fairways,
            "greenPolygons": greens,
            "bunkerPolygons": bunkers,
            "waterPolygons": water,
            "companionCalibration": companion_state,
            "recommendationHazardCompleteness": "unknown_not_established_by_osm",
            "concerns": concerns,
        })
    entries = result["holes"]
    count = lambda predicate: sum(bool(predicate(h)) for h in entries)
    result["summary"] = {
        "mappedHoles": count(lambda h: h["mapEvidence"] == "present"),
        "holesWithOwnedMappedTeeCandidates": count(lambda h: h["ownedMappedTeeCandidates"] > 0),
        "holesWithMappedFairways": count(lambda h: h["fairwayPolygons"] > 0),
        "holesWithMappedGreens": count(lambda h: h["greenPolygons"] > 0),
        "namedTeeSetsApproved": 0,
        "companionAlignedResearchHoles": count(lambda h: h["companionCalibration"] == "registered_candidate_research_only"),
    }
    if valid_runtime_receipt and result["summary"]["mappedHoles"] == 18:
        result["mode"] = "existing_runtime_ready_not_scorecard_audited"
        result["reason"] = "Existing strict runtime receipt, not new named-tee accuracy certification."
    elif valid_map_receipt and result["summary"]["mappedHoles"] == 18:
        result["mode"] = "map_review_only_companion_calibration_candidate"
        result["reason"] = "18 map/terrain holes; missing verified tee sets. Companion/GSPro registration is a separate live acceptance gate."
    else:
        result["mode"] = "incomplete_source_or_receipt"
        result["reason"] = "No matching current map-ready/runtime-ready receipt for a complete geometry and terrain package."
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--package", type=Path, required=True)
    p.add_argument("--map-receipt", type=Path)
    p.add_argument("--runtime-receipt", type=Path)
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    def maybe_read(path):
        return json.loads(path.read_text()) if path and path.exists() else None
    result = audit(maybe_read(args.package), map_receipt=maybe_read(args.map_receipt),
                   runtime_receipt=maybe_read(args.runtime_receipt))
    serialized = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(serialized, end="")


if __name__ == "__main__":
    main()
