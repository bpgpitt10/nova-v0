#!/usr/bin/env python3
from __future__ import annotations
import unittest
import numpy as np
import cv2

import hazard_vlm_contract as contract
import hazard_vlm_refine as refine


class HazardVlmContractTests(unittest.TestCase):
    def test_parse_and_pixels(self):
        payload = {
            "schema_version": contract.SCHEMA_VERSION,
            "bunkers": [{"id":"b1","confidence":0.9,"bbox_norm":[0.1,0.2,0.3,0.4]}],
            "water": [],
            "uncertain": [],
        }
        hazards = contract.parse_response(payload)
        self.assertEqual(len(hazards), 1)
        self.assertEqual(hazards[0].hazard_class, "bunker")
        self.assertEqual(contract.bbox_px(hazards[0], 1000, 500), (100,100,300,200))

    def test_reject_giant_box(self):
        payload = {
            "schema_version": contract.SCHEMA_VERSION,
            "bunkers": [{"id":"b1","confidence":0.9,"bbox_norm":[0,0,0.9,0.9]}],
            "water": [],
            "uncertain": [],
        }
        with self.assertRaises(ValueError):
            contract.parse_response(payload)

    def test_bunker_refinement_stays_local(self):
        image = np.zeros((200,200,3), dtype=np.uint8)
        image[:] = (55,105,62)
        cv2.ellipse(image, (100,100), (22,14), 0, 0, 360, (185,205,220), -1)
        hazard = contract.VlmHazard("b1","bunker",0.95,(0.35,0.35,0.65,0.65))
        out = refine.refine_hazard(image, hazard)
        self.assertIn(out.refinement_status, {"pixel-mask-refined","vlm-box-only"})
        self.assertFalse(out.strategy_authority)
        self.assertGreaterEqual(len(out.polygon_px), 4)

    def test_uncertain_never_pixel_classified(self):
        image = np.zeros((100,100,3), dtype=np.uint8)
        hazard = contract.VlmHazard("u1","uncertain",0.5,(0.1,0.1,0.2,0.2))
        out = refine.refine_hazard(image, hazard)
        self.assertEqual(out.refinement_status, "uncertain-box-only")
        self.assertFalse(out.strategy_authority)


if __name__ == "__main__":
    unittest.main()
