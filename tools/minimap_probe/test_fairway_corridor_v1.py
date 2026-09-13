#!/usr/bin/env python3
from __future__ import annotations

import unittest
import numpy as np

import fairway_corridor_v1 as corridor


def transform():
    return {
        "tee_pixel": {"x": 100.0, "y": 500.0},
        "pin_pixel": {"x": 100.0, "y": 100.0},
        "yards_per_pixel": 0.5,
    }


class CorridorTests(unittest.TestCase):
    def test_station_segment_is_cross_track(self):
        left, right = corridor.station_pixel_segment(transform(), 100.0, lateral_extent_yds=50.0)
        self.assertAlmostEqual(left[1], right[1], places=6)
        self.assertLess(left[0], right[0])
        self.assertAlmostEqual(left[1], 300.0, places=6)

    def test_semantic_normalization_requires_unique_station_ids(self):
        raw = {"stations": [
            {"station_id": 1, "present": False, "left_xy_1000": [0, 0], "center_xy_1000": [0, 0], "right_xy_1000": [0, 0], "confidence": 0.5, "note": ""},
            {"station_id": 2, "present": False, "left_xy_1000": [0, 0], "center_xy_1000": [0, 0], "right_xy_1000": [0, 0], "confidence": 0.5, "note": ""},
        ]}
        rows = corridor.normalize_semantic(raw, 2)
        self.assertEqual([row["station_id"] for row in rows], [1, 2])
        raw["stations"][1]["station_id"] = 1
        with self.assertRaises(ValueError):
            corridor.normalize_semantic(raw, 2)

    def test_validate_rejects_absurd_width(self):
        row = {
            "station_id": 1,
            "present": True,
            "confidence": 0.9,
            "note": None,
            "left_xy_1000": [0, 600],
            "center_xy_1000": [500, 600],
            "right_xy_1000": [1000, 600],
        }
        result = corridor.validate_station(
            row,
            expected_forward_yds=100.0,
            transform=transform(),
            image_width=200,
            image_height=500,
            image=None,
        )
        self.assertFalse(result["accepted"])
        self.assertIn("corridor-too-wide", result["rejection_reasons"])

    def test_validate_accepts_sane_current_hole_span(self):
        def nxy(x, y):
            return [round(x / 200 * 1000), round(y / 500 * 1000)]

        row = {
            "station_id": 1,
            "present": True,
            "confidence": 0.94,
            "note": None,
            "left_xy_1000": nxy(70, 300),
            "center_xy_1000": nxy(100, 300),
            "right_xy_1000": nxy(130, 300),
        }
        result = corridor.validate_station(
            row,
            expected_forward_yds=100.0,
            transform=transform(),
            image_width=200,
            image_height=500,
            image=None,
        )
        self.assertTrue(result["accepted"])
        self.assertAlmostEqual(result["width_yds"], 30.0, places=5)
        self.assertAlmostEqual(result["center_lateral_yds"], 0.0, places=5)

    def test_continuity_marks_big_centerline_jump(self):
        rows = [
            {"accepted": True, "forward_yds": 180.0, "center_lateral_yds": 0.0, "warnings": []},
            {"accepted": True, "forward_yds": 200.0, "center_lateral_yds": 50.0, "warnings": []},
        ]
        corridor.apply_continuity_qa(rows)
        self.assertTrue(any("centerline-jump" in warning for warning in rows[1]["warnings"]))

    def test_edge_snap_finds_synthetic_turf_boundary(self):
        image = np.zeros((500, 200, 3), dtype=np.uint8)
        image[:] = (35, 70, 35)
        image[:, 70:131] = (60, 115, 60)
        snapped, meta = corridor.snap_edge_along_station(
            image,
            transform(),
            forward_yds=100.0,
            edge_lateral_yds=-12.0,
            center_lateral_yds=0.0,
            radius_px=12,
            min_lab_delta=4.0,
        )
        self.assertTrue(meta["accepted"])
        self.assertLess(abs(snapped - (-15.0)), 3.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
