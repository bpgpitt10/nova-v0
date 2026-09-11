import json
import unittest
from unittest import mock

import hazard_vlm_contract
import hazard_vlm_openai
import hazard_vlm_provider


class OpenAIHazardAdapterTests(unittest.TestCase):
    def test_strict_schema_requires_nullable_note(self):
        schema = hazard_vlm_openai._strict_schema()
        item = schema["properties"]["bunkers"]["items"]
        self.assertIn("note", item["required"])
        self.assertEqual(item["properties"]["note"]["type"], ["string", "null"])

    def test_extracts_responses_api_output_text(self):
        payload = {
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "{\"ok\":true}"}],
            }]
        }
        self.assertEqual(hazard_vlm_openai._extract_output_text(payload), '{"ok":true}')

    def test_parse_contract_validates_provider_neutral_shape(self):
        contract = {
            "schema_version": hazard_vlm_contract.SCHEMA_VERSION,
            "bunkers": [{
                "id": "b1",
                "confidence": 0.9,
                "bbox_norm": [0.1, 0.2, 0.3, 0.4],
                "note": None,
            }],
            "water": [],
            "uncertain": [],
        }
        payload = {"output_text": json.dumps(contract)}
        parsed = hazard_vlm_openai._parse_contract(payload)
        self.assertEqual(parsed["bunkers"][0]["id"], "b1")

    @mock.patch("hazard_vlm_openai.call_openai_boxes")
    def test_provider_router_uses_luna_contract(self, call_openai):
        contract = {
            "schema_version": hazard_vlm_contract.SCHEMA_VERSION,
            "bunkers": [], "water": [], "uncertain": [],
        }
        call_openai.return_value = (contract, {"provider": "openai"}, {"id": "r1"})
        result, meta, raw = hazard_vlm_provider.call_provider(
            image_path="tee.png", provider="openai"
        )
        self.assertEqual(result, contract)
        self.assertEqual(meta["provider"], "openai")
        call_openai.assert_called_once()

    @mock.patch("hazard_vlm_provider.call_provider")
    def test_chain_falls_back_after_primary_error(self, call_provider):
        contract = {
            "schema_version": hazard_vlm_contract.SCHEMA_VERSION,
            "bunkers": [], "water": [], "uncertain": [],
        }
        call_provider.side_effect = [
            RuntimeError("primary unavailable"),
            (contract, {"provider": "google-gemini", "model": "gemini-x"}, {}),
        ]
        result, meta, raw, attempts = hazard_vlm_provider.call_chain(
            image_path="tee.png",
            providers=[("openai", "gpt-5.6-luna"), ("gemini", "gemini-x")],
        )
        self.assertEqual(result, contract)
        self.assertEqual(meta["provider"], "google-gemini")
        self.assertEqual([row["status"] for row in attempts], ["error", "complete"])


if __name__ == "__main__":
    unittest.main()
