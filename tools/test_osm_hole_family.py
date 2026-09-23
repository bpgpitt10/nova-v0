#!/usr/bin/env python3
"""Regression coverage for duplicate numbered golf-hole family resolution."""

from __future__ import annotations

from fetch_osm_course_snapshot_family import (
    filter_to_selected_holes,
    resolve_hole_family,
)

AUGUSTA_CHAMPIONSHIP_PARS = {
    1: 4,
    2: 5,
    3: 4,
    4: 3,
    5: 4,
    6: 3,
    7: 4,
    8: 5,
    9: 4,
    10: 4,
    11: 4,
    12: 3,
    13: 5,
    14: 4,
    15: 5,
    16: 3,
    17: 4,
    18: 4,
}


def way(osm_id: int, ref: int, lat: float, lon: float, *, par: int = 4):
    return {
        "type": "way",
        "id": osm_id,
        "tags": {"golf": "hole", "ref": str(ref), "par": str(par)},
        "geometry": [
            {"lat": lat, "lon": lon},
            {"lat": lat + 0.00035, "lon": lon},
        ],
    }


def course(osm_id: int, min_lat: float, min_lon: float, max_lat: float, max_lon: float):
    return {
        "type": "way",
        "id": osm_id,
        "tags": {"golf": "course", "name": "Nested short course"},
        "geometry": [
            {"lat": min_lat, "lon": min_lon},
            {"lat": min_lat, "lon": max_lon},
            {"lat": max_lat, "lon": max_lon},
            {"lat": max_lat, "lon": min_lon},
            {"lat": min_lat, "lon": min_lon},
        ],
    }


def assert_filtered_18(payload, selected) -> None:
    filtered = filter_to_selected_holes(payload, selected)
    selected_holes = [
        element
        for element in filtered["elements"]
        if (element.get("tags") or {}).get("golf") == "hole"
    ]
    assert len(selected_holes) == 18


def test_nested_course_exclusion() -> None:
    source_id = 9000
    elements = [
        course(source_id, 33.49, -82.04, 33.53, -81.99),
        course(9100, 33.503, -82.024, 33.512, -82.014),
    ]

    for hole in range(1, 19):
        elements.append(way(1000 + hole, hole, 33.500 + hole * 0.00055, -82.032, par=4))

    # Decoy refs 1-9 live inside a separately mapped nested golf=course.
    for hole in range(1, 10):
        elements.append(way(2000 + hole, hole, 33.504 + hole * 0.00045, -82.019, par=3))

    payload = {
        "version": 0.6,
        "generator": "synthetic",
        "osm3s": {},
        "elements": elements,
    }

    selected, diagnostic = resolve_hole_family(
        payload,
        source_identity=("way", source_id),
        min_margin_yards=1.0,
        max_handoff_yards=700.0,
    )

    assert diagnostic["duplicateRefs"] == list(range(1, 10))
    assert diagnostic["foreignCoursePolygonCount"] == 1
    for hole in range(1, 19):
        assert selected[hole]["id"] == 1000 + hole, (hole, selected[hole]["id"])
    assert_filtered_18(payload, selected)


def test_scorecard_identity_without_nested_polygon() -> None:
    source_id = 9000
    elements = []

    # Correct 18-hole family uses the configured championship par fingerprint.
    # Put it slightly farther apart so pure spatial continuity is tempted by the
    # compact decoy family, matching the live Augusta failure we observed.
    for hole in range(1, 19):
        elements.append(
            way(
                3000 + hole,
                hole,
                33.490 + hole * 0.00070,
                -82.032,
                par=AUGUSTA_CHAMPIONSHIP_PARS[hole],
            )
        )

    # No nested golf=course polygon exists here. Refs 1-9 are a compact all-par-3
    # short-course family, just like the OSM ambiguity that fooled Augusta.
    for hole in range(1, 10):
        elements.append(way(4000 + hole, hole, 33.500 + hole * 0.00042, -82.018, par=3))

    payload = {
        "version": 0.6,
        "generator": "synthetic",
        "osm3s": {},
        "elements": elements,
    }

    selected, diagnostic = resolve_hole_family(
        payload,
        source_identity=("way", source_id),
        expected_par_by_hole=AUGUSTA_CHAMPIONSHIP_PARS,
        min_margin_yards=1.0,
        max_handoff_yards=700.0,
    )

    assert diagnostic["foreignCoursePolygonCount"] == 0
    assert diagnostic["selectedParMismatchRefs"] == []
    assert diagnostic["expectedParByHole"]["1"] == 4
    assert diagnostic["expectedParByHole"]["2"] == 5
    for hole in range(1, 19):
        assert selected[hole]["id"] == 3000 + hole, (hole, selected[hole]["id"])
        assert diagnostic["selected"][str(hole)]["parMismatch"] is False
    assert_filtered_18(payload, selected)


def main() -> int:
    test_nested_course_exclusion()
    test_scorecard_identity_without_nested_polygon()
    print(
        "Duplicate OSM hole family resolution: nested-course exclusion and explicit "
        "par fingerprint both preserve one coherent 18-hole family: ok"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
