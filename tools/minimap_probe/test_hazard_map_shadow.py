from __future__ import annotations

import unittest

import hazard_geometry_contract as hg
import hazard_map_shadow as hm


class HazardMapShadowTests(unittest.TestCase):
    def _vlm(self, object_id: str = "bunker_1"):
        return hg.make_geometry(
            hazard_class="bunker",
            source_kind="vlm",
            source_name="OpenAI gpt-5.6-luna",
            source_object_id=object_id,
            representations=[hg.representation(
                geometry_type="bbox",
                coordinate_space="minimap_normalized",
                bbox=[0.2, 0.2, 0.4, 0.4],
                coordinate_authority="semantic-localization-only",
            )],
            semantic_confidence=0.98,
        )

    def _sam(self, object_id: str = "bunker_1"):
        return hg.make_geometry(
            hazard_class="bunker",
            source_kind="sam2",
            source_name="SAM2 prompted by Luna",
            source_object_id=object_id,
            representations=[hg.representation(
                geometry_type="polygon",
                coordinate_space="minimap_normalized",
                points=[[0.22, 0.22], [0.38, 0.22], [0.36, 0.37], [0.23, 0.36]],
                coordinate_authority="prompt-segmenter",
            )],
            semantic_confidence=0.98,
            geometry_confidence=0.91,
            validation_state="segmentation-accepted-unvalidated",
        )

    def _legacy_whole(self):
        return hg.make_geometry(
            hazard_class="bunker",
            source_kind="legacy_bunker_cv",
            source_name="whole image bunker baseline",
            source_object_id="77",
            representations=[hg.representation(
                geometry_type="polygon",
                coordinate_space="minimap_pixel",
                points=[[10, 10], [20, 10], [20, 20], [10, 20]],
                coordinate_authority="legacy-baseline",
            )],
            validation_state="legacy-baseline-unvalidated",
        )

    def _red(self):
        return hg.make_geometry(
            hazard_class="penalty_area",
            source_kind="red_penalty_cv",
            source_name="GSPro red penalty boundary CV",
            source_object_id="1",
            representations=[hg.representation(
                geometry_type="polyline",
                coordinate_space="hole_local_yards",
                points=[[35, -5], [40, 0], [45, 4]],
                coordinate_authority="deterministic-red-boundary-cv",
            )],
            validation_state="red-cv-shadow-unvalidated",
        )

    def test_sam_becomes_primary_for_semantic_chain(self):
        payload = hm.build_shadow_map([self._vlm(), self._sam()])
        self.assertEqual(payload["canonical_hazard_count"], 1)
        self.assertEqual(payload["hazards"][0]["primary"]["source"]["kind"], "sam2")
        self.assertFalse(payload["strategy_authority"])
        self.assertEqual(payload["promotion_decision"], "none")

    def test_whole_image_legacy_cannot_create_primary(self):
        payload = hm.build_shadow_map([self._legacy_whole()])
        self.assertEqual(payload["canonical_hazard_count"], 0)
        self.assertEqual(payload["legacy_baseline"]["object_count"], 1)

    def test_red_penalty_is_primary_penalty_geometry(self):
        payload = hm.build_shadow_map([self._red()])
        self.assertEqual(payload["canonical_hazard_count"], 1)
        hazard = payload["hazards"][0]
        self.assertEqual(hazard["hazard_class"], "penalty_area")
        self.assertEqual(hazard["primary"]["source"]["kind"], "red_penalty_cv")


if __name__ == "__main__":
    unittest.main()
