#!/usr/bin/env python3
"""Offline H13 regression for the hole-in-polygon serialization defect."""
import sys
from pathlib import Path

from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from enrich_worldcover_context import serialize_geometry
from validate_course_landcover_masks import audit_package


def test_hole_is_not_refilled():
    tee = Polygon([(44, 44), (56, 44), (56, 56), (44, 56)])
    trees = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)]).difference(tee)
    contexts = serialize_geometry(trees, min_area=1, simplify=1.25, smooth=1.5, protected=tee)
    assert contexts, "Expected woods around mapped tee"
    payload = {"holes": {"13": {"surfaces": {"tee": [[[44,44],[56,44],[56,56],[44,56],[44,44]]]},
                                "context": {"landcover-woods": contexts}}}}
    result = audit_package(payload)
    assert result["passed"], result["failures"]
    bad_payload = {"holes": {"13": {"surfaces": payload["holes"]["13"]["surfaces"],
                                     "context": {"landcover-woods": [[[0,0],[100,0],[100,100],[0,100],[0,0]]]}}}}
    bad = audit_package(bad_payload)
    assert not bad["passed"], "Regression gate failed to reject overlapping woods"
    print("PASS H13: woods donut stays cut out; deliberately overlapping woods rejected")


if __name__ == "__main__":
    test_hole_is_not_refilled()
