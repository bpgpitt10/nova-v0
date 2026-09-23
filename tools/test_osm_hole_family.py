#!/usr/bin/env python3
"""Regression coverage for duplicate numbered golf-hole family resolution."""

from __future__ import annotations

from fetch_osm_course_snapshot_family import (
    filter_to_selected_holes,
    resolve_hole_family,
)


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


def main() -> int:
    source_id = 9000
    elements = [
        course(source_id, 33.49, -82.04, 33.53, -81.99),
        course(9100, 33.503, -82.024, 33.512, -82.014),
    ]

    # Championship family: all 18 holes form one continuous chain.
    for hole in range(1, 19):
        elements.append(way(1000 + hole, hole, 33.500 + hole * 0.00055, -82.032, par=4))

    # Decoy short-course family: duplicate refs 1-9 sit inside their own nested
    # golf=course polygon. Internal transitions are deliberately tight so a
    # naive per-ref or shortest-local-gap resolver would prefer them.
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

    filtered = filter_to_selected_holes(payload, selected)
    selected_holes = [
        element
        for element in filtered["elements"]
        if (element.get("tags") or {}).get("golf") == "hole"
    ]
    assert len(selected_holes) == 18
    assert not any(element["id"] >= 2000 for element in selected_holes)

    print(
        "Duplicate OSM hole family resolution: nested short-course refs rejected; "
        "one coherent 18-hole family preserved: ok"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
