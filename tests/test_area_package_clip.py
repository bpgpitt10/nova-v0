"""Whole-area packages clip and simplify their rings to the area box.

DPC Sodgrass (TPC Sawgrass, 11/6): one OSM lagoon of 11,777 points went into
the area package whole and the validator refused it (surface rings max 2000).

Run: python3 -m pytest -q tests/test_area_package_clip.py
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'course_model'))
import build_area_package as b  # noqa: E402

BOX = (-500.0, -500.0, 500.0, 500.0)


def test_a_waterway_running_past_the_course_is_clipped_to_the_box():
    n = 12000
    ring = ([[-2000 + 4000 * i / (n / 2), 0.0] for i in range(n // 2)]
            + [[2000 - 4000 * i / (n / 2), 300 + 5 * math.sin(i)] for i in range(n // 2)])
    out = b.fit_ring(ring, BOX, b.SURFACE_RING_MAX_POINTS)
    assert out is not None and len(out) <= b.SURFACE_RING_MAX_POINTS
    assert min(p[0] for p in out) >= BOX[0] and max(p[0] for p in out) <= BOX[2]


def test_a_dense_ring_inside_the_box_is_simplified_not_dropped():
    m = 5000
    circle = [[200 * math.cos(2 * math.pi * i / m), 200 * math.sin(2 * math.pi * i / m)] for i in range(m)]
    out = b.fit_ring(circle, BOX, b.SURFACE_RING_MAX_POINTS)
    assert out is not None and 20 <= len(out) <= b.SURFACE_RING_MAX_POINTS
    # still roughly the same shape: area within 2% of pi r^2
    assert abs(abs(b.ring_area(out)) - math.pi * 200 ** 2) < 0.02 * math.pi * 200 ** 2


def test_a_ring_wholly_outside_the_box_is_dropped():
    assert b.fit_ring([[900, 900], [950, 900], [950, 950], [900, 950]], BOX, b.SURFACE_RING_MAX_POINTS) is None


def test_a_small_ring_inside_the_box_is_untouched():
    ring = [[0, 0], [30, 0], [30, 30], [0, 30]]
    assert b.fit_ring(ring, BOX, b.SURFACE_RING_MAX_POINTS) == [[0.0, 0.0], [30.0, 0.0], [30.0, 30.0], [0.0, 30.0]]
