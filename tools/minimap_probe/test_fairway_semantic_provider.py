from __future__ import annotations

import unittest
from unittest import mock

import fairway_semantic_provider as sp


class FairwaySemanticProviderTests(unittest.TestCase):
    def test_normalize_present_fairway(self):
        result = sp._normalize({
            "present": True,
            "confidence": 0.91,
            "box_2d": [100, 200, 850, 780],
            "note": "current hole",
        })
        self.assertTrue(result["present"])
        self.assertEqual(result["box_2d"], [100, 200, 850, 780])
        self.assertEqual(result["note"], "current hole")

    def test_normalize_no_fairway_keeps_existing_contract(self):
        result = sp._normalize({
            "present": False,
            "confidence": 0.95,
            "box_2d": [0, 0, 0, 0],
            "note": "",
        })
        self.assertFalse(result["present"])
        self.assertIsNone(result["box_2d"])
        self.assertIsNone(result["note"])

    def test_chain_uses_luna_without_touching_gemini_when_luna_succeeds(self):
        luna_result = {"present": True, "confidence": 0.8, "box_2d": [1, 2, 3, 4], "note": None}
        luna_meta = {"provider": "openai-luna", "model": sp.DEFAULT_LUNA_MODEL, "latency_seconds": 0.2}
        with mock.patch.object(sp, "call_provider", return_value=(luna_result, luna_meta)) as call:
            result, meta = sp.call_chain("fake.png")
        self.assertEqual(result, luna_result)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.kwargs["provider"], "luna")
        self.assertFalse(meta["fallback_used"])
        self.assertEqual(meta["provider"], "openai-luna")
        self.assertEqual(meta["provider_attempts"][0]["status"], "complete")

    def test_chain_falls_back_to_gemini_after_luna_failure(self):
        gemini_result = {"present": True, "confidence": 0.7, "box_2d": [10, 20, 30, 40], "note": None}
        gemini_meta = {"provider": "google-gemini", "model": sp.DEFAULT_GEMINI_MODEL, "latency_seconds": 0.3}
        with mock.patch.object(
            sp,
            "call_provider",
            side_effect=[RuntimeError("Luna busy"), (gemini_result, gemini_meta)],
        ) as call:
            result, meta = sp.call_chain("fake.png")
        self.assertEqual(result, gemini_result)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(call.call_args_list[0].kwargs["provider"], "luna")
        self.assertEqual(call.call_args_list[1].kwargs["provider"], "gemini")
        self.assertTrue(meta["fallback_used"])
        self.assertIn("Luna busy", meta["fallback_reason"])
        self.assertEqual(meta["provider_attempts"][0]["status"], "error")
        self.assertEqual(meta["provider_attempts"][1]["status"], "complete")
        self.assertEqual(meta["provider"], "google-gemini")

    def test_chain_raises_when_both_providers_fail(self):
        with mock.patch.object(
            sp,
            "call_provider",
            side_effect=[RuntimeError("Luna busy"), RuntimeError("Gemini busy")],
        ):
            with self.assertRaisesRegex(RuntimeError, "All fairway semantic providers failed"):
                sp.call_chain("fake.png")


if __name__ == "__main__":
    unittest.main()
