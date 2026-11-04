"""Holes mapped twice in OpenStreetMap (Payne's Valley) keep one copy."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import fetch_osm_course_snapshot as fetcher  # noqa: E402


def hole(way_id: int, ref: int, start, end, tags: dict | None = None):
    return {"type": "way", "id": way_id, "tags": {"golf": "hole", "ref": str(ref), **(tags or {})},
            "geometry": [{"lat": start[0], "lon": start[1]}, {"lat": end[0], "lon": end[1]}]}


def course(extra):
    base = [hole(100 + n, n, (36.0 + n * 0.01, -93.0), (36.0 + n * 0.01, -92.996)) for n in range(1, 19)]
    return {"elements": base + extra}


def test_same_direction_copy_dropped():
    payload = course([hole(900, 5, (36.05, -93.0001), (36.05, -92.9961), {"par": "4", "name": "x"})])
    holes = fetcher.validate_holes(payload)
    assert holes[5] == ("way", 900)  # more tags wins


def test_reversed_copy_dropped():
    payload = course([hole(901, 7, (36.07, -92.996), (36.07, -93.0))])
    holes = fetcher.validate_holes(payload)
    assert holes[7] in {("way", 107), ("way", 901)}
    assert sum(1 for e in payload["elements"] if (e.get("tags") or {}).get("ref") == "7") == 1


def area(way_id: int, golf: str, centre):
    lat, lon = centre
    ring = [(lat - 0.0001, lon - 0.0001), (lat - 0.0001, lon + 0.0001), (lat + 0.0001, lon + 0.0001),
            (lat + 0.0001, lon - 0.0001), (lat - 0.0001, lon - 0.0001)]
    return {"type": "way", "id": way_id, "tags": {"golf": golf},
            "geometry": [{"lat": a, "lon": b} for a, b in ring]}


def test_copy_elsewhere_keeps_the_one_on_tee_and_green():
    # Hole 9's real tee and green; the second copy is drawn 1 km away.
    extra = [hole(902, 9, (36.2, -93.0), (36.2, -92.996)),
             area(5001, "tee", (36.09, -93.0)), area(5002, "green", (36.09, -92.996))]
    payload = course(extra)
    holes = fetcher.validate_holes(payload)
    assert holes[9] == ("way", 109)


def test_copy_elsewhere_rejected():
    payload = course([hole(902, 9, (36.2, -93.0), (36.2, -92.996))])
    with pytest.raises(ValueError):
        fetcher.validate_holes(payload)
