#!/usr/bin/env python3
from __future__ import annotations

import base64
import math
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

import geometry_review_strategy_fixture_v0 as fixture


class GeometryReviewStrategyFixtureV0Tests(unittest.TestCase):
    def test_parse_tee_distances_binds_capture(self):
        text = """
Base HoleModel:        READY
Pin target:            350.0 yd | screen-consensus
Capture folder:        C:\\x\\tee_capture_20260912_070926_287617
Base HoleModel:        READY
Pin target:            524.0 yd | screen-consensus
Capture folder:        C:\\x\\tee_capture_20260912_072225_878204
"""
        got = fixture.parse_tee_distances(text)
        self.assertEqual(got["tee_capture_20260912_070926_287617"], 350.0)
        self.assertEqual(got["tee_capture_20260912_072225_878204"], 524.0)

    def test_coordinate_transform_uses_preserved_anchors(self):
        review = {"anchors": {"tee_pixel": [10, 110], "pin_pixel": [10, 10]}}
        got = fixture.coordinate_transform(review, 400)
        self.assertAlmostEqual(got["tee_to_pin_pixels"], 100.0)
        self.assertAlmostEqual(got["yards_per_pixel"], 4.0)

    def test_extract_embedded_actual_uses_first_png(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            first = np.zeros((8, 9, 3), dtype=np.uint8)
            first[:, :, 1] = 80
            second = np.zeros((8, 9, 3), dtype=np.uint8)
            second[:, :, 2] = 200
            ok1, buf1 = cv2.imencode(".png", first)
            ok2, buf2 = cv2.imencode(".png", second)
            self.assertTrue(ok1 and ok2)
            html = (
                '<img src="data:image/png;base64,' + base64.b64encode(buf1.tobytes()).decode("ascii") + '">'
                '<img src="data:image/png;base64,' + base64.b64encode(buf2.tobytes()).decode("ascii") + '">'
            )
            path = root / "review.html"
            path.write_text(html, encoding="utf-8")
            got = fixture.extract_embedded_actual(path)
            self.assertEqual(got.shape, first.shape)
            self.assertTrue(np.array_equal(got, first))

    def test_fairway_payload_clamps_confidence(self):
        review = {
            "identity": {"capture_id": "c1", "hole_display": 1},
            "layers": [{
                "id": "fairway",
                "class": "fairway",
                "direct_points": [[1,1],[8,1],[8,8],[1,8]],
                "confidence": {"semantic": 1.4, "geometry": 1.2},
                "source": {"kind": "fairway_surface_shadow", "object_id": "f1"},
            }],
        }
        got = fixture.fairway_payload_from_review(review, 10, 10)
        self.assertIsNotNone(got)
        self.assertEqual(got["fairway"]["semantic_confidence"], 1.0)
        self.assertFalse(got["strategy_authority"])

    def test_review_direct_geometry_keeps_penalty_not_fairway(self):
        review = {"layers": [
            {"class":"penalty_area","direct_points":[[1,1],[2,2]],"source":{"kind":"red_penalty_cv"}},
            {"class":"fairway","direct_points":[[1,1],[2,1],[2,2]],"source":{"kind":"fairway"}},
        ]}
        got = fixture.review_direct_geometry(review, 10, 10)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["hazard_class"], "penalty_area")


if __name__ == "__main__":
    unittest.main(verbosity=2)
