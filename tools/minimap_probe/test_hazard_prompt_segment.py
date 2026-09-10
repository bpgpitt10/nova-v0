import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import hazard_gemini_sam2_benchmark as bench
import hazard_prompt_segment as seg
import hazard_vlm_contract
import hazard_vlm_gemini_boxes


class FakeBackend:
    name = "fake-segmenter"
    model_id = "fake-v0"
    device = "cpu"

    def __init__(self, masks):
        self.masks = masks

    def predict(self, image_rgb, boxes_xyxy):
        return [[seg.RawMaskPrediction(mask=m.copy(), model_score=0.93)] for m in group] for group in self.masks]


def hazard(box=(0.2, 0.2, 0.5, 0.5), cls="bunker"):
    return hazard_vlm_contract.VlmHazard("h1", cls, 0.98, box)


class PromptSegmentTests(unittest.TestCase):
    def test_gemini_box_conversion_has_no_polygon_requirement(self):
        native = {"bunkers": [{"id": "b1", "confidence": 0.9, "box_2d": [100, 200, 300, 400]}], "water": [], "uncertain": []}
        contract = hazard_vlm_gemini_boxes.native_to_contract(native)
        parsed = hazard_vlm_contract.parse_response(contract)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].bbox_norm, (0.2, 0.1, 0.4, 0.3))
        self.assertNotIn("mask", contract["bunkers"][0])

    def test_box_padding_stays_in_image(self):
        h = hazard((0.0, 0.0, 0.1, 0.1))
        self.assertEqual(seg.bbox_px(h, 100, 100, 0.2)[:2], (0, 0))

    def test_noise_component_outside_box_is_removed(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[20:45, 20:45] = 1
        mask[70:95, 70:95] = 1
        component = seg._largest_relevant_component(mask, (15, 15, 50, 50))
        self.assertTrue(component[30, 30])
        self.assertFalse(component[80, 80])

    def test_fake_backend_produces_accepted_polygon(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        mask = np.zeros((100, 100), dtype=np.uint8)
        cv2.ellipse(mask, (35, 35), (12, 8), 0, 0, 360, 1, -1)
        result = seg.segment_hazards(image, [hazard()], FakeBackend([[mask]]), pad_fraction=0.0)
        self.assertEqual(result["accepted_count"], 1)
        row = result["objects"][0]
        self.assertEqual(row["segmentation_status"], "accepted")
        self.assertGreaterEqual(len(row["polygon_px"]), 3)
        self.assertFalse(row["strategy_authority"])

    def test_giant_mask_is_rejected(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        mask = np.ones((100, 100), dtype=np.uint8)
        result = seg.segment_hazards(image, [hazard()], FakeBackend([[mask]]), pad_fraction=0.0)
        row = result["objects"][0]
        self.assertEqual(row["segmentation_status"], "rejected")
        self.assertIn("implausibly-large-image-fraction", row["segmentation_reject_reasons"])

    def test_best_of_multiple_masks_prefers_box_fit(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        bad = np.zeros((100, 100), dtype=np.uint8); bad[0:4, 0:4] = 1
        good = np.zeros((100, 100), dtype=np.uint8); good[24:47, 24:47] = 1
        backend = FakeBackend([[bad, good]])
        result = seg.segment_hazards(image, [hazard()], backend, pad_fraction=0.0)
        self.assertEqual(result["objects"][0]["chosen_candidate_index"], 1)

    def test_heatmap_only_is_refused_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            cv2.imwrite(str(p / "tee_heatmap_minimap.png"), np.zeros((10, 10, 3), np.uint8))
            with self.assertRaises(RuntimeError):
                bench.resolve_image(p, allow_heatmap=False)
            selected, policy = bench.resolve_image(p, allow_heatmap=True)
            self.assertEqual(selected.name, "tee_heatmap_minimap.png")
            self.assertIn("explicitly-allowed", policy)

    def test_hazard_safe_image_beats_heatmap(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            image = np.zeros((10, 10, 3), np.uint8)
            cv2.imwrite(str(p / "tee_heatmap_minimap.png"), image)
            cv2.imwrite(str(p / "tee_hazard_safe_minimap.png"), image)
            selected, policy = bench.resolve_image(p)
            self.assertEqual(selected.name, "tee_hazard_safe_minimap.png")
            self.assertEqual(policy, "hazard-safe-preferred")

    def test_sam_vs_legacy_iou_math(self):
        a = np.zeros((10, 10), bool); a[2:6, 2:6] = True
        b = np.zeros((10, 10), bool); b[4:8, 4:8] = True
        self.assertAlmostEqual(bench.iou(a, b), 4 / 28)


if __name__ == "__main__":
    unittest.main()
