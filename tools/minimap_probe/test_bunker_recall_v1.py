#!/usr/bin/env python3
import unittest

import numpy as np

import bunker_recall_v1 as br


class BunkerRecallV1Tests(unittest.TestCase):
    def test_parse_contract_is_recall_box_only(self):
        rows = br.parse_contract({
            "schema_version": br.SCHEMA_VERSION,
            "bunkers": [
                {"id": "b1", "confidence": 0.72, "bbox_norm": [0.1, 0.2, 0.2, 0.3], "note": None},
                {"id": "b2", "confidence": 0.51, "bbox_norm": [0.6, 0.5, 0.7, 0.6], "note": "small candidate"},
            ],
        })
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(x.hazard_class == "bunker" for x in rows))

    def test_parse_contract_rejects_implausibly_large_box(self):
        with self.assertRaises(ValueError):
            br.parse_contract({
                "schema_version": br.SCHEMA_VERSION,
                "bunkers": [
                    {"id": "b1", "confidence": 0.8, "bbox_norm": [0.0, 0.0, 0.8, 0.8], "note": None},
                ],
            })

    def test_semantic_support_measures_candidate_inside_box(self):
        mask = np.zeros((20, 20), dtype=bool)
        mask[5:10, 5:10] = True
        box = np.zeros((20, 20), dtype=bool)
        box[4:11, 4:11] = True
        self.assertAlmostEqual(br._semantic_support(mask, [box]), 1.0)

    def test_dedupe_prefers_recall_sam2_over_legacy(self):
        a = np.zeros((30, 30), dtype=bool)
        a[5:15, 5:15] = True
        b = np.zeros((30, 30), dtype=bool)
        b[6:16, 6:16] = True
        rows = br.dedupe([
            {
                "source": "legacy_cv",
                "geometry_confidence": 0.9,
                "semantic_confidence": 0.9,
                "polygon_pixel": [[5,5],[14,5],[14,14],[5,14]],
                "_mask": a,
            },
            {
                "source": "recall_sam2",
                "geometry_confidence": 0.7,
                "semantic_confidence": 0.7,
                "polygon_pixel": [[6,6],[15,6],[15,15],[6,15]],
                "_mask": b,
            },
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source"], "recall_sam2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
