"""Enrichment keeps islands and clearings (multipolygon inner rings, canopy holes)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'course_model'))
from build_enriched_package import assemble_rings, keyhole, point_in_ring, ring_area  # noqa: E402


def square(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def test_island_is_outside_the_pond():
    pond = square(0, 0, 100, 100)
    island = square(40, 40, 60, 60)
    ring = keyhole(pond, [island])
    assert point_in_ring((10, 10), ring)            # water
    assert not point_in_ring((50, 50), ring)        # island green
    assert abs(ring_area(ring) - (100 * 100 - 20 * 20)) < 1e-6


def test_many_holes_and_orientation():
    outer = square(0, 0, 200, 100)[::-1]             # clockwise outline is fine
    holes = [square(10 + 40 * k, 30, 30 + 40 * k, 60) for k in range(4)]
    ring = keyhole(outer, holes)
    for k in range(4):
        assert not point_in_ring((20 + 40 * k, 45), ring)
    assert point_in_ring((5, 5), ring) and point_in_ring((190, 90), ring)


def test_relation_members_join_into_rings():
    a = [(0, 0), (0, 10), (10, 10)]
    b = [(0, 0), (10, 0), (10, 10)]                  # reversed partner
    rings = assemble_rings([a, b])
    assert len(rings) == 1 and rings[0][0] == rings[0][-1] and len(rings[0]) == 5
